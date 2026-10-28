// Project MCP servers: one connection per root session, shared with its subagents.
//
// Connections are owned here (features/mcp-connection.ts) rather than by the
// official dsh-mcp-client plugin, which keeps its connection state private:
// /project-config shows the real state and `/project-config reload mcp` restarts
// a server in the running session.
// Tools are registered on the root agent's scope (`ctx.tools.register`) and
// mirrored into subagent scopes, where calls still go through the root's
// connection. Server instructions and resources use the same official seams as
// dsh-mcp-client: `systemPrompt.section` (order MCP_SERVERS) and
// `mcpResources.register(server, provider)`.
import path from 'node:path';
import { expandVars } from '../settings.js';
import { TEXT } from '../text.js';
import { McpConnection, DEFAULT_HEALTH_CHECK_MS } from './mcp-connection.js';
import { admits } from './subagents.js';
const MASK = '***';
const MIN_SECRET = 4;
const SCHEMES = new Set(['bearer', 'basic', 'token', 'digest']);
/** Raised when `reconnect` is asked for a server whose config was rejected. */
export class SkippedServer extends Error {
    server;
    reason;
    constructor(server, reason) {
        super(`MCP server ${server} was skipped while mounting: ${reason ?? 'config rejected'}`);
        this.name = 'SkippedServer';
        this.server = server;
        this.reason = reason;
    }
}
/**
 * Strings that must not reach logs or /project-config: every header and env
 * value, the url, and the parts of each (`Bearer <token>` -> the token; the
 * url's userinfo and query values), longest first.
 */
export function secretsOf(config) {
    const out = new Set();
    const add = (v) => {
        if (typeof v === 'string' && v.length >= MIN_SECRET)
            out.add(v);
    };
    const addParts = (v) => {
        add(v);
        for (const part of String(v ?? '').split(/\s+/)) {
            if (!SCHEMES.has(part.toLowerCase()))
                add(part);
        }
    };
    for (const v of Object.values(config.headers ?? {}))
        addParts(v);
    for (const v of Object.values(config.env ?? {}))
        addParts(v);
    if (typeof config.url === 'string') {
        add(config.url);
        try {
            const u = new URL(config.url);
            add(u.href);
            add(u.origin + u.pathname);
            add(u.host);
            add(u.hostname);
            add(decodeURIComponent(u.username));
            add(decodeURIComponent(u.password));
            for (const v of u.searchParams.values())
                add(v);
        }
        catch {
            /* not a URL: the whole string is masked */
        }
    }
    return [...out].sort((a, b) => b.length - a.length);
}
/** Replace every secret in `text` with `***`. */
export function redact(text, secrets) {
    let out = String(text);
    for (const s of secrets)
        out = out.split(s).join(MASK);
    return out;
}
/** Resolve one settings entry into an official client config (or a skip reason). */
export async function resolveServerConfig(entry, root, checkTarget, env = process.env) {
    const missing = new Set();
    const exp = (s) => {
        // The original passed the raw value; `expandVars` stringifies it itself.
        const r = expandVars(s, env);
        if ('missing' in r) {
            r.missing.forEach((m) => missing.add(m));
            return '';
        }
        return r.value;
    };
    const cfg = { serverName: entry.serverName, transport: entry.transport };
    for (const key of ['toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect']) {
        if (entry[key] !== undefined)
            cfg[key] = entry[key];
    }
    if (entry.transport === 'stdio') {
        cfg.command = exp(entry.command);
        cfg.args = (entry.args ?? []).map(exp);
        cfg.env = Object.fromEntries(Object.entries(entry.env ?? {}).map(([k, v]) => [k, exp(v)]));
        if (entry.cwd !== undefined) {
            const checked = await checkTarget(root, entry.cwd, { type: 'directory' });
            if (!checked.ok)
                return { error: TEXT.cwdProblem(checked.message) };
            cfg.cwd = checked.realPath;
        }
        else
            cfg.cwd = root;
    }
    else {
        cfg.url = exp(entry.url);
        cfg.headers = Object.fromEntries(Object.entries(entry.headers ?? {}).map(([k, v]) => [k, exp(v)]));
    }
    if (missing.size > 0)
        return { error: TEXT.envMissing([...missing].join(', ')) };
    return { config: cfg };
}
/**
 * Connections of one root session.
 * `summary()`: [{ name, status, detail }] for /project-config, computed when shown.
 */
