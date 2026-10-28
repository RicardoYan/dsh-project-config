/**
 * dsh-project-config — per-workspace subagents, commands, MCP servers and hooks
 * from `<workspace>/.dsh/settings.yml`, merged with the personal
 * `.dsh/settings.local.yml` when present (see project-settings.ts).
 *
 * Everything a workspace configures is loaded and run as soon as a session
 * starts there; nothing asks first.
 *
 * DSH interfaces relied on (@deepseek-ai/dsh 0.2.x):
 * - `agent/created` (serial, scoped carrier) / `agent/disposed` / `agent/pre-step`
 * - `session/disposed`: a deleted session leaves the store but its agent stays
 *   live until DSH exits (no `agent/disposed`), so it is released on this event
 * - everything is mounted on `agent.ctx`, which the plugin fiber does not own:
 *   the plugin releases every mount itself when it is unloaded
 * - session header fields `cwd`, `origin: 'subagent'`, `parentSession`, `delegationDepth`
 * - `ctx.agents.get/list`, `agent.ctx` scoped context
 * - `ctx.commands.register` for `/project-config [reconnect [<server>]]`
 * - see features/* and isolation.ts for the rest
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createLog, type Log } from './log.js'
import { findRoot, checkTarget } from './workspace.js'
import { splitPersona, type McpSpec } from './settings.js'
import { loadProjectSettings, type LoadResult } from './project-settings.js'
import { patchSkillRoots, installInstructionsMarker } from './isolation.js'
import { admits, applyChildRole, delegationStore, mountSubagentTools } from './features/subagents.js'
import { McpHub, resolveServerConfig } from './features/mcp.js'
import { mountHooks, runLifecycleHook } from './features/hooks.js'
import { mountCommands } from './features/commands.js'
import { mcpStateText, statusText } from './status.js'
import { TEXT } from './text.js'
import type { Text } from './locale.js'
import { preferenceFromLoader, setLocaleSource } from './locale.js'
import type { ChildMount, FeatureKind, FeatureMount, LoadedSpec, Mount, ReloadPart, RootMount, TaggedFeature, Unsubscribe } from './mounts.guards.js'

export const name = 'dsh-project-config'
const PERSONA_MAX = 1024 * 1024

/** Resolves `undefined` when `promise` has not settled after `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Dispose one fiber; the returned promise settles when it is gone (never rejects). */
function disposeFiber(fiber: FeatureMount, log: Log): Promise<void> {
  if (fiber === undefined || fiber === null) return Promise.resolve()
  return Promise.resolve()
    .then(() => fiber.dispose())
    .then(() => undefined)
    .catch((error: unknown) => log.warn(`dispose failed: ${errMessage(error)}`))
}

function errMessage(error: unknown): string {
  return String((error as { message?: unknown } | undefined)?.message ?? error)
}

/** What this plugin reads off an agent; the real object is wider. */
interface AgentLike {
  readonly id: string
  readonly ctx: Context
  readonly session: {
    readonly header: {
      readonly cwd?: string | undefined
      readonly origin?: 'subagent' | undefined
      readonly parentSession?: string | undefined
      readonly delegationDepth?: number | undefined
    }
    snapshotEvents?(): Iterable<{ type?: string; data?: { persona?: unknown } }>
  }
}

/** One `subagent/descriptor` event's payload, as read for the persona. */
interface DescriptorEventData {
  persona?: unknown
}

function descriptorPersona(agent: AgentLike): string | undefined {
  try {
    for (const event of agent.session.snapshotEvents?.() ?? []) {
      if (event.type === 'subagent/descriptor' && typeof (event.data as DescriptorEventData | undefined)?.persona === 'string') {
        return (event.data as DescriptorEventData).persona as string
      }
    }
  } catch {
    /* older session shape */
  }
  return undefined
}

/** The placeholder laid down before the first await; also satisfies `RootMount`'s optional fields. */
interface Claim {
  agent: AgentLike
  pending: boolean
  fibers: Array<FeatureMount>
  released: boolean
}

/** The `system-prompt/assemble` waterfall's arguments. */
interface AssemblyContext {
  agent?: AgentLike
  signal?: AbortSignal
}

/** The `agent/pre-step` payload. */
interface PreStepEvent {
  agent: AgentLike
  signal?: AbortSignal
}

/** The `agent/created` payload. */
interface AgentCreatedEvent {
  agent: AgentLike
  source: string
}

