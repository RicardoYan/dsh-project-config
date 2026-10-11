// Project MCP servers: one connection per root session, shared with its subagents.
//
// Official interfaces relied on (@deepseek-ai/dsh-mcp-client):
// - plugin module { name, inject: ['tools'], Config, apply }; `apply` is async and
//   resolves after the initial connection + tool discovery.
// - tools are registered through `ctx.tools.register(definition)` and removed by
//   calling the returned disposer (re-sync = dispose old generation, register new).
// The root session runs the official client with an intercepted `tools`, so every
// definition it registers is also known here and mirrored into subagent scopes,
// where calls still go through the root's connection.
import path from 'node:path';
import * as mcpClient from '@deepseek-ai/dsh-mcp-client';
import { expandVars } from '../settings.js';
import { TEXT } from '../text.js';
import { admits, interceptTools } from './subagents.js';

/** Resolve one settings entry into an official client config (or a skip reason). */
export async function resolveServerConfig(entry, root, checkTarget, env = process.env) {
  const missing = new Set();
  const exp = (s) => {
    const r = expandVars(s, env);
    if (r.missing) { r.missing.forEach((m) => missing.add(m)); return ''; }
    return r.value;
  };
  const cfg = { serverName: entry.serverName, transport: entry.transport };
  for (const key of ['toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect']) if (entry[key] !== undefined) cfg[key] = entry[key];
  if (entry.transport === 'stdio') {
    cfg.command = exp(entry.command);
    cfg.args = (entry.args ?? []).map(exp);
    cfg.env = Object.fromEntries(Object.entries(entry.env ?? {}).map(([k, v]) => [k, exp(v)]));
    if (entry.cwd !== undefined) {
      const checked = await checkTarget(root, entry.cwd, { type: 'directory' });
      if (!checked.ok) return { error: TEXT.cwdProblem(checked.message) };
      cfg.cwd = checked.realPath;
    } else cfg.cwd = root;
  } else {
    cfg.url = exp(entry.url);
    cfg.headers = Object.fromEntries(Object.entries(entry.headers ?? {}).map(([k, v]) => [k, exp(v)]));
  }
  if (missing.size) return { error: TEXT.envMissing([...missing].join(', ')) };
  return { config: cfg };
}

/**
 * Connection hub for one root session.
 * `servers`: [{ name, status, detail }] for /project-config.
 */
export class McpHub {
  constructor(log, label) {
    this.log = log;
    this.label = label;
    this.live = new Map();      // public tool name -> definition
    this.servers = new Map();   // serverName -> { status, detail, fiber }
    this.mirrors = new Set();
    this.ready = Promise.resolve();
  }

  /**
   * Start every server under the root agent scope. Returns the owning fiber;
   * `this.ready` settles when every server finished its initial connection.
   */
  start(agentCtx, entries, resolveEntry) {
    let release;
    this.ready = new Promise((r) => { release = r; });
    return agentCtx.inject(['tools'], (c) => {
      this.startIn(c, entries, resolveEntry).then(release, release);
    });
  }

  startIn(agentCtx, entries, resolveEntry) {
    const pending = entries.map(async (entry) => {
      const state = { status: 'connecting', detail: '', fiber: undefined };
      this.servers.set(entry.serverName, state);
      const resolved = await resolveEntry(entry);
      if (resolved.error) {
        state.status = 'skipped';
        state.detail = resolved.error;
        this.log.warn(`${this.label}: mcp ${entry.serverName} skipped: ${resolved.error}`);
        return;
      }
      const errors = [];
      const logger = {
        info: (m) => this.log.info(`${this.label}: ${m}`),
        debug: () => {},
        warn: (m) => { errors.push(String(m)); this.log.warn(`${this.label}: ${m}`); },
        error: (m) => { errors.push(String(m)); this.log.error(`${this.label}: ${m}`); },
      };
      const tools = interceptTools(agentCtx.tools, (definition, register) => this.track(definition, register));
      try {
        state.fiber = agentCtx.extend({ tools, logger }).plugin(mcpClient, resolved.config);
        await state.fiber;
        const own = [...this.live.keys()].filter((n) => n.startsWith(`mcp__${entry.serverName}__`));
        if (own.length > 0 || errors.length === 0) {
          state.status = 'connected';
          state.detail = TEXT.tools(own.length);
        } else {
          state.status = 'failed';
          state.detail = errors[errors.length - 1];
        }
      } catch (error) {
        state.status = 'failed';
        state.detail = String(error?.message ?? error);
        this.log.warn(`${this.label}: mcp ${entry.serverName} failed: ${state.detail}`);
      }
    });
    return Promise.allSettled(pending).then(() => {});
  }

  track(definition, register) {
    const dispose = register(definition);
    this.live.set(definition.name, definition);
    this.notify();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.live.get(definition.name) === definition) this.live.delete(definition.name);
      this.notify();
      return dispose();
    };
  }

  notify() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const m of this.mirrors) m.sync();
    });
  }

  /** Mirror this hub's tools into a subagent scope, filtered by `filter`. */
  mirror(childCtx, filter) {
    const hub = this;
    const registered = new Map(); // name -> { definition, dispose }
    let tools;
    const m = {
      sync() {
        if (tools === undefined) return;
        for (const [name, r] of registered) {
          if (hub.live.get(name) !== r.definition || !admits(filter, name)) {
            registered.delete(name);
            try { r.dispose(); } catch { /* already gone */ }
          }
        }
        for (const [name, definition] of hub.live) {
          if (registered.has(name) || !admits(filter, name)) continue;
          try { registered.set(name, { definition, dispose: tools.register(definition) }); } catch (error) {
            hub.log.warn(`${hub.label}: mirror ${name} failed: ${error?.message ?? error}`);
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
        for (const r of registered.values()) { try { r.dispose(); } catch { /* gone */ } }
        registered.clear();
        tools = undefined;
      }, 'project-config: mcp mirror');
    });
    return fiber;
  }

  summary() {
    return [...this.servers.entries()].map(([name, s]) => ({ name, status: s.status, detail: s.detail }));
  }
}

export const relativeToRoot = (root, p) => path.relative(root, p) || '.';
