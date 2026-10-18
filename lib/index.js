/**
 * dsh-project-config — per-workspace subagents, commands, MCP servers and hooks
 * from `<workspace>/.dsh/settings.yml`, merged with the personal
 * `.dsh/settings.local.yml` when present (see project-settings.ts).
 *
 * Trust comes from dsh-workspace-trust (`ctx.workspaceTrust`, optional). Without
 * it every workspace is treated as untrusted: subagents and isolation still work;
 * commands, MCP and hooks never run.
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
import fs from 'node:fs';
import path from 'node:path';
import { createLog } from './log.js';
import { createWorkspace } from './workspace.js';
import { splitPersona } from './settings.js';
import { loadProjectSettings } from './project-settings.js';
import { patchSkillRoots, installInstructionsMarker } from './isolation.js';
import { admits, applyChildRole, delegationStore, mountSubagentTools } from './features/subagents.js';
import { McpHub, resolveServerConfig } from './features/mcp.js';
import { mountHooks, runLifecycleHook } from './features/hooks.js';
import { mountCommands } from './features/commands.js';
import { reconnectText, statusText } from './status.js';
import { TEXT } from './text.js';
import { preferenceFromLoader, setLocaleSource } from './locale.js';
export const name = 'dsh-project-config';
const PERSONA_MAX = 1024 * 1024;
/** Resolves `undefined` when `promise` has not settled after `ms`. */
async function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
    });
    try {
        return await Promise.race([promise, timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Dispose one fiber; the returned promise settles when it is gone (never rejects). */
function disposeFiber(fiber, log) {
    if (fiber === undefined || fiber === null)
        return Promise.resolve();
    return Promise.resolve()
        .then(() => fiber.dispose())
        .then(() => undefined)
        .catch((error) => log.warn(`dispose failed: ${errMessage(error)}`));
}
function errMessage(error) {
    return String(error?.message ?? error);
}
function descriptorPersona(agent) {
    try {
        for (const event of agent.session.snapshotEvents?.() ?? []) {
            if (event.type === 'subagent/descriptor' && typeof event.data?.persona === 'string') {
                return event.data.persona;
            }
        }
    }
    catch {
        /* older session shape */
    }
    return undefined;
}
export function apply(ctx) {
    setLocaleSource(() => preferenceFromLoader(ctx.get('loader')));
    ctx.effect(() => () => setLocaleSource(undefined), 'project-config: locale');
    const log = createLog(undefined, ctx.logger);
    const ws = createWorkspace(() => ctx.get('workspaceTrust'));
    // agent -> RootMount | ChildMount (or the claim slot while the mount is built)
    const mounts = new WeakMap();
    const roots = new Set();
    // child session id -> project subagent toolName
    const childTools = new Map();
    let active = true;
    // Everything below is mounted on each session's own `agent.ctx`, which this
    // plugin's fiber does not own: unloading or reloading the plugin must release
    // it here, or MCP children, tools and listeners outlive the plugin.
    ctx.effect(() => async () => {
        active = false;
        const pending = [];
        let count = 0;
        for (const m of [...roots]) {
            count += 1;
            for (const child of [...m.children])
                pending.push(releaseChild(child));
            pending.push(releaseRoot(m));
        }
        await Promise.all(pending);
        if (count > 0)
            log.info(`plugin unloaded: released ${count} session${count === 1 ? '' : 's'}`);
    }, 'project-config: session mounts');
    ctx.effect(() => patchSkillRoots(log), 'project-config: skill roots');
    installInstructionsMarker(ctx, log);
    async function loadSpecs(m, entries) {
        const ok = [];
        const deferred = [];
        for (const entry of entries) {
            const checked = await ws.checkTarget(m.root, entry.personaFile, { type: 'file', maxBytes: PERSONA_MAX });
            if (!checked.ok) {
                if (checked.code === 'UNTRUSTED')
                    deferred.push(entry);
                else
                    m.warnings.push(TEXT.subagentProblem(entry.toolName, checked.message));
                continue;
            }
            try {
                const { body, description } = splitPersona(await fs.promises.readFile(checked.realPath, 'utf8'));
                ok.push({ entry, persona: body, description: entry.description ?? description });
            }
            catch (error) {
                m.warnings.push(TEXT.subagentProblem(entry.toolName, errMessage(error)));
            }
        }
        return { ok, deferred };
    }
    const isProjectNameFor = (m) => (n) => m.subagentNames.has(n) || n.startsWith('mcp__');
    // ------------------------------------------------------------ root sessions
    /**
     * Read one session's settings and mount its subagent tools.
     * @param agent - the session's agent.
     * @param claim - the placeholder already holding this agent's `mounts` slot.
     *   Its `fibers` array is adopted so a release that lands during the awaits
     *   disposes exactly the fibers this function creates.
     */
    async function createRootMount(agent, claim) {
        const cwd = agent.session.header.cwd;
        if (typeof cwd !== 'string')
            return undefined;
        const root = await ws.findRoot(cwd);
        const loaded = await loadProjectSettings(root);
        if (loaded === undefined)
            return undefined;
        const label = `[${path.basename(root)}:${agent.id.slice(-8)}]`;
        const m = {
            agent,
            root,
            label,
            file: loaded.file,
            localFile: loaded.localFile,
            ok: loaded.ok,
            error: loaded.error,
            warnings: [...(loaded.warnings ?? [])],
            gatedWarnings: [],
            settings: loaded.settings,
            origin: loaded.origin,
            hooksLocal: loaded.hooksLocal,
            removed: loaded.removed,
            trust: ws.state(root),
            subagentSpecs: [],
            deferredSpecs: [],
            trustedSpecs: undefined,
            subagentNames: new Set(),
            children: new Set(),
            fibers: claim.fibers,
            gated: [],
            listeners: [],
            hub: undefined,
            gatedOn: false,
            gatedReady: undefined,
            gen: 0,
            prepared: false,
            stats: { runs: 0, failures: 0 },
        };
        // Released while the settings were read: do not mount over a released slot.
        if (claim.released)
            return m;
        if (!m.ok) {
            log.warn(`${label}: ${m.error}`);
            return m;
        }
        m.subagentNames = new Set(m.settings.subagents.map((s) => s.toolName));
        const { ok, deferred } = await loadSpecs(m, m.settings.subagents);
        if (claim.released)
            return m;
        m.subagentSpecs = ok;
        m.deferredSpecs = deferred;
        m.fibers.push(mountSubagentTools(agent.ctx, ok, {
            log,
            label,
            isProjectName: isProjectNameFor(m),
            sectionName: 'project-config:subagents',
        }));
        for (const w of m.warnings)
            log.warn(`${label}: ${w}`);
        log.info(`${label}: loaded ${loaded.file}${loaded.localFile ? ` + ${path.basename(loaded.localFile)}` : ''} (subagents ${ok.length}, commands ${m.settings.commands.length}, mcp ${m.settings.mcp.length}, hook events ${Object.keys(m.settings.hooks).length}), trust ${m.trust}`);
        return m;
    }
    function hookOpts(m) {
        return { hooks: m.settings.hooks, root: m.root, log, label: m.label, stats: m.stats };
    }
    function mountGated(m) {
        if (!active || m.released === true || !m.ok)
            return Promise.resolve();
        if (m.gatedOn)
            return m.gatedReady ?? Promise.resolve();
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
        if (m.deferredSpecs.length > 0) {
            const { ok } = await loadSpecs(m, m.deferredSpecs);
            if (stale())
                return;
            m.trustedSpecs = ok;
            created.push(mountSubagentTools(m.agent.ctx, ok, {
                log,
                label: m.label,
                isProjectName: isProjectNameFor(m),
                sectionName: 'project-config:subagents-trusted',
            }));
        }
        // commands
        const cmdSpecs = [];
        for (const entry of m.settings.commands) {
            const checked = await ws.checkTarget(m.root, entry.handlerFile, { type: 'file' });
            if (checked.ok)
                cmdSpecs.push({ entry, realPath: checked.realPath });
            else
                m.gatedWarnings.push(TEXT.commandProblem(entry.name, checked.message));
        }
        if (stale()) {
            created.forEach((f) => void disposeFiber(f, log));
            return;
        }
        const agentCtx = m.agent.ctx;
        created.push(mountCommands(agentCtx, cmdSpecs, { root: m.root, log, label: m.label }));
        // MCP
        if (m.settings.mcp.length > 0) {
            m.hub = new McpHub(log, m.label);
            created.push(m.hub.start(agentCtx, m.settings.mcp, (entry) => resolveServerConfig(entry, m.root, ws.checkTarget)));
        }
        // hooks
        created.push(mountHooks(agentCtx, hookOpts(m)));
        m.gated.push(...created);
        for (const w of m.gatedWarnings)
            log.warn(`${m.label}: ${w}`);
        for (const child of m.children)
            mountChildGated(child);
        log.info(`${m.label}: trusted features mounted`);
    }
    function unmountGated(m) {
        if (!m.gatedOn)
            return Promise.resolve();
        m.gatedOn = false;
        m.gatedReady = undefined;
        m.gen++;
        const pending = m.gated.splice(0).map((f) => disposeFiber(f, log));
        m.hub = undefined;
        m.trustedSpecs = undefined;
        m.gatedWarnings = [];
        for (const child of m.children)
            pending.push(unmountChildGated(child));
        log.info(`${m.label}: trusted features removed`);
        return Promise.all(pending);
    }
    async function setTrust(m, state) {
        if (m.released === true)
            return;
        m.trust = state;
        if (state === 'trusted')
            await mountGated(m);
        else
            void unmountGated(m);
    }
    // ------------------------------------------------------------ child sessions
    function resolveChildTool(agent, rootMount) {
        // AsyncLocalStorage carries the delegating tool's identity down the
        // creation chain; only a matching parent makes it authoritative.
        const store = delegationStore.getStore();
        const parentId = agent.session.header.parentSession;
        if (store !== undefined &&
            store.parentId === parentId &&
            typeof store.toolName === 'string' &&
            rootMount.subagentNames.has(store.toolName)) {
            return store.toolName;
        }
        const known = childTools.get(agent.id);
        if (known !== undefined)
            return known;
        const persona = descriptorPersona(agent);
        if (persona !== undefined) {
            const spec = [...rootMount.subagentSpecs, ...(rootMount.trustedSpecs ?? [])].find((s) => s.persona === persona);
            if (spec !== undefined)
                return spec.entry.toolName;
        }
        return undefined;
    }
    function childSpecsFor(rootMount, child) {
        const depth = child.agent && child.agent.session.header.delegationDepth !== undefined
            ? child.agent.session.header.delegationDepth
            : 0;
        const all = [...rootMount.subagentSpecs, ...(rootMount.trustedSpecs ?? [])];
        return all
            .filter((s) => admits(child.filter, s.entry.toolName) && depth + 1 <= s.entry.maxDepth)
            .map((s) => ({ entry: s.entry, persona: s.persona, description: s.description }));
    }
    function createChildMount(agent) {
        const header = agent.session.header;
        if (header.origin !== 'subagent' || typeof header.parentSession !== 'string')
            return undefined;
        const parent = ctx.get('agents')?.get(header.parentSession);
        const pm = parent === undefined ? undefined : mounts.get(parent);
        if (pm === undefined)
            return undefined;
        const withRoot = pm;
        const rootMount = withRoot.rootMount ?? pm;
        if (!rootMount.ok || !roots.has(rootMount))
            return undefined;
        const toolName = resolveChildTool(agent, rootMount);
        if (toolName !== undefined)
            childTools.set(agent.id, toolName);
        const entry = toolName === undefined ? undefined : rootMount.settings.subagents.find((s) => s.toolName === toolName);
        const child = {
            agent,
            rootMount,
            toolName,
            filter: entry?.toolFilter,
            fibers: [],
            gated: [],
            subagents: [],
        };
        child.subagents = childSpecsFor(rootMount, child);
        child.fibers.push(mountSubagentTools(agent.ctx, child.subagents, {
            log,
            label: `${rootMount.label}/${toolName ?? 'subagent'}`,
            isProjectName: isProjectNameFor(rootMount),
            sectionName: 'project-config:subagents',
        }));
        // The child's role: a persona section on its own scope, plus its toolFilter.
        // Applied here rather than through a preset so the child keeps everything it
        // inherits from the delegating parent (tools, MCP).
        const spec = toolName === undefined
            ? undefined
            : [...rootMount.subagentSpecs, ...(rootMount.trustedSpecs ?? [])].find((s) => s.entry.toolName === toolName);
        if (spec !== undefined) {
            child.fibers.push(applyChildRole(agent.ctx, { persona: spec.persona, filter: entry?.toolFilter }, { log, label: `${rootMount.label}/${toolName}`, isProjectName: isProjectNameFor(rootMount) }));
        }
        rootMount.children.add(child);
        if (rootMount.gatedOn)
            mountChildGated(child);
        return child;
    }
    function mountChildGated(child) {
        if (child.gatedOn === true)
            return;
        child.gatedOn = true;
        const m = child.rootMount;
        if (m.hub !== undefined)
            child.gated.push(m.hub.mirror(child.agent.ctx, child.filter));
        child.gated.push(mountHooks(child.agent.ctx, hookOpts(m)));
    }
    function unmountChildGated(child) {
        if (child.gatedOn !== true)
            return Promise.resolve();
        child.gatedOn = false;
        return Promise.all(child.gated.splice(0).map((f) => disposeFiber(f, log)));
    }
    // ------------------------------------------------------------ release
    // One path for every way a session goes away for this plugin: agent disposed,
    // session removed from the store (deleted), plugin unloaded. Idempotent.
    function releaseChild(child) {
        if (child.released === true)
            return Promise.resolve();
        child.released = true;
        if (mounts.get(child.agent) === child)
            mounts.delete(child.agent);
        child.rootMount.children.delete(child);
        const pending = [unmountChildGated(child)];
        for (const f of child.fibers.splice(0))
            pending.push(disposeFiber(f, log));
        return Promise.all(pending);
    }
    function releaseRoot(m) {
        if (m.released === true)
            return Promise.resolve();
        m.released = true;
        if (mounts.get(m.agent) === m)
            mounts.delete(m.agent);
        roots.delete(m);
        // A claim released before its mount existed has no gated features, no
        // listeners and no hub; `fibers` is shared with the mount being built, so
        // whatever it already pushed is disposed here.
        const pending = [unmountGated(m)];
        for (const f of m.fibers.splice(0))
            pending.push(disposeFiber(f, log));
        for (const off of (m.listeners ?? []).splice(0)) {
            try {
                off();
            }
            catch {
                /* gone */
            }
        }
        return Promise.all(pending);
    }
    function release(m) {
        const withRoot = m;
        return withRoot.rootMount !== undefined ? releaseChild(m) : releaseRoot(m);
    }
    // ------------------------------------------------------------ lifecycle
    // A session removed from the store (session deleted) keeps its agent until DSH
    // exits; such an agent is no longer a session for this plugin.
    function isLive(agent) {
        const sessions = ctx.get('sessions');
        return sessions === undefined || sessions.get(agent.id) === agent.session;
    }
    async function onCreated(agent, source) {
        if (!active || mounts.has(agent) || !isLive(agent))
            return;
        const header = agent.session.header;
        if (header === undefined)
            return;
        if (header.origin === 'subagent') {
            const child = createChildMount(agent);
            if (child !== undefined) {
                mounts.set(agent, child);
                if (child.rootMount.trust === 'trusted') {
                    runLifecycleHook(ctx, hookOpts(child.rootMount), 'agent/created', agent, { source }).catch(() => { });
                }
            }
            return;
        }
        // Claim the agent BEFORE the first await. `agent/created` reaches this
        // function once per emission, and a plugin reload also re-runs it for every
        // live agent; two runs used to pass the `mounts.has` check, both read the
        // settings, and both mount the same tools — the second `tools.register`
        // then throws `tool "<name>" is already registered in this scope`, which
        // DSH treats as a fatal load failure (the whole host exits). The slot holds
        // nothing yet, so the failure paths below clear it again.
        const claim = { agent, pending: true, fibers: [], released: false };
        mounts.set(agent, claim);
        const m = await createRootMount(agent, claim);
        if (m === undefined) {
            mounts.delete(agent);
            return;
        }
        claim.pending = false;
        mounts.set(agent, m);
        roots.add(m);
        // Gone while the settings were read: plugin unloaded, agent disposed or session removed.
        const agents = ctx.get('agents');
        if (!active || !isLive(agent) || agents?.get(agent.id) !== agent) {
            await releaseRoot(m);
            return;
        }
        if (m.ok)
            installFirstAssembly(m);
        if (m.trust === 'trusted') {
            await mountGated(m);
            if (m.released === true)
                return;
            runLifecycleHook(ctx, hookOpts(m), 'agent/created', agent, { source }).catch(() => { });
        }
    }
    // Awaited on purpose: `agent/created` is serial, and the mount must exist
    // before the event settles (a later step reads it).
    ctx.on('agent/created', (async (event) => {
        try {
            await onCreated(event.agent, event.source);
        }
        catch (error) {
            log.error(`mount failed for ${event.agent?.id}: ${error?.stack ?? error}`);
        }
    }));
    ctx.on('agent/disposed', (({ agent }) => {
        const m = mounts.get(agent);
        if (m === undefined)
            return;
        const withRoot = m;
        if (withRoot.rootMount === undefined) {
            const root = m;
            if (root.trust === 'trusted' && root.settings.hooks['agent/disposed'] !== undefined) {
                runLifecycleHook(ctx, hookOpts(root), 'agent/disposed', agent).catch(() => { });
            }
        }
        void release(m);
    }));
    // Deleting a session (e.g. dsh-session-purge) removes it from the session
    // store without disposing its agent, which stays live until DSH exits:
    // release its MCP connections, tools and hooks now.
    ctx.on('session/disposed', ((session) => {
        const agents = ctx.get('agents');
        const agent = session?.id === undefined ? undefined : agents?.get(session.id);
        const m = agent !== undefined && agent.session === session ? mounts.get(agent) : undefined;
        if (m === undefined)
            return;
        const withRoot = m;
        log.info(`${withRoot.rootMount !== undefined ? `${withRoot.rootMount.label}/${withRoot.toolName ?? 'subagent'}` : withRoot.label}: session removed, released`);
        void release(m);
    }));
    // Before the first model call: wait for the trust choice, then for MCP servers.
    // The agent loop assembles prompt + tools *before* `agent/pre-step`
    // (dsh-agent-loop preStep), so the wait happens in the root agent's
    // `system-prompt/assemble` waterfall, which then re-assembles once so the
    // first request already carries the trusted tools. `agent/pre-step` stays as
    // a fallback for compositions without that waterfall.
    function installFirstAssembly(m) {
        let reentrant = false;
        const agentCtx = m.agent.ctx;
        m.listeners.push(agentCtx.on('system-prompt/assemble', async (assembly, context, next) => {
            if (reentrant || m.prepared || !m.ok || context?.agent !== m.agent)
                return next();
            await prepareRoot(m, m.agent, context.signal);
            const systemPrompt = ctx.get('systemPrompt');
            if (systemPrompt === undefined)
                return next();
            reentrant = true;
            try {
                return await systemPrompt.assemble(context);
            }
            finally {
                reentrant = false;
            }
        }));
    }
    // Awaited on purpose: this is a waterfall, and the first step must wait for
    // the trust choice and the MCP servers before the loop assembles its tools.
    ctx.on('agent/pre-step', (async (ev, next) => {
        const m = mounts.get(ev.agent);
        if (m !== undefined) {
            const withRoot = m;
            const root = m;
            if (withRoot.rootMount === undefined && root.ok && !root.prepared) {
                await prepareRoot(root, ev.agent, ev.signal);
            }
        }
        return next();
    }));
    async function prepareRoot(m, agent, signal) {
        if (m.prepared)
            return;
        m.prepared = true;
        try {
            if (m.trust === 'unknown' && ws.hasTrust()) {
                const state = await ws.ensure(agent, m.root, signal);
                if (state !== m.trust)
                    await setTrust(m, state);
            }
            if (m.gatedReady !== undefined)
                await m.gatedReady;
            if (m.hub !== undefined)
                await m.hub.ready;
        }
        catch (error) {
            log.warn(`${m.label}: first-step preparation failed: ${errMessage(error)}`);
        }
    }
    ctx.on('workspace-trust/changed', ((event) => {
        const key = ws.keyOf(event?.root ?? '');
        for (const m of roots) {
            if (ws.keyOf(m.root) !== key)
                continue;
            setTrust(m, event.state).catch((error) => log.warn(`${m.label}: trust change failed: ${errMessage(error)}`));
        }
    }));
    // /project-config            status (connected MCP servers are pinged first)
    // /project-config reconnect  reconnect every MCP server that is not connected
    // /project-config reconnect <server>  reconnect that one, whatever its state
    async function runCommand(invocation) {
        const mount = invocation.agent === undefined ? undefined : mounts.get(invocation.agent);
        const withRoot = mount;
        const root = withRoot?.rootMount ?? mount;
        const args = String(invocation.rawInput ?? '')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        const status = () => statusText(mount, { hasTrust: ws.hasTrust(), logFile: log.file });
        if (args.length === 0) {
            if (root?.hub !== undefined)
                await withTimeout(root.hub.checkAll(), 6000);
            return { kind: 'success', text: status() };
        }
        if (args[0] !== 'reconnect' || args.length > 2)
            return { kind: 'error', text: String(TEXT.commandUsage) };
        if (mount === undefined)
            return { kind: 'error', text: String(TEXT.noSettings) };
        if (root?.hub === undefined) {
            return {
                kind: 'error',
                text: String(root?.trust === 'trusted' ? TEXT.reconnectNoMcp : TEXT.reconnectUntrusted),
            };
        }
        const hub = root.hub;
        const done = await hub.reconnect(args[1]);
        if (done === undefined) {
            return {
                kind: 'error',
                text: String(TEXT.reconnectUnknown(args[1], [...hub.servers.keys()].join(', '))),
            };
        }
        if (done.length === 0)
            return { kind: 'success', text: String(TEXT.reconnectNothing) };
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
        const agents = c.agents;
        const existing = agents
            .list()
            .sort((a, b) => (a.session.header.delegationDepth ?? 0) - (b.session.header.delegationDepth ?? 0));
        void (async () => {
            for (const agent of existing) {
                try {
                    await onCreated(agent, 'resume');
                }
                catch (error) {
                    log.warn(`mount failed for existing ${agent.id}: ${errMessage(error)}`);
                }
            }
        })();
    });
    log.info('plugin active');
}