export function apply(ctx: Context): void {
  setLocaleSource(() => preferenceFromLoader(ctx.get('loader') as never))
  ctx.effect(() => () => setLocaleSource(undefined), 'project-config: locale')
  const log = createLog(undefined, ctx.logger)
  // agent -> RootMount | ChildMount (or the claim slot while the mount is built)
  const mounts = new WeakMap<AgentLike, Mount | Claim>()
  const roots = new Set<RootMount>()
  // child session id -> project subagent toolName
  const childTools = new Map<string, string>()
  let active = true

  // Everything below is mounted on each session's own `agent.ctx`, which this
  // plugin's fiber does not own: unloading or reloading the plugin must release
  // it here, or MCP children, tools and listeners outlive the plugin.
  ctx.effect(
    () => async () => {
      active = false
      const pending: Array<Promise<unknown>> = []
      let count = 0
      for (const m of [...roots]) {
        count += 1
        for (const child of [...m.children]) pending.push(releaseChild(child))
        pending.push(releaseRoot(m))
      }
      await Promise.all(pending)
      if (count > 0) log.info(`plugin unloaded: released ${count} session${count === 1 ? '' : 's'}`)
    },
    'project-config: session mounts',
  )

  ctx.effect(() => patchSkillRoots(log), 'project-config: skill roots')
  installInstructionsMarker(ctx, log)

  async function loadSpecs(
    m: RootMount,
    entries: ReadonlyArray<import('./settings.js').SubagentSpec>,
  ): Promise<LoadedSpec[]> {
    const ok: LoadedSpec[] = []
    for (const entry of entries) {
      const checked = await checkTarget(m.root, entry.personaFile, { type: 'file', maxBytes: PERSONA_MAX })
      if (!checked.ok) {
        m.warnings.push(TEXT.subagentProblem(entry.toolName, checked.message) as Text)
        continue
      }
      try {
        const { body, description } = splitPersona(await fs.promises.readFile(checked.realPath, 'utf8'))
        ok.push({ entry, persona: body, description: entry.description ?? description })
      } catch (error) {
        m.warnings.push(TEXT.subagentProblem(entry.toolName, errMessage(error)) as Text)
      }
    }
    return ok
  }

  const isProjectNameFor = (m: RootMount): ((n: string) => boolean) => (n) =>
    m.subagentNames.has(n) || n.startsWith('mcp__')

  // ------------------------------------------------------------ root sessions
  /**
   * Read one session's settings and mount its subagent tools.
   * @param agent - the session's agent.
   * @param claim - the placeholder already holding this agent's `mounts` slot.
   *   Its `fibers` array is adopted so a release that lands during the awaits
   *   disposes exactly the fibers this function creates.
   */
  async function createRootMount(agent: AgentLike, claim: Claim): Promise<RootMount | undefined> {
    const cwd = agent.session.header.cwd
    if (typeof cwd !== 'string') return undefined
    const root = await findRoot(cwd)
    const loaded = await loadProjectSettings(root)
    if (loaded === undefined) return undefined
    const label = `[${path.basename(root)}:${agent.id.slice(-8)}]`
    const m: RootMount = {
      agent,
      root,
      label,
      file: loaded.file,
      localFile: loaded.localFile,
      ok: loaded.ok,
      error: loaded.error,
      warnings: [...(loaded.warnings ?? [])],
      settings: loaded.settings,
      origin: loaded.origin,
      hooksLocal: loaded.hooksLocal,
      removed: loaded.removed,
      subagentSpecs: [],
      subagentNames: new Set(),
      subagentFiber: undefined,
      children: new Set(),
      fibers: claim.fibers,
      features: [],
      listeners: [],
      hub: undefined,
      featuresMounted: false,
      prepared: false,
      stats: { runs: 0, failures: 0 },
    }
    // Released while the settings were read: do not mount over a released slot.
    if (claim.released) return m
    if (!m.ok) {
      log.warn(`${label}: ${m.error}`)
      return m
    }
    m.subagentNames = new Set(m.settings.subagents.map((s) => s.toolName))
    const ok = await loadSpecs(m, m.settings.subagents)
    if (claim.released) return m
    m.subagentSpecs = ok
    const subagentFiber = mountSubagentTools(agent.ctx, ok, {
      log,
      label,
      isProjectName: isProjectNameFor(m),
      sectionName: 'project-config:subagents',
    })
    m.subagentFiber = subagentFiber
    if (subagentFiber !== undefined) m.fibers.push(subagentFiber)
    for (const w of m.warnings) log.warn(`${label}: ${w}`)
    log.info(
      `${label}: loaded ${loaded.file}${loaded.localFile ? ` + ${path.basename(loaded.localFile)}` : ''} (subagents ${ok.length}, commands ${m.settings.commands.length}, mcp ${m.settings.mcp.length}, hook events ${Object.keys(m.settings.hooks).length})`,
    )
    return m
  }

  function hookOpts(m: RootMount) {
    return { hooks: m.settings.hooks, root: m.root, log, label: m.label, stats: m.stats }
  }

  function mountFeatures(m: RootMount): Promise<void> {
    if (!active || m.released === true || !m.ok) return Promise.resolve()
    if (m.featuresMounted) return Promise.resolve()
    m.featuresMounted = true
    return doMountFeatures(m).catch((error: unknown) =>
      log.error(`${m.label}: mount failed: ${(error as { stack?: unknown } | undefined)?.stack ?? error}`),
    )
  }

  /** Record one section's fiber so `reload <part>` can replace exactly that one. */
  function addFeature(m: RootMount, kind: FeatureKind, fiber: FeatureMount): void {
    m.features.push({ kind, fiber })
  }

  async function doMountFeatures(m: RootMount): Promise<void> {
    await mountCommandsFeature(m)
    mountMcpFeature(m)
    mountHooksFeature(m)
    for (const w of m.warnings) log.warn(`${m.label}: ${w}`)
    for (const child of m.children) mountChildFeatures(child)
    log.info(`${m.label}: features mounted`)
  }

  async function mountCommandsFeature(m: RootMount): Promise<void> {
    const agentCtx = (m.agent as { ctx: Context }).ctx
    const cmdSpecs: Array<{ entry: import('./settings.js').CommandSpec; realPath: string }> = []
    for (const entry of m.settings.commands) {
      const checked = await checkTarget(m.root, entry.handlerFile, { type: 'file' })
      if (checked.ok) cmdSpecs.push({ entry, realPath: checked.realPath })
      else m.warnings.push(TEXT.commandProblem(entry.name, checked.message) as Text)
    }
    addFeature(m, 'commands', mountCommands(agentCtx, cmdSpecs, { root: m.root, log, label: m.label }))
  }

  function mountMcpFeature(m: RootMount): void {
    if (m.settings.mcp.length === 0) return
    const agentCtx = (m.agent as { ctx: Context }).ctx
    const hub = new McpHub(log, m.label)
    m.hub = hub
    addFeature(
      m,
      'mcp',
      hub.start(agentCtx, m.settings.mcp, (entry: McpSpec) => resolveServerConfig(entry, m.root, checkTarget)),
    )
  }

  function mountHooksFeature(m: RootMount): void {
    addFeature(m, 'hooks', mountHooks((m.agent as { ctx: Context }).ctx, hookOpts(m)))
  }

  /** Dispose the tag's fibers; `kind` selects one section, `undefined` all of them. */
  function disposeFeatures(m: RootMount, kind?: FeatureKind): Promise<unknown> {
    const taken: Array<TaggedFeature> = []
    for (let i = m.features.length - 1; i >= 0; i -= 1) {
      const entry = m.features[i] as TaggedFeature
      if (kind !== undefined && entry.kind !== kind) continue
      taken.push(...m.features.splice(i, 1))
    }
    return Promise.all(taken.map((f) => disposeFiber(f.fiber, log)))
  }

  async function unmountFeatures(m: RootMount): Promise<unknown> {
    if (!m.featuresMounted) return Promise.resolve()
    m.featuresMounted = false
    const pending: Array<Promise<unknown>> = [disposeFeatures(m)]
    m.hub = undefined
    for (const child of m.children) pending.push(unmountChildFeatures(child))
    log.info(`${m.label}: features removed`)
    return Promise.all(pending)
  }

  /**
   * Take out one section so it can be mounted again: waits for the fibers to be
   * gone (the registry throws on a name that is still registered) and drops the
   * servers that section started.
   * @param kinds - which sections to remove.
   */
  async function unmountSections(m: RootMount, ...kinds: FeatureKind[]): Promise<void> {
    for (const kind of kinds) {
      await disposeFeatures(m, kind)
      if (kind === 'mcp') m.hub = undefined
      for (const child of m.children) await unmountChildFeatures(child, kind)
    }
  }

  // ------------------------------------------------------------ child sessions
  function resolveChildTool(agent: AgentLike, rootMount: RootMount): string | undefined {
    // AsyncLocalStorage carries the delegating tool's identity down the
    // creation chain; only a matching parent makes it authoritative.
    const store = delegationStore.getStore() as
      | { parentId?: string | undefined; toolName?: string | undefined }
      | undefined
    const parentId = agent.session.header.parentSession
    if (
      store !== undefined &&
      store.parentId === parentId &&
      typeof store.toolName === 'string' &&
      rootMount.subagentNames.has(store.toolName)
    ) {
      return store.toolName
    }
    const known = childTools.get(agent.id)
    if (known !== undefined) return known
    const persona = descriptorPersona(agent)
    if (persona !== undefined) {
      const spec = rootMount.subagentSpecs.find((s) => s.persona === persona)
      if (spec !== undefined) return spec.entry.toolName
    }
    return undefined
  }

  function childSpecsFor(rootMount: RootMount, child: ChildMount) {
    const depth = child.agent && (child.agent as AgentLike).session.header.delegationDepth !== undefined
      ? ((child.agent as AgentLike).session.header.delegationDepth as number)
      : 0
    const all = rootMount.subagentSpecs
    return all
      .filter((s) => admits(child.filter, s.entry.toolName) && depth + 1 <= s.entry.maxDepth)
      .map((s) => ({ entry: s.entry, persona: s.persona, description: s.description }))
  }

  function createChildMount(agent: AgentLike): ChildMount | undefined {
    const header = agent.session.header
    if (header.origin !== 'subagent' || typeof header.parentSession !== 'string') return undefined
    const parent = (ctx.get('agents') as { get(id: string): AgentLike | undefined } | undefined)?.get(
      header.parentSession,
    )
    const pm = parent === undefined ? undefined : mounts.get(parent)
    if (pm === undefined) return undefined
    const withRoot = pm as { rootMount?: RootMount }
    const rootMount = withRoot.rootMount ?? (pm as RootMount)
    if (!rootMount.ok || !roots.has(rootMount)) return undefined
    const toolName = resolveChildTool(agent, rootMount)
    if (toolName !== undefined) childTools.set(agent.id, toolName)
    const entry =
      toolName === undefined ? undefined : rootMount.settings.subagents.find((s) => s.toolName === toolName)
    const child: ChildMount = {
      agent,
      rootMount,
      toolName,
      filter: entry?.toolFilter,
      fibers: [],
      features: [],
      subagents: [],
    }
    child.subagents = childSpecsFor(rootMount, child)
    child.fibers.push(
      mountSubagentTools(agent.ctx, child.subagents, {
        log,
        label: `${rootMount.label}/${toolName ?? 'subagent'}`,
        isProjectName: isProjectNameFor(rootMount),
        sectionName: 'project-config:subagents',
      }),
    )
    // The child's role: a persona section on its own scope, plus its toolFilter.
    // Applied here rather than through a preset so the child keeps everything it
    // inherits from the delegating parent (tools, MCP).
    const spec =
      toolName === undefined
        ? undefined
        : rootMount.subagentSpecs.find(
            (s) => s.entry.toolName === toolName,
          )
    if (spec !== undefined) {
      child.fibers.push(
        applyChildRole(
          agent.ctx,
          { persona: spec.persona, filter: entry?.toolFilter },
          { log, label: `${rootMount.label}/${toolName}`, isProjectName: isProjectNameFor(rootMount) },
        ),
      )
    }
    rootMount.children.add(child)
    if (rootMount.featuresMounted) mountChildFeatures(child)
    return child
  }

  /**
   * Mount a child's feature sections; `kind` limits it to one, `undefined` mounts
   * every section that is not there yet (so calling it again is how a section is
   * put back after `reload mcp` / `reload hooks`).
   */
  function mountChildFeatures(child: ChildMount, kind?: FeatureKind): void {
    const m = child.rootMount
    const mounted = (k: FeatureKind): boolean => child.features.some((f) => f.kind === k)
    if ((kind === undefined || kind === 'mcp') && m.hub !== undefined && !mounted('mcp')) {
      child.features.push({ kind: 'mcp', fiber: m.hub.mirror((child.agent as AgentLike).ctx, child.filter) })
    }
    if ((kind === undefined || kind === 'hooks') && !mounted('hooks')) {
      child.features.push({ kind: 'hooks', fiber: mountHooks((child.agent as AgentLike).ctx, hookOpts(m)) })
    }
    child.featuresMounted = true
  }

  /** Remove a child's features; `kind` selects one section, `undefined` all of them. */
  function unmountChildFeatures(child: ChildMount, kind?: FeatureKind): Promise<unknown> {
    const taken: Array<TaggedFeature> = []
    for (let i = child.features.length - 1; i >= 0; i -= 1) {
      const entry = child.features[i] as TaggedFeature
      if (kind !== undefined && entry.kind !== kind) continue
      taken.push(...child.features.splice(i, 1))
    }
    if (kind === undefined) child.featuresMounted = false
    return Promise.all(taken.map((f) => disposeFiber(f.fiber, log)))
  }

  // ------------------------------------------------------------ release
  // One path for every way a session goes away for this plugin: agent disposed,
  // session removed from the store (deleted), plugin unloaded. Idempotent.
  function releaseChild(child: ChildMount): Promise<unknown> {
    if (child.released === true) return Promise.resolve()
    child.released = true
    if (mounts.get(child.agent as AgentLike) === child) mounts.delete(child.agent as AgentLike)
    child.rootMount.children.delete(child)
    const pending: Array<Promise<unknown>> = [unmountChildFeatures(child)]
    for (const f of child.fibers.splice(0)) pending.push(disposeFiber(f, log))
    return Promise.all(pending)
  }

  function releaseRoot(m: RootMount): Promise<unknown> {
    if (m.released === true) return Promise.resolve()
    m.released = true
    if (mounts.get(m.agent as AgentLike) === m) mounts.delete(m.agent as AgentLike)
    roots.delete(m)
    // A claim released before its mount existed has no features, no listeners
    // and no hub; `fibers` is shared with the mount being built, so whatever it
    // already pushed is disposed here.
    const pending: Array<Promise<unknown>> = [unmountFeatures(m)]
    // `fibers` also holds `subagentFiber`: the subagent tools go away with the mount.
    const fibers = m.fibers.splice(0)
    m.subagentFiber = undefined
    for (const f of fibers) pending.push(disposeFiber(f, log))
    for (const off of (m.listeners ?? []).splice(0)) {
      try {
        off()
      } catch {
        /* gone */
      }
    }
    return Promise.all(pending)
  }

  function release(m: Mount): Promise<unknown> {
    const withRoot = m as { rootMount?: RootMount }
    return withRoot.rootMount !== undefined ? releaseChild(m as ChildMount) : releaseRoot(m as RootMount)
  }

  // ------------------------------------------------------------ lifecycle
  // A session removed from the store (session deleted) keeps its agent until DSH
  // exits; such an agent is no longer a session for this plugin.
  function isLive(agent: AgentLike): boolean {
    const sessions = ctx.get('sessions') as
      | { get(id: string): { readonly header?: unknown } | undefined }
      | undefined
    return sessions === undefined || sessions.get(agent.id) === agent.session
  }

  /**
   * Read a session's settings and mount both stages on it.
   *
   * The claim is taken BEFORE the first await: `agent/created` reaches
   * `onCreated` once per emission, and a plugin reload also re-runs it for every
   * live agent; two runs used to pass the `mounts.has` check, both read the
   * settings, and both mount the same tools — the second `tools.register` then
   * throws `tool "<name>" is already registered in this scope`, which DSH treats
   * as a fatal load failure (the whole host exits). The slot holds nothing yet,
   * so the failure paths below clear it again.
   * @param agent - the root session's agent; its `mounts` slot must be free.
   * @returns the new mount, or `undefined` when there is nothing to mount.
   */
  async function attachRoot(agent: AgentLike): Promise<RootMount | undefined> {
    const claim: Claim = { agent, pending: true, fibers: [], released: false }
    mounts.set(agent, claim)
    const m = await createRootMount(agent, claim)
    if (m === undefined) {
      mounts.delete(agent)
      return undefined
    }
    claim.pending = false
    mounts.set(agent, m)
    roots.add(m)
    // Gone while the settings were read: plugin unloaded, agent disposed or session removed.
    const agents = ctx.get('agents') as { get(id: string): AgentLike | undefined } | undefined
    if (!active || !isLive(agent) || agents?.get(agent.id) !== agent) {
      await releaseRoot(m)
      return undefined
    }
    if (m.ok) installFirstAssembly(m)
    await mountFeatures(m)
    return m.released === true ? undefined : m
  }

  async function onCreated(agent: AgentLike, source: string): Promise<void> {
    if (!active || mounts.has(agent) || !isLive(agent)) return
    const header = agent.session.header
    if (header === undefined) return
    if (header.origin === 'subagent') {
      const child = createChildMount(agent)
      if (child !== undefined) {
        mounts.set(agent, child)
        runLifecycleHook(ctx, hookOpts(child.rootMount), 'agent/created', agent as never, { source }).catch(() => {})
      }
      return
    }
    const m = await attachRoot(agent)
    if (m === undefined) return
    runLifecycleHook(ctx, hookOpts(m), 'agent/created', agent as never, { source }).catch(() => {})
  }

  // Awaited on purpose: `agent/created` is serial, and the mount must exist
  // before the event settles (a later step reads it).
  ctx.on('agent/created', (async (event: AgentCreatedEvent) => {
    try {
      await onCreated(event.agent, event.source)
    } catch (error) {
      log.error(`mount failed for ${event.agent?.id}: ${(error as { stack?: unknown } | undefined)?.stack ?? error}`)
    }
  }) as never)

  ctx.on('agent/disposed', (({ agent }: { agent: AgentLike }) => {
    const m = mounts.get(agent)
    if (m === undefined) return
    const withRoot = m as { rootMount?: RootMount }
    if (withRoot.rootMount === undefined) {
      const root = m as RootMount
      if (root.settings.hooks['agent/disposed'] !== undefined) {
        runLifecycleHook(ctx, hookOpts(root), 'agent/disposed', agent as never).catch(() => {})
      }
    }
    void release(m as Mount)
  }) as never)

  // Deleting a session (e.g. dsh-session-purge) removes it from the session
  // store without disposing its agent, which stays live until DSH exits:
  // release its MCP connections, tools and hooks now.
  ctx.on('session/disposed', ((session: { id?: string } | undefined) => {
    const agents = ctx.get('agents') as { get(id: string): AgentLike | undefined } | undefined
    const agent = session?.id === undefined ? undefined : agents?.get(session.id)
    const m = agent !== undefined && agent.session === session ? mounts.get(agent) : undefined
    if (m === undefined) return
    const withRoot = m as { rootMount?: RootMount; toolName?: string; label?: string }
    log.info(
      `${withRoot.rootMount !== undefined ? `${withRoot.rootMount.label}/${withRoot.toolName ?? 'subagent'}` : withRoot.label}: session removed, released`,
    )
    void release(m as Mount)
  }) as never)

  // Before the first model call: wait for the MCP servers.
  // The agent loop assembles prompt + tools *before* `agent/pre-step`
  // (dsh-agent-loop preStep), so the wait happens in the root agent's
  // `system-prompt/assemble` waterfall, which then re-assembles once so the
  // first request already carries the MCP tools. `agent/pre-step` stays as
  // a fallback for compositions without that waterfall.
  function installFirstAssembly(m: RootMount): void {
    let reentrant = false
    const agentCtx = (m.agent as AgentLike).ctx
    m.listeners.push(
      (agentCtx as unknown as {
        on(event: string, cb: (assembly: unknown, context: AssemblyContext, next: () => unknown) => unknown): Unsubscribe
      }).on('system-prompt/assemble', async (assembly, context, next) => {
        if (reentrant || m.prepared || !m.ok || context?.agent !== m.agent) return next()
        await prepareRoot(m, m.agent as AgentLike, context.signal)
        const systemPrompt = ctx.get('systemPrompt') as { assemble(context: unknown): Promise<unknown> } | undefined
        if (systemPrompt === undefined) return next()
        reentrant = true
        try {
          return await systemPrompt.assemble(context)
        } finally {
          reentrant = false
        }
      }),
    )
  }

  // Awaited on purpose: this is a waterfall, and the first step must wait for
  // the MCP servers before the loop assembles its tools.
  ctx.on('agent/pre-step', (async (ev: PreStepEvent, next: () => unknown) => {
    const m = mounts.get(ev.agent)
    if (m !== undefined) {
      const withRoot = m as { rootMount?: RootMount }
      const root = m as RootMount
      if (withRoot.rootMount === undefined && root.ok && !root.prepared) {
        await prepareRoot(root, ev.agent, ev.signal)
      }
    }
    return next()
  }) as never)

  async function prepareRoot(m: RootMount, agent: AgentLike, signal: AbortSignal | undefined): Promise<void> {
    if (m.prepared) return
    m.prepared = true
    void agent
    void signal
    try {
      await mountFeatures(m)
      if (m.hub !== undefined) await m.hub.ready
    } catch (error) {
      log.warn(`${m.label}: first-step preparation failed: ${errMessage(error)}`)
    }
  }

  // ------------------------------------------------------------ /project-config reload
  const ALL_PARTS: readonly ReloadPart[] = ['subagents', 'commands', 'mcp', 'hooks']

  /** What one `reload` run produced: per-section counts, and the sections that failed. */
  interface ReloadReport {
    counts: Record<ReloadPart, number>
    failures: string[]
    /** Sections whose settings changed but were left alone by a single-section reload. */
    stale: ReloadPart[]
    /** The workspace settings are gone: nothing is mounted any more. */
    gone?: boolean
  }

  /**
   * Re-read the workspace settings and replace the requested sections of `m`.
   *
   * Everything is mounted on `agent.ctx`, which the plugin fiber does not own,
   * so each section is disposed here before its replacement is mounted —
   * `commands.register`, `systemPrompt.section` and `tools.register` all throw on
   * a name that is still registered, and the tool layer throws in a way DSH
   * treats as a fatal load failure.
   * @param m - the live root mount; it is released and replaced on a full reload.
   * @param parts - the sections to re-mount, in report order.
   * @param mcpName - when given, only this MCP server is restarted.
   * @returns the counts, the failures, and the sections left stale.
   */
  async function reloadRoot(m: RootMount, parts: readonly ReloadPart[], mcpName?: string): Promise<ReloadReport> {
    const all = parts.length === ALL_PARTS.length
    const agent = m.agent as AgentLike
    const children = [...m.children]
    if (all) {
      // The whole mount goes: settings, subagent tools, features, listeners.
      // `releaseRoot` also clears `mounts`, without which `attachRoot` would see
      // its own slot taken and mount nothing.
      await releaseRoot(m)
      const fresh = await attachRoot(agent)
      if (fresh === undefined) return { counts: zeroCounts(), failures: [], stale: [], gone: true }
      // The children keep their own tools and persona; only their mirror and
      // hooks are re-pointed at the new root (`releaseRoot` unmounted them).
      for (const child of children) {
        child.rootMount = fresh
        fresh.children.add(child)
        mountChildFeatures(child)
      }
      return { counts: countsOf(fresh), failures: [], stale: [] }
    }
    const loaded = await loadProjectSettings(m.root)
    if (loaded === undefined) return { counts: zeroCounts(), failures: [], stale: [], gone: true }
    // A settings file that no longer parses has no sections to mount: report it
    // and leave the running mount alone. Writing `ok: false` onto it would leave
    // `mountFeatures` skipped and the status showing an error while the old
    // sections are still mounted.
    if (!loaded.ok) return { counts: countsOf(m), failures: [String(loaded.error)], stale: [] }
    const stale = ALL_PARTS.filter((p) => !parts.includes(p) && changed(m, loaded, p))
    for (const part of parts) applySettings(m, loaded, part)
    const failures: string[] = []
    for (const part of parts) {
      try {
        if (part === 'subagents') {
          await remountSubagents(m)
          continue
        }
        if (part === 'mcp') {
          await remountMcp(m, mcpName)
          for (const child of m.children) mountChildFeatures(child, 'mcp')
          continue
        }
        await unmountSections(m, part)
        if (part === 'commands') await mountCommandsFeature(m)
        else mountHooksFeature(m)
        // The children lost this section when it was unmounted; put it back so a
        // reload never leaves a running subagent without its tools or hooks.
        for (const child of m.children) mountChildFeatures(child)
      } catch (error) {
        log.warn(`${m.label}: reload ${part} failed: ${errMessage(error)}`)
        failures.push(`${part}: ${errMessage(error)}`)
      }
    }
    return { counts: countsOf(m), failures, stale }
  }

  function zeroCounts(): Record<ReloadPart, number> {
    return { subagents: 0, commands: 0, mcp: 0, hooks: 0 }
  }

  /** What is mounted right now, for the reload report. */
  function countsOf(m: RootMount): Record<ReloadPart, number> {
    return {
      subagents: m.subagentSpecs.length,
      commands: m.features.some((f) => f.kind === 'commands') ? m.settings.commands.length : 0,
      mcp: m.hub === undefined ? 0 : m.hub.servers.size,
      hooks: Object.keys(m.settings.hooks).length,
    }
  }

  /** Whether `part`'s entries differ between what is mounted and what was just read. */
  function changed(m: RootMount, loaded: LoadResult, part: ReloadPart): boolean {
    if (part === 'hooks') return JSON.stringify(m.settings.hooks) !== JSON.stringify(loaded.settings.hooks)
    const before = m.settings[part] as ReadonlyArray<unknown>
    const after = loaded.settings[part] as ReadonlyArray<unknown>
    return JSON.stringify(before) !== JSON.stringify(after)
  }

  /** Copy one section of the freshly read settings over the mount's, in place. */
  function applySettings(m: RootMount, loaded: LoadResult, part: ReloadPart): void {
    m.file = loaded.file
    m.localFile = loaded.localFile
    m.ok = loaded.ok
    m.error = loaded.error
    m.origin = loaded.origin
    m.hooksLocal = loaded.hooksLocal
    m.removed = loaded.removed
    // The warnings describe the settings that were just read, not the ones that
    // were mounted before: replace them before adding this section's own.
    m.warnings = [...loaded.warnings]
    if (part === 'hooks') {
      m.settings = { ...m.settings, hooks: loaded.settings.hooks }
      // The counters describe the hooks that are mounted; those are replaced.
      m.stats.runs = 0
      m.stats.failures = 0
      return
    }
    m.settings = { ...m.settings, [part]: loaded.settings[part] } as typeof m.settings
  }

  /** Re-read the subagent tools: dispose the one fiber, load the specs again, mount them. */
  async function remountSubagents(m: RootMount): Promise<void> {
    const fiber = m.subagentFiber
    m.subagentFiber = undefined
    const at = fiber === undefined ? -1 : m.fibers.indexOf(fiber)
    if (at >= 0) m.fibers.splice(at, 1)
    await disposeFiber(fiber, log)
    m.subagentNames = new Set(m.settings.subagents.map((s) => s.toolName))
    const ok = await loadSpecs(m, m.settings.subagents)
    m.subagentSpecs = ok
    const mounted = mountSubagentTools((m.agent as { ctx: Context }).ctx, ok, {
      log,
      label: m.label,
      isProjectName: isProjectNameFor(m),
      sectionName: 'project-config:subagents',
    })
    m.subagentFiber = mounted
    // `undefined` when the new settings list no subagent at all: pushing it would
    // leave an empty slot behind and grow `fibers` on every such reload.
    if (mounted !== undefined) m.fibers.push(mounted)
  }

  /**
   * Rebuild the MCP section. Without a name every server is dropped and started
   * again from the freshly read settings; with one, only that server's
   * connection is replaced and the others are left running.
   */
  async function remountMcp(m: RootMount, name?: string): Promise<void> {
    if (name === undefined) {
      await unmountSections(m, 'mcp')
      mountMcpFeature(m)
      if (m.hub !== undefined) await withTimeout(m.hub.ready, 10_000)
      return
    }
    const entry = m.settings.mcp.find((e) => e.serverName === name)
    if (entry === undefined) throw new Error(String(TEXT.reloadMcpUnknown(name, m.settings.mcp.map((e) => e.serverName).join(', '))))
    // The session was mounted before this workspace configured any MCP server
    // (or every entry was rejected then): bring the section up first, so naming
    // one server is enough to add it.
    if (m.hub === undefined) {
      mountMcpFeature(m)
      const started = m.hub as McpHub | undefined
      if (started !== undefined) await withTimeout(started.ready, 10_000)
      return
    }
    await m.hub.restart(entry, (e: McpSpec) => resolveServerConfig(e, m.root, checkTarget))
  }

  /**
   * Render one reload report: the counts, the failures, and what was left stale.
   *
   * Every result here is MULTI-LINE on purpose. The transcript renders a command
   * result through `GenericCommandCard`, whose
   * `body = text.includes("\n") ? text : null` decides whether the row can be
   * expanded at all; a one-line result is forced into a single `nowrap` line with
   * `text-overflow: ellipsis` and can never be opened, however long it is. So a
   * per-section report lists one entry per line instead of joining them with
   * commas.
   */
  function reloadReportText(report: ReloadReport, m: RootMount, parts: readonly ReloadPart[]): string {
    if (report.gone === true) return String(TEXT.reloadSettingsGone)
    if (parts.length === 1) {
      const part = parts[0] as ReloadPart
      if (report.failures.length > 0) {
        return `${String(TEXT.reloadPartFailed(part))}${report.failures.join('\n')}`
      }
      const lines = linesOf(m, part)
      return `${String(TEXT.reloadPartDone(part, lines.length))}${lines.length > 0 ? lines.join('\n') : '—'}`
    }
    const head =
      report.failures.length === 0
        ? String(TEXT.reloadDone(report.counts))
        : `${String(TEXT.reloadPartial(parts.join(', ')))}${report.failures.join('\n')}`
    if (report.stale.length === 0) return head
    return `${head}\n${String(TEXT.reloadStale(report.stale.join(', ')))}`
  }

  /** One line per entry a section currently holds, `reload <part>` reports them. */
  function linesOf(m: RootMount, part: ReloadPart): string[] {
    switch (part) {
      case 'subagents':
        return m.subagentSpecs.map((s) => s.entry.toolName)
      case 'commands':
        return m.settings.commands.map((c) => `/${c.name}`)
      case 'mcp': {
        // Per-server state, one line each: a reload that left a server down must
        // say so here, not in a count taken before the connections settled.
        const names = [...(m.hub?.servers.keys() ?? [])]
        return names.length === 0 ? [] : mcpStateText(m as never, names).split('\n')
      }
      case 'hooks':
        return Object.keys(m.settings.hooks)
    }
  }

  // /project-config                    status (connected MCP servers are pinged first)
  // /project-config reload             re-mount everything
  // /project-config reload <part>     re-mount one section
  // /project-config reload mcp <name>  rebuild one server's connection
  async function runCommand(invocation: {
    agent?: AgentLike
    rawInput?: unknown
  }): Promise<{ kind: string; text: string }> {
    const mount = invocation.agent === undefined ? undefined : (mounts.get(invocation.agent) as Mount | undefined)
    const withRoot = mount as { rootMount?: RootMount } | undefined
    const root = withRoot?.rootMount ?? (mount as RootMount | undefined)
    const args = String(invocation.rawInput ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (args.length === 0) {
      if (root?.hub !== undefined) await withTimeout(root.hub.checkAll(), 6000)
      return { kind: 'success', text: statusText(mount as never, { logFile: log.file }) }
    }
    // A word that is not `reload` names what was refused, so `reconnect` (the
    // old subcommand, now gone) says so instead of printing the whole usage with
    // no hint of what went wrong.
    if (args[0] !== 'reload') {
      return { kind: 'error', text: `${String(TEXT.unknownArg(args[0] as string))}\n\n${String(TEXT.commandUsage)}` }
    }
    if (args.length > 3) return { kind: 'error', text: String(TEXT.commandUsage) }
    const words = ALL_PARTS as readonly string[]
    if (args[1] !== undefined && !words.includes(args[1])) {
      return { kind: 'error', text: String(TEXT.reloadUnknownPart(args[1])) }
    }
    if (args[2] !== undefined && args[1] !== 'mcp') return { kind: 'error', text: String(TEXT.commandUsage) }
    if (mount === undefined) return { kind: 'error', text: String(TEXT.noSettings) }
    if (root === undefined) return { kind: 'error', text: String(TEXT.noSettings) }
    const parts: readonly ReloadPart[] = args[1] === undefined ? ALL_PARTS : [args[1] as ReloadPart]
    let report: ReloadReport
    try {
      report = await reloadRoot(root, parts, args[2])
    } catch (error) {
      log.warn(`${root.label}: reload failed: ${errMessage(error)}`)
      return { kind: 'error', text: String(TEXT.reloadPartial(errMessage(error))) }
    }
    log.info(`${root.label}: reload ${parts.join('+')} -> ${JSON.stringify(report.counts)}`)
    // `reloadRoot` replaced the mount on a full reload; report off the new one.
    const after = invocation.agent === undefined ? undefined : mounts.get(invocation.agent)
    const shown = (after as RootMount | undefined) ?? root
    return {
      kind: report.failures.length === 0 ? 'success' : 'error',
      text: reloadReportText(report, shown, parts),
    }
  }

  ctx.inject(['commands'], (c) => {
    c.commands.register({
      name: 'project-config',
      // Read once at registration: follows the language DSH started with.
      description: String(TEXT.commandDescription),
      input: { hint: '[reload [subagents|commands|mcp [<MCP>]|hooks]]' },
      handler: (invocation: { agent?: AgentLike; rawInput?: unknown }) => runCommand(invocation),
    } as never)
  })

  // Sessions that already exist (plugin installed or reloaded at runtime).
  ctx.inject(['agents'], (c) => {
    const agents = c.agents as unknown as {
      list(): AgentLike[]
    }
    const existing = agents
      .list()
      .sort(
        (a, b) => (a.session.header.delegationDepth ?? 0) - (b.session.header.delegationDepth ?? 0),
      )
    void (async () => {
      for (const agent of existing) {
        try {
          await onCreated(agent, 'resume')
        } catch (error) {
          log.warn(`mount failed for existing ${agent.id}: ${errMessage(error)}`)
        }
      }
    })()
  })

  log.info('plugin active')
}