export class McpHub {
    log;
    label;
    /** public tool name -> definition */
    live = new Map();
    /** serverName -> { connection?, skipped? } */
    servers = new Map();
    mirrors = new Set();
    ready = Promise.resolve();
    disposed = false;
    scheduled = false;
    /** The scope `start()` mounted into; `restart` mounts a replaced server here. */
    scope = undefined;
    /** The connection options `start()` was given, reused by `restart`. */
    connectionOpts = {};
    constructor(log, label) {
        this.log = log;
        this.label = label;
    }
    /**
     * Start every server under the root agent scope. Returns the owning fiber;
     * `this.ready` settles when every server finished its first attempt.
     */
    start(agentCtx, entries, resolveEntry, connectionOpts = {}) {
        let release;
        this.ready = new Promise((r) => {
            release = r;
        });
        this.connectionOpts = connectionOpts;
        return agentCtx.inject(['tools'], (c) => {
            // Kept so `restart` can mount a server later on the same scope: the fiber
            // it belongs to is the one created here.
            this.scope = c;
            c.effect(() => () => this.disposeAll(), 'project-config: mcp connections');
            void this.startIn(c, entries, resolveEntry, connectionOpts).then(release, release);
        });
    }
    startIn(c, entries, resolveEntry, connectionOpts = {}) {
        this.connectionOpts = connectionOpts;
        const pending = entries.map((entry) => this.startServer(c, entry, resolveEntry, connectionOpts));
        return Promise.allSettled(pending).then(() => { });
    }
    /** Resolve one entry and bring its connection up; records skipped ones instead of throwing. */
    async startServer(c, entry, resolveEntry, connectionOpts = {}) {
        const name = entry.serverName;
        const record = { connection: undefined, skipped: undefined };
        this.servers.set(name, record);
        const resolved = await resolveEntry(entry);
        if (this.disposed)
            return;
        if ('error' in resolved) {
            record.skipped = String(resolved.error);
            this.log.warn(`${this.label}: mcp ${name} skipped: ${record.skipped}`);
            return;
        }
        // Errors may quote the url or echo a header (an HTTP error body, a server
        // message): mask before they reach the log or the status.
        const secrets = secretsOf(resolved.config);
        const clean = (t) => redact(t, secrets);
        let connection;
        try {
            connection = new McpConnection(resolved.config, {
                ctx: c,
                register: (definition) => this.track(definition, (d) => c.tools.register(d)),
                log: {
                    info: (t) => this.log.info(`${this.label}: ${clean(t)}`),
                    warn: (t) => this.log.warn(`${this.label}: ${clean(t)}`),
                },
                clean,
                healthCheckMs: DEFAULT_HEALTH_CHECK_MS,
                ...connectionOpts,
            });
        }
        catch (error) {
            record.skipped = String(error?.message ?? error);
            this.log.warn(`${this.label}: mcp ${name} skipped: ${record.skipped}`);
            return;
        }
        record.connection = connection;
        c.inject?.(['mcpResources'], (inner) => {
            inner.mcpResources.register(name, {
                request: (request, exec) => {
                    const live = this.servers.get(name)?.connection;
                    if (live === undefined)
                        throw new Error(`MCP server "${name}" is not connected`);
                    return live.resources.request(request, exec);
                },
            });
        });
        c.inject?.(['systemPrompt'], (inner) => {
            inner.systemPrompt.section({
                name: `mcp:${name}`,
                order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
                interpolate: false,
                text: () => this.servers.get(name)?.connection?.instructions ?? '',
            });
        });
        await connection.start();
    }
    /**
     * Replace ONE server's connection with a fresh one built from `entry`, on the
     * scope this hub was started on. The rest of the hub is untouched.
     *
     * The old connection is disposed first: it unregisters its tools on its own,
     * and `track` then drops them from `live` and notifies every subagent mirror.
     * @param entry - the server's current settings entry.
     * @param resolveEntry - resolves one entry into a client config.
     * @throws when the hub is not mounted, so there is no scope to mount on.
     */
    async restart(entry, resolveEntry) {
        const c = this.scope;
        const connectionOpts = this.connectionOpts;
        if (c === undefined)
            throw new Error('MCP hub is not mounted; nothing to restart');
        const name = entry.serverName;
        const old = this.servers.get(name);
        if (old?.connection !== undefined) {
            const previous = old.connection;
            this.servers.delete(name);
            await previous.dispose();
        }
        await this.startServer(c, entry, resolveEntry, connectionOpts);
    }
    /** Ping every connected server so the status reflects servers that went away silently. */
    async checkAll() {
        await Promise.allSettled([...this.servers.values()].map((r) => r.connection?.check()));
    }
    /**
     * Reconnect one server (any state) or, without a name, every server that is
     * not connected. An unresponsive server counts as not connected here: it is
     * up but silent, and restarting it is the only fix the command can offer.
     * @returns the names reconnected, or undefined when `name` is unknown.
     * @throws when a target was never connected because its config was rejected;
     *   such a server needs a settings fix and a new session, not a reconnect.
     */
    async reconnect(name) {
        let targets;
        if (name !== undefined) {
            const record = this.servers.get(name);
            if (record === undefined)
                return undefined;
            if (record.connection === undefined)
                throw new SkippedServer(name, record.skipped);
            targets = [record.connection];
        }
        else {
            targets = [...this.servers.values()]
                .map((r) => r.connection)
                .filter((x) => x !== undefined && (x.state !== 'connected' || x.isUnresponsive()));
        }
        await Promise.allSettled(targets.map((x) => x.reconnect()));
        return targets.map((x) => x.name);
    }
    /**
     * Servers that have no connection because their config was rejected while
     * mounting. They stay skipped for the life of the session: reconnect cannot
     * revive them, only a settings fix and a new session can.
     */
    skippedServers() {
        return [...this.servers.entries()]
            .filter(([, r]) => r.connection === undefined)
            .map(([name, r]) => ({ name, reason: r.skipped }));
    }
    async disposeAll() {
        this.disposed = true;
        // The mounting fiber is going away: `restart` must not put a server on it.
        this.scope = undefined;
        await Promise.allSettled([...this.servers.values()].map((r) => r.connection?.dispose()));
    }
    track(definition, register) {
        const dispose = register(definition);
        this.live.set(definition.name, definition);
        this.notify();
        let done = false;
        return () => {
            if (done)
                return;
            done = true;
            if (this.live.get(definition.name) === definition)
                this.live.delete(definition.name);
            this.notify();
            return dispose();
        };
    }
    notify() {
        if (this.scheduled)
            return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            for (const m of this.mirrors)
                m.sync();
        });
    }
    /** Mirror this hub's tools into a subagent scope, filtered by `filter`. */
    mirror(childCtx, filter) {
        const hub = this;
        const registered = new Map();
        let tools;
        const m = {
            sync() {
                if (tools === undefined)
                    return;
                for (const [name, r] of registered) {
                    if (hub.live.get(name) !== r.definition || !admits(filter, name)) {
                        registered.delete(name);
                        try {
                            r.dispose();
                        }
                        catch {
                            /* already gone */
                        }
                    }
                }
                for (const [name, definition] of hub.live) {
                    if (registered.has(name) || !admits(filter, name))
                        continue;
                    try {
                        registered.set(name, { definition, dispose: tools.register(definition) });
                    }
                    catch (error) {
                        hub.log.warn(`${hub.label}: mirror ${name} failed: ${String(error?.message ?? error)}`);
                    }
                }
            },
        };
        const fiber = childCtx.inject(['tools'], (c) => {
            tools = c.tools;
            hub.mirrors.add(m);
            m.sync();
            c.effect(() => () => {
                hub.mirrors.delete(m);
                for (const r of registered.values()) {
                    try {
                        r.dispose();
                    }
                    catch {
                        /* gone */
                    }
                }
                registered.clear();
                tools = undefined;
            }, 'project-config: mcp mirror');
        });
        return fiber;
    }
    summary() {
        return [...this.servers.entries()].map(([name, r]) => {
            if (r.skipped !== undefined || r.connection === undefined) {
                return { name, status: 'skipped', detail: r.skipped };
            }
            const st = r.connection.status();
            let detail;
            // An unresponsive server is still connected: the tools stay listed, so
            // report the silence rather than the tool count.
            if (st.state === 'connected' && st.unresponsive) {
                return { name, status: 'unresponsive', detail: TEXT.mcpUnresponsive };
            }
            if (st.state === 'connected')
                detail = TEXT.tools(st.tools);
            else if (st.state === 'retrying' || st.state === 'reconnecting') {
                detail = TEXT.mcpRetry(st.error, st.attempt ?? { n: 0, max: 0 });
            }
            else if (st.state === 'failed')
                detail = st.error;
            return { name, status: st.state, detail };
        });
    }
}
export const relativeToRoot = (root, p) => path.relative(root, p) || '.';
