/**
 * dsh-project-config — per-workspace subagents, commands, MCP servers and hooks
 * from `<workspace>/.dsh/settings.yml`, merged with the personal
 * `.dsh/settings.local.yml` when present (see project-settings.js).
 *
 * Trust comes from dsh-workspace-trust (`ctx.workspaceTrust`, optional). Without
 * it every workspace is treated as untrusted: subagents and isolation still work;
 * commands, MCP and hooks never run.
 *
 * DSH interfaces relied on (@deepseek-ai/dsh 0.2.x):
 * - `agent/created` (serial, scoped carrier) / `agent/disposed` / `agent/pre-step`
 * - session header fields `cwd`, `origin: 'subagent'`, `parentSession`, `delegationDepth`
 * - `ctx.agents.get/list`, `agent.ctx` scoped context
 * - `ctx.commands.register` for `/project-config [reconnect [<server>]]`
 * - see lib/features/* and lib/isolation.js for the rest
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLog } from './log.js';
import { createWorkspace } from './workspace.js';
import { splitPersona } from './settings.js';
import { loadProjectSettings } from './project-settings.js';
import { patchSkillRoots, installInstructionsMarker } from './isolation.js';
import { admits, delegationStore, mountSubagentTools } from './features/subagents.js';
import { McpHub, resolveServerConfig } from './features/mcp.js';
import { mountHooks, runLifecycleHook } from './features/hooks.js';
import { mountCommands } from './features/commands.js';
import { reconnectText, statusText } from './status.js';
import { TEXT } from './text.js';
import { preferenceFromLoader, setLocaleSource } from './locale.js';

export const name = 'dsh-project-config';
const PERSONA_MAX = 1024 * 1024;

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); })]);

const disposeFiber = (fiber, log) => {
  if (!fiber) return;
  Promise.resolve().then(() => fiber.dispose()).catch((error) => log.warn(`dispose failed: ${error?.message ?? error}`));
};

function descriptorPersona(agent) {
  try {
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'subagent/descriptor' && typeof event.data?.persona === 'string') return event.data.persona;
    }
  } catch { /* older session shape */ }
  return undefined;
}

