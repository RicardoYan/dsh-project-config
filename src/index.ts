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
import { loadProjectSettings } from './project-settings.js'
import { patchSkillRoots, installInstructionsMarker } from './isolation.js'
import { admits, applyChildRole, delegationStore, mountSubagentTools } from './features/subagents.js'
import { McpHub, resolveServerConfig, SkippedServer } from './features/mcp.js'
import { mountHooks, runLifecycleHook } from './features/hooks.js'
import { mountCommands } from './features/commands.js'
import { reconnectText, statusText } from './status.js'
import { TEXT } from './text.js'
import type { Text } from './locale.js'
import { preferenceFromLoader, setLocaleSource } from './locale.js'
import type { ChildMount, FeatureMount, LoadedSpec, Mount, RootMount, Unsubscribe } from './mounts.guards.js'

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
    m.fibers.push(
      mountSubagentTools(agent.ctx, ok, {
        log,
        label,
        isProjectName: isProjectNameFor(m),
        sectionName: 'project-config:subagents',
      }),
    )
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

  async function doMountFeatures(m: RootMount): Promise<void> {
    const created: Array<FeatureMount> = []
    const agentCtx = (m.agent as { ctx: Context }).ctx
    // commands
    const cmdSpecs: Array<{ entry: import('./settings.js').CommandSpec; realPath: string }> = []
    for (const entry of m.settings.commands) {
      const checked = await checkTarget(m.root, entry.handlerFile, { type: 'file' })
      if (checked.ok) cmdSpecs.push({ entry, realPath: checked.realPath })
      else m.warnings.push(TEXT.commandProblem(entry.name, checked.message) as Text)
    }
    created.push(mountCommands(agentCtx, cmdSpecs, { root: m.root, log, label: m.label }))
    // MCP
    if (m.settings.mcp.length > 0) {
      m.hub = new McpHub(log, m.label)
      created.push(
        m.hub.start(agentCtx, m.settings.mcp, (entry: McpSpec) =>
          resolveServerConfig(entry, m.root, checkTarget),
        ),
      )
    }
    // hooks
    created.push(mountHooks(agentCtx, hookOpts(m)))
    m.features.push(...created)
    for (const w of m.warnings) log.warn(`${m.label}: ${w}`)
    for (const child of m.children) mountChildFeatures(child)
    log.info(`${m.label}: features mounted`)
  }

  function unmountFeatures(m: RootMount): Promise<unknown> {
    if (!m.featuresMounted) return Promise.resolve()
    m.featuresMounted = false
    const pending: Array<Promise<unknown>> = m.features.splice(0).map((f) => disposeFiber(f, log))
    m.hub = undefined
    for (const child of m.children) pending.push(unmountChildFeatures(child))
    log.info(`${m.label}: features removed`)
    return Promise.all(pending)
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

  function mountChildFeatures(child: ChildMount): void {
    if (child.featuresMounted === true) return
    child.featuresMounted = true
    const m = child.rootMount
    if (m.hub !== undefined) child.features.push(m.hub.mirror((child.agent as AgentLike).ctx, child.filter))
    child.features.push(mountHooks((child.agent as AgentLike).ctx, hookOpts(m)))
  }

  function unmountChildFeatures(child: ChildMount): Promise<unknown> {
    if (child.featuresMounted !== true) return Promise.resolve()
    child.featuresMounted = false
    return Promise.all(child.features.splice(0).map((f) => disposeFiber(f, log)))
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
    for (const f of m.fibers.splice(0)) pending.push(disposeFiber(f, log))
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
    // Claim the agent BEFORE the first await. `agent/created` reaches this
    // function once per emission, and a plugin reload also re-runs it for every
    // live agent; two runs used to pass the `mounts.has` check, both read the
    // settings, and both mount the same tools — the second `tools.register`
    // then throws `tool "<name>" is already registered in this scope`, which
    // DSH treats as a fatal load failure (the whole host exits). The slot holds
    // nothing yet, so the failure paths below clear it again.
    const claim: Claim = { agent, pending: true, fibers: [], released: false }
    mounts.set(agent, claim)
    const m = await createRootMount(agent, claim)
    if (m === undefined) {
      mounts.delete(agent)
      return
    }
    claim.pending = false
    mounts.set(agent, m)
    roots.add(m)
    // Gone while the settings were read: plugin unloaded, agent disposed or session removed.
    const agents = ctx.get('agents') as { get(id: string): AgentLike | undefined } | undefined
    if (!active || !isLive(agent) || agents?.get(agent.id) !== agent) {
      await releaseRoot(m)
      return
    }
    if (m.ok) installFirstAssembly(m)
    await mountFeatures(m)
    if (m.released === true) return
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

  // /project-config            status (connected MCP servers are pinged first)
  // /project-config reconnect  reconnect every MCP server that is not connected
  // /project-config reconnect <server>  reconnect that one, whatever its state
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
    const status = (): string => statusText(mount as never, { logFile: log.file })
    if (args.length === 0) {
      if (root?.hub !== undefined) await withTimeout(root.hub.checkAll(), 6000)
      return { kind: 'success', text: status() }
    }
    if (args[0] !== 'reconnect' || args.length > 2) return { kind: 'error', text: String(TEXT.commandUsage) }
    if (mount === undefined) return { kind: 'error', text: String(TEXT.noSettings) }
    if (root?.hub === undefined) {
      return { kind: 'error', text: String(TEXT.reconnectNoMcp) }
    }
    const hub = root.hub
    let done: string[] | undefined
    try {
      done = await hub.reconnect(args[1] as string)
    } catch (error) {
      if (!(error instanceof SkippedServer)) throw error
      log.warn(`${root.label}: ${error.message}`)
      return { kind: 'error', text: String(TEXT.reconnectSkipped(error.server, error.reason)) }
    }
    if (done === undefined) {
      return {
        kind: 'error',
        text: String(TEXT.reconnectUnknown(args[1] as string, [...hub.servers.keys()].join(', '))),
      }
    }
    if (done.length === 0) {
      // Nothing was reconnected. When the only servers that are not connected
      // were skipped at mount time, "everything is connected" would be a lie.
      const skipped = hub.skippedServers()
      if (skipped.length > 0) {
        const list = skipped.map((s) => `${s.name} (${s.reason ?? '—'})`).join(', ')
        return { kind: 'error', text: String(TEXT.reconnectAllSkipped(list)) }
      }
      return { kind: 'success', text: String(TEXT.reconnectNothing) }
    }
    log.info(`${root.label}: reconnect ${done.join(', ')}`)
    return { kind: 'success', text: reconnectText(root as never, done) }
  }

  ctx.inject(['commands'], (c) => {
    c.commands.register({
      name: 'project-config',
      // Read once at registration: follows the language DSH started with.
      description: String(TEXT.commandDescription),
      input: { hint: '[reconnect [<MCP>]]' },
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