export function apply(ctx, config) {
  if (config?.enabled === false) {
    ctx.logger.info('[project-config] disabled by config');
    return;
  }
  setLocaleSource(() => preferenceFromLoader(ctx.get('loader')));
  ctx.effect(() => () => setLocaleSource(undefined), 'project-config: locale');
  const log = createLog(undefined, ctx.logger);
  const ws = createWorkspace(() => ctx.get('workspaceTrust'));
  const mounts = new WeakMap();        // agent -> RootMount | ChildMount
  const roots = new Set();             // live RootMounts
  const childTools = new Map();        // child session id -> project subagent toolName

  ctx.effect(() => patchSkillRoots(log), 'project-config: skill roots');
  installInstructionsMarker(ctx, log);

  async function loadSpecs(m, entries) {
    const ok = [];
    const deferred = [];
    for (const entry of entries) {
      const checked = await ws.checkTarget(m.root, entry.personaFile, { type: 'file', maxBytes: PERSONA_MAX });
      if (!checked.ok) {
        if (checked.code === 'UNTRUSTED') deferred.push(entry);
        else m.warnings.push(TEXT.subagentProblem(entry.toolName, checked.message));
        continue;
      }
      try {
        const { body, description } = splitPersona(await fs.promises.readFile(checked.realPath, 'utf8'));
        ok.push({ entry, persona: body, description: entry.description ?? description });
      } catch (error) {
        m.warnings.push(TEXT.subagentProblem(entry.toolName, error?.message ?? error));
      }
    }
    return { ok, deferred };
  }

  const isProjectNameFor = (m) => (n) => m.subagentNames.has(n) || n.startsWith('mcp__');

  // ------------------------------------------------------------ root sessions
  async function createRootMount(agent) {
    const cwd = agent.session.header.cwd;
    if (typeof cwd !== 'string') return undefined;
    const root = await ws.findRoot(cwd);
    const loaded = await loadProjectSettings(root);
    if (loaded === undefined) return undefined;
    const label = `[${path.basename(root)}:${agent.id.slice(-8)}]`;
    const m = {
      agent, root, label, file: loaded.file, localFile: loaded.localFile, ok: loaded.ok, error: loaded.error,
      warnings: [...(loaded.warnings ?? [])], gatedWarnings: [],
      settings: loaded.settings, origin: loaded.origin, hooksLocal: loaded.hooksLocal, removed: loaded.removed,
      trust: ws.state(root), subagentSpecs: [], deferredSpecs: [], subagentNames: new Set(),
      children: new Set(), fibers: [], gated: [], hub: undefined, gatedOn: false, gen: 0,
      prepared: false, stats: { runs: 0, failures: 0 },
    };
    if (!m.ok) { log.warn(`${label}: ${m.error}`); return m; }
    m.subagentNames = new Set(m.settings.subagents.map((s) => s.toolName));
    const { ok, deferred } = await loadSpecs(m, m.settings.subagents);
    m.subagentSpecs = ok;
    m.deferredSpecs = deferred;
    m.fibers.push(mountSubagentTools(agent.ctx, ok, { log, label, isProjectName: isProjectNameFor(m), sectionName: 'project-config:subagents' }));
    for (const w of m.warnings) log.warn(`${label}: ${w}`);
    log.info(`${label}: loaded ${loaded.file}${loaded.localFile ? ` + ${path.basename(loaded.localFile)}` : ''} (subagents ${ok.length}, commands ${m.settings.commands.length}, mcp ${m.settings.mcp.length}, hook events ${Object.keys(m.settings.hooks).length}), trust ${m.trust}`);
    return m;
  }

  function hookOpts(m) {
    return { hooks: m.settings.hooks, root: m.root, log, label: m.label, stats: m.stats };
  }

  function mountGated(m) {
    if (!m.ok) return Promise.resolve();
    if (m.gatedOn) return m.gatedReady ?? Promise.resolve();
    m.gatedOn = true;
    m.gatedReady = doMountGated(m).catch((error) => log.error(`${m.label}: mount failed: ${error?.stack ?? error}`));
    return m.gatedReady;
  }

  async function doMountGated(m) {
    const gen = ++m.gen;
    m.gatedWarnings = [];
    const created = [];
    const stale = () => gen !== m.gen;

    // subagents whose persona lives outside the workspace
    if (m.deferredSpecs.length) {
      const { ok } = await loadSpecs(m, m.deferredSpecs);
      if (stale()) return;
      m.trustedSpecs = ok;
      created.push(mountSubagentTools(m.agent.ctx, ok, { log, label: m.label, isProjectName: isProjectNameFor(m), sectionName: 'project-config:subagents-trusted' }));
    }
    // commands
    const cmdSpecs = [];
    for (const entry of m.settings.commands) {
      const checked = await ws.checkTarget(m.root, entry.handlerFile, { type: 'file' });
      if (checked.ok) cmdSpecs.push({ entry, realPath: checked.realPath });
      else m.gatedWarnings.push(TEXT.commandProblem(entry.name, checked.message));
    }
    if (stale()) { created.forEach((f) => disposeFiber(f, log)); return; }
    created.push(mountCommands(m.agent.ctx, cmdSpecs, { root: m.root, log, label: m.label }));
    // MCP
    if (m.settings.mcp.length) {
      m.hub = new McpHub(log, m.label);
      created.push(m.hub.start(m.agent.ctx, m.settings.mcp, (entry) => resolveServerConfig(entry, m.root, ws.checkTarget)));
    }
    // hooks
    created.push(mountHooks(m.agent.ctx, hookOpts(m)));
    m.gated.push(...created.filter(Boolean));
    for (const w of m.gatedWarnings) log.warn(`${m.label}: ${w}`);
    for (const child of m.children) mountChildGated(child);
    log.info(`${m.label}: trusted features mounted`);
  }

  function unmountGated(m) {
    if (!m.gatedOn) return;
    m.gatedOn = false;
    m.gatedReady = undefined;
    m.gen++;
    for (const f of m.gated.splice(0)) disposeFiber(f, log);
    m.hub = undefined;
    m.trustedSpecs = undefined;
    m.gatedWarnings = [];
    for (const child of m.children) unmountChildGated(child);
    log.info(`${m.label}: trusted features removed`);
  }

  async function setTrust(m, state) {
    m.trust = state;
    if (state === 'trusted') await mountGated(m);
    else unmountGated(m);
  }

  // ------------------------------------------------------------ child sessions
  function resolveChildTool(agent, rootMount) {
    const store = delegationStore.getStore();
    const parentId = agent.session.header.parentSession;
    if (store && store.parentId === parentId && rootMount.subagentNames.has(store.toolName)) return store.toolName;
    if (childTools.has(agent.id)) return childTools.get(agent.id);
    const persona = descriptorPersona(agent);
    if (persona !== undefined) {
      const spec = [...rootMount.subagentSpecs, ...(rootMount.trustedSpecs ?? [])].find((s) => s.persona === persona);
      if (spec) return spec.entry.toolName;
    }
    return undefined;
  }

  function childSpecsFor(rootMount, child) {
    const depth = child.agent.session.header.delegationDepth ?? 0;
    const all = [...rootMount.subagentSpecs, ...(rootMount.trustedSpecs ?? [])];
    return all
      .filter((s) => admits(child.filter, s.entry.toolName) && depth + 1 <= s.entry.maxDepth)
      .map((s) => ({ entry: s.entry, persona: s.persona, description: s.description }));
  }

  function createChildMount(agent) {
    const header = agent.session.header;
    if (header.origin !== 'subagent' || typeof header.parentSession !== 'string') return undefined;
    const parent = ctx.get('agents')?.get(header.parentSession);
    const pm = parent ? mounts.get(parent) : undefined;
    if (pm === undefined) return undefined;
    const rootMount = pm.rootMount ?? pm;
    if (!rootMount.ok || roots.has(rootMount) === false) return undefined;
    const toolName = resolveChildTool(agent, rootMount);
    if (toolName) childTools.set(agent.id, toolName);
    const entry = toolName ? rootMount.settings.subagents.find((s) => s.toolName === toolName) : undefined;
    const child = { agent, rootMount, toolName, filter: entry?.toolFilter, fibers: [], gated: [], subagents: [] };
    child.subagents = childSpecsFor(rootMount, child);
    child.fibers.push(mountSubagentTools(agent.ctx, child.subagents, {
      log, label: `${rootMount.label}/${toolName ?? 'subagent'}`, isProjectName: isProjectNameFor(rootMount), sectionName: 'project-config:subagents',
    }));
    rootMount.children.add(child);
    if (rootMount.gatedOn) mountChildGated(child);
    return child;
  }

  function mountChildGated(child) {
    if (child.gatedOn) return;
    child.gatedOn = true;
    const m = child.rootMount;
    if (m.hub) child.gated.push(m.hub.mirror(child.agent.ctx, child.filter));
    child.gated.push(mountHooks(child.agent.ctx, hookOpts(m)));
    child.gated = child.gated.filter(Boolean);
  }

  function unmountChildGated(child) {
    if (!child.gatedOn) return;
    child.gatedOn = false;
    for (const f of child.gated.splice(0)) disposeFiber(f, log);
  }

  // ------------------------------------------------------------ lifecycle
  async function onCreated(agent, source) {
    if (mounts.has(agent)) return;
    const header = agent.session?.header;
    if (header === undefined) return;
    if (header.origin === 'subagent') {
      const child = createChildMount(agent);
      if (child) {
        mounts.set(agent, child);
        if (child.rootMount.trust === 'trusted') {
          runLifecycleHook(ctx, hookOpts(child.rootMount), 'agent/created', agent, { source }).catch(() => {});
        }
      }
      return;
    }
    const m = await createRootMount(agent);
    if (m === undefined) return;
    mounts.set(agent, m);
    roots.add(m);
    if (m.ok) installFirstAssembly(m);
    if (m.trust === 'trusted') {
      await mountGated(m);
      runLifecycleHook(ctx, hookOpts(m), 'agent/created', agent, { source }).catch(() => {});
    }
  }

  ctx.on('agent/created', async ({ agent, source }) => {
    try { await onCreated(agent, source); } catch (error) {
      log.error(`mount failed for ${agent?.id}: ${error?.stack ?? error}`);
    }
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const m = mounts.get(agent);
    if (m === undefined) return;
    mounts.delete(agent);
    if (m.rootMount) {
      m.rootMount.children.delete(m);
      unmountChildGated(m);
      for (const f of m.fibers) disposeFiber(f, log);
      return;
    }
    if (m.trust === 'trusted' && m.settings.hooks['agent/disposed']) {
      runLifecycleHook(ctx, hookOpts(m), 'agent/disposed', agent).catch(() => {});
    }
    roots.delete(m);
    unmountGated(m);
    for (const f of m.fibers) disposeFiber(f, log);
  });

  // Before the first model call: wait for the trust choice, then for MCP servers.
  // The agent loop assembles prompt + tools *before* `agent/pre-step`
  // (dsh-agent-loop preStep), so the wait happens in the root agent's
  // `system-prompt/assemble` waterfall, which then re-assembles once so the
  // first request already carries the trusted tools. `agent/pre-step` stays as
  // a fallback for compositions without that waterfall.
  function installFirstAssembly(m) {
    let reentrant = false;
    m.agent.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      if (reentrant || m.prepared || !m.ok || context?.agent !== m.agent) return next();
      await prepareRoot(m, m.agent, context.signal);
      const systemPrompt = ctx.get('systemPrompt');
      if (systemPrompt === undefined) return next();
      reentrant = true;
      try { return await systemPrompt.assemble(context); } finally { reentrant = false; }
    });
  }

  ctx.on('agent/pre-step', async (ev, next) => {
    const m = mounts.get(ev.agent);
    if (m !== undefined && !m.rootMount && m.ok && !m.prepared) await prepareRoot(m, ev.agent, ev.signal);
    return next();
  });

  async function prepareRoot(m, agent, signal) {
    if (m.prepared) return;
    m.prepared = true;
    try {
      if (m.trust === 'unknown' && ws.hasTrust()) {
        const state = await ws.ensure(agent, m.root, signal);
        if (state !== m.trust) await setTrust(m, state);
      }
      if (m.gatedReady) await m.gatedReady;
      if (m.hub) await m.hub.ready;
    } catch (error) {
      log.warn(`${m.label}: first-step preparation failed: ${error?.message ?? error}`);
    }
  }

  ctx.on('workspace-trust/changed', (event) => {
    const key = ws.keyOf(event?.root ?? '');
    for (const m of roots) {
      if (ws.keyOf(m.root) !== key) continue;
      setTrust(m, event.state).catch((error) => log.warn(`${m.label}: trust change failed: ${error?.message ?? error}`));
    }
  });

  // /project-config            status (connected MCP servers are pinged first)
  // /project-config reconnect  reconnect every MCP server that is not connected
  // /project-config reconnect <server>  reconnect that one, whatever its state
  async function runCommand(invocation) {
    const mount = mounts.get(invocation.agent);
    const root = mount?.rootMount ?? mount;
    const args = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean);
    const status = () => statusText(mount, { hasTrust: ws.hasTrust(), logFile: log.file });
    if (args.length === 0) {
      if (root?.hub) await withTimeout(root.hub.checkAll(), 6000);
      return { kind: 'success', text: status() };
    }
    if (args[0] !== 'reconnect' || args.length > 2) return { kind: 'error', text: String(TEXT.commandUsage) };
    if (mount === undefined) return { kind: 'error', text: String(TEXT.noSettings) };
    if (!root.hub) return { kind: 'error', text: String(root.trust === 'trusted' ? TEXT.reconnectNoMcp : TEXT.reconnectUntrusted) };
    const done = await root.hub.reconnect(args[1]);
    if (done === undefined) return { kind: 'error', text: String(TEXT.reconnectUnknown(args[1], [...root.hub.servers.keys()].join(', '))) };
    if (done.length === 0) return { kind: 'success', text: String(TEXT.reconnectNothing) };
    log.info(`${root.label}: reconnect ${done.join(', ')}`);
    return { kind: 'success', text: reconnectText(root, done) };
  }

  ctx.inject(['commands'], (c) => {
    c.commands.register({
      name: 'project-config',
      // Read once at registration: follows the language DSH started with.
      description: String(TEXT.commandDescription),
      input: { hint: '[reconnect [<MCP>]]' },
      handler: (invocation) => runCommand(invocation),
    });
  });

  // Sessions that already exist (plugin installed or reloaded at runtime).
  ctx.inject(['agents'], (c) => {
    const existing = c.agents.list().sort((a, b) => (a.session.header.delegationDepth ?? 0) - (b.session.header.delegationDepth ?? 0));
    (async () => {
      for (const agent of existing) {
        try { await onCreated(agent, 'resume'); } catch (error) { log.warn(`mount failed for existing ${agent.id}: ${error?.message ?? error}`); }
      }
    })();
  });

  log.info('plugin active');
}
