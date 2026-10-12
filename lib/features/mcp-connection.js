// One supervised MCP connection whose state this plugin owns.
//
// The official @deepseek-ai/dsh-mcp-client keeps its connection state private
// (no status API, no reconnect entry point), so project servers are connected
// here with the MCP SDK the DSH runtime ships (`@modelcontextprotocol/client`,
// the same copy the official client uses). Behaviour follows the official
// client (dsh-mcp-client 0.2.0-rc.2, lib/types/connection.js + tools.js):
// - one Client + transport per attempt ("generation"); tools are listed and
//   swapped in as one generation; `notifications/tools/list_changed` re-syncs;
// - reconnect with exponential backoff (500ms doubling to 30s, 10 attempts per
//   outage; a connection up for `maxDelayMs` resets the budget); exhaustion
//   unregisters the tools and stops;
// - during an outage the last tools stay registered and calls fail;
// - public tool names `mcp__<server>__<tool>` with the same normalisation and
//   hash, so session history and permission rules stay valid;
// - tool definitions come from the official `createMcpToolDefinition` (result
//   validation, image projection), stdio children get `scrubbedParentEnv()`.
// On top of that: `status()` reports the real state and the last error object,
// and `reconnect()` restarts the connection at once with a fresh budget.
import { createHash } from 'node:crypto';
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';

export const RECONNECT_DEFAULTS = Object.freeze({ enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 });
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CLOSE_TIMEOUT_MS = 5_000;
const STDERR_TAIL_BYTES = 2_048;
const CHECK_TIMEOUT_MS = 5_000;

// ------------------------------------------------------------- tool names
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

/** Same rule as the official client's `publicToolName` (not exported there). */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/** Validated reconnect policy; throws a plain message (shown as the skip reason). */
export function resolveReconnectPolicy(config) {
  if (config !== undefined) {
    for (const key of Object.keys(config)) if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`reconnect.${key} is not a reconnect option`);
  }
  const p = { ...RECONNECT_DEFAULTS, ...(config ?? {}) };
  if (typeof p.enabled !== 'boolean') throw new Error('reconnect.enabled must be true or false');
  if (!Number.isFinite(p.initialDelayMs) || p.initialDelayMs <= 0 || p.initialDelayMs > MAX_TIMER_DELAY_MS) throw new Error('reconnect.initialDelayMs must be a positive number');
  if (!Number.isFinite(p.maxDelayMs) || p.maxDelayMs <= 0 || p.maxDelayMs > MAX_TIMER_DELAY_MS) throw new Error('reconnect.maxDelayMs must be a positive number');
  if (p.initialDelayMs > p.maxDelayMs) throw new Error('reconnect.initialDelayMs must not exceed maxDelayMs');
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) throw new Error('reconnect.maxAttempts must be a positive integer');
  return Object.freeze(p);
}

/** Default transport factory (tests inject their own). */
export function createTransport(config) {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...scrubbedParentEnv(), ...(config.env ?? {}) },
      cwd: config.cwd,
      stderr: 'pipe',
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } });
}

/** Error message plus the network code behind it (`fetch failed (ECONNREFUSED)`). */
function errorText(error) {
  const text = String(error?.message ?? error);
  let cause = error?.cause;
  for (let i = 0; cause && i < 3; i++, cause = cause.cause) {
    if (typeof cause.code === 'string' && !text.includes(cause.code)) return `${text} (${cause.code})`;
  }
  return text;
}

/**
 * States: 'connecting' (first attempt), 'connected', 'retrying' (never connected
 * yet, waiting for the next attempt), 'reconnecting' (was connected, lost),
 * 'failed' (gave up / reconnect disabled), 'stopped' (disposed).
 */
export class McpConnection {
  /**
   * @param config - resolved server config ({ serverName, transport, ... }).
   * @param opts - { ctx: scope used for tool definitions, register(definition) -> dispose,
   *   log: { info, warn }, clean(text) -> text (redaction), now?, setTimer?, clearTimer?,
   *   transportFactory?, clientFactory? }
   */
  constructor(config, opts) {
    this.config = config;
    this.name = config.serverName;
    this.policy = resolveReconnectPolicy(config.reconnect);
    this.timeoutMs = config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    this.maxInstructionBytes = config.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES;
    this.ctx = opts.ctx;
    this.register = opts.register;
    this.log = opts.log;
    this.clean = opts.clean ?? ((t) => t);
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = opts.clearTimer ?? clearTimeout;
    this.transportFactory = opts.transportFactory ?? createTransport;
    this.clientFactory = opts.clientFactory ?? ((onListChanged) => new Client(
      { name: 'dsh-project-config', version: '0.1.1' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' }, listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: onListChanged } } },
    ));

    this.state = 'connecting';
    this.lastError = undefined;      // { message, at }
    this.attempt = 0;                // consecutive failed attempts in this outage
    this.connectedAt = undefined;
    this.instructions = '';
    this.disposers = new Map();      // public name -> dispose
    this.gen = undefined;            // current { client, transport, closed }
    this.timer = undefined;
    this.disposed = false;
    this.syncChain = Promise.resolve();
    this.settling = Promise.resolve();
    this.listeners = new Set();
  }

  /** Start the first attempt; resolves when it settled (connected or failed). */
  start() {
    this.settling = this.connect();
    return this.settling;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) { try { fn(); } catch { /* listener */ } } }

  get toolCount() { return this.disposers.size; }

  status() {
    return {
      name: this.name,
      state: this.state,
      tools: this.toolCount,
      error: this.lastError?.message,
      errorAt: this.lastError?.at,
      attempt: this.state === 'retrying' || this.state === 'reconnecting' ? { n: this.attempt, max: this.policy.maxAttempts } : undefined,
    };
  }

  setError(error) {
    this.lastError = { message: this.clean(errorText(error)), at: this.now() };
  }

  isCurrent(gen) { return !this.disposed && this.gen === gen; }

  /** One attempt: fresh transport + client, connect, list tools, swap them in. Never rejects. */
  async connect() {
    if (this.disposed) return;
    const gen = { client: undefined, transport: undefined, closed: false, stderr: '' };
    this.gen = gen;
    let closedResolve;
    gen.closedPromise = new Promise((r) => { closedResolve = r; });
    try {
      gen.transport = this.transportFactory(this.config);
      gen.transport.stderr?.on?.('data', (chunk) => {
        gen.stderr = (gen.stderr + String(chunk)).slice(-STDERR_TAIL_BYTES);
      });
      gen.client = this.clientFactory(() => { this.refreshTools(gen); });
      gen.client.onclose = () => {
        gen.closed = true;
        closedResolve();
        if (gen.settled) this.lost(gen, undefined);
      };
      gen.client.onerror = (error) => { if (this.isCurrent(gen) && this.state === 'connected') this.setError(error); };
      await gen.client.connect(gen.transport);
      if (gen.closed) throw new Error('connection closed during startup');
      if (!this.isCurrent(gen)) { await this.closeGen(gen); return; }
      const text = gen.client.getInstructions?.()?.trimEnd() ?? '';
      const instructions = text ? `### MCP server: ${this.name}\n\n${text}` : '';
      if (Buffer.byteLength(instructions) > this.maxInstructionBytes) throw new Error(`server instructions exceed maxInstructionBytes (${this.maxInstructionBytes})`);
      await this.enqueueSync(gen);
      if (!this.isCurrent(gen)) return;
      if (gen.closed) throw new Error('connection closed during startup');
      gen.settled = true;
      const recovered = this.attempt > 0;
      this.instructions = instructions;
      this.connectedAt = this.now();
      this.state = 'connected';
      this.lastError = undefined;
      this.log.info(`mcp ${this.name}: connected (${this.toolCount} ${this.toolCount === 1 ? 'tool' : 'tools'})${recovered ? ` after ${this.attempt} failed attempts` : ''}`);
      this.changed();
    } catch (error) {
      gen.settled = true;
      if (!this.isCurrent(gen)) { await this.closeGen(gen); return; }
      const tail = gen.stderr.trim();
      this.setError(tail && this.config.transport === 'stdio' ? `${errorText(error)} | stderr: ${tail.split(/\r?\n/).slice(-3).join(' / ')}` : error);
      this.log.warn(`mcp ${this.name}: connection attempt failed: ${this.lastError.message}`);
      await this.closeGen(gen);
      if (!this.isCurrent(gen)) return;
      this.gen = undefined;
      if (this.config.failOnStartupError === true && this.connectedAt === undefined && this.attempt === 0 && this.state === 'connecting') {
        this.state = 'failed';
        this.unregisterAll();
        this.changed();
        return;
      }
      this.scheduleRetry(false);
    }
  }

  /** An established generation went away (transport closed or a call proved it dead). */
  lost(gen, error) {
    if (!this.isCurrent(gen) || this.state !== 'connected') return;
    this.gen = undefined;
    if (error !== undefined) this.setError(error);
    else if (!this.lastError) this.setError(gen.stderr.trim() ? `connection closed | stderr: ${gen.stderr.trim().split(/\r?\n/).slice(-3).join(' / ')}` : 'connection closed');
    this.log.warn(`mcp ${this.name}: connection lost: ${this.lastError.message}`);
    this.closeGen(gen);
    this.scheduleRetry(true);
  }

  scheduleRetry(wasConnected) {
    if (this.disposed) return;
    if (!this.policy.enabled) {
      this.state = 'failed';
      if (!wasConnected) this.unregisterAll();
      this.log.warn(`mcp ${this.name}: reconnect disabled; stopped`);
      this.changed();
      return;
    }
    if (wasConnected && this.connectedAt !== undefined && this.now() - this.connectedAt >= this.policy.maxDelayMs) this.attempt = 0;
    if (wasConnected) this.connectedAt = undefined;
    this.attempt += 1;
    if (this.attempt > this.policy.maxAttempts) {
      this.attempt = this.policy.maxAttempts;
      this.state = 'failed';
      this.unregisterAll();
      this.log.warn(`mcp ${this.name}: giving up after ${this.policy.maxAttempts} failed attempts`);
      this.changed();
      return;
    }
    this.state = wasConnected || this.state === 'reconnecting' ? 'reconnecting' : 'retrying';
    const delay = Math.min(this.policy.maxDelayMs, this.policy.initialDelayMs * 2 ** (this.attempt - 1));
    this.nextAttemptAt = this.now() + delay;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.settling = this.connect();
    }, delay);
    this.changed();
  }

  /** Close the current connection and connect again now, with a fresh attempt budget. */
  async reconnect() {
    if (this.disposed) return this.status();
    if (this.timer !== undefined) { this.clearTimer(this.timer); this.timer = undefined; }
    const gen = this.gen;
    this.gen = undefined;
    if (gen) await this.closeGen(gen);
    await this.settling;
    this.attempt = 0;
    this.connectedAt = undefined;
    this.state = 'connecting';
    this.changed();
    this.settling = this.connect();
    await this.settling;
    return this.status();
  }

  async closeGen(gen) {
    const { client, transport } = gen;
    try {
      if (client?.transport !== undefined) await client.close();
      else await transport?.close?.();
    } catch { /* already closed */ }
    if (client?.transport !== undefined && !gen.closed) {
      await Promise.race([gen.closedPromise, new Promise((r) => { const t = setTimeout(r, CLOSE_TIMEOUT_MS); t.unref?.(); })]);
    }
  }

  enqueueSync(gen) {
    const run = this.syncChain.then(async () => {
      if (!this.isCurrent(gen)) return;
      await this.syncTools(gen);
    });
    this.syncChain = run.catch(() => {});
    return run;
  }

  async refreshTools(gen) {
    if (!this.isCurrent(gen) || this.state !== 'connected') return;
    try {
      await this.enqueueSync(gen);
      this.changed();
    } catch (error) {
      if (!this.disposed) {
        this.setError(error);
        this.log.warn(`mcp ${this.name}: tool re-sync failed: ${this.lastError.message}`);
      }
    }
  }

  /** List the server's tools and swap them in as one generation (official two-phase rule). */
  async syncTools(gen) {
    const { client } = gen;
    const response = client.getServerCapabilities()?.tools === undefined ? { tools: [] } : await client.listTools(undefined, { cacheMode: 'refresh' });
    const definitions = new Map();
    for (const tool of response.tools) {
      const name = publicToolName(this.name, tool.name);
      if (definitions.has(name)) throw new Error(`server listed tool "${tool.name}" more than once`);
      definitions.set(name, createMcpToolDefinition(this.ctx, {
        name,
        rawName: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        taskRequired: tool.execution?.taskSupport === 'required',
        call: (args, execution) => this.callTool(tool, args, execution),
      }));
    }
    this.unregisterAll();
    const next = new Map();
    try {
      for (const [name, definition] of definitions) next.set(name, this.register(definition));
    } catch (error) {
      for (const dispose of next.values()) { try { dispose(); } catch { /* gone */ } }
      throw new Error(`tool registration failed: ${errorText(error)}`);
    }
    this.disposers = next;
  }

  /** Calls always go to the current connection; a transport-level failure marks it lost. */
  async callTool(tool, args, execution) {
    const gen = this.gen;
    if (gen === undefined || this.state !== 'connected') {
      throw new Error(`MCP server "${this.name}" is not connected (${this.state}${this.lastError ? `: ${this.lastError.message}` : ''})`);
    }
    try {
      return await gen.client.callTool({ name: tool.name, arguments: args }, { signal: execution.signal, timeout: this.timeoutMs, toolDefinition: tool });
    } catch (error) {
      if (!execution.signal?.aborted && !(error instanceof ProtocolError) && isConnectionError(error)) this.lost(gen, error);
      throw error;
    }
  }

  /**
   * Confirm a connected server still answers (`ping`, 5s). Only a transport
   * failure marks it lost: a JSON-RPC error answer proves the connection, and a
   * timeout or an unsupported ping leaves the state as it is.
   */
  async check() {
    const gen = this.gen;
    if (gen === undefined || this.state !== 'connected') return;
    try {
      await gen.client.ping({ timeout: CHECK_TIMEOUT_MS });
      this.checkedAt = this.now();
    } catch (error) {
      if (error instanceof ProtocolError) { this.checkedAt = this.now(); return; }
      if (isConnectionError(error)) this.lost(gen, error);
    }
  }

  unregisterAll() {
    for (const dispose of this.disposers.values()) { try { dispose(); } catch { /* gone */ } }
    this.disposers = new Map();
  }

  /** MCP resources for `ctx.mcpResources` (same contract as the official provider). */
  get resources() {
    return {
      request: async (request, exec) => {
        const gen = this.gen;
        if (gen === undefined || this.state !== 'connected') throw new Error(`MCP server "${this.name}" is not connected`);
        const options = { signal: exec.signal, timeout: this.timeoutMs };
        switch (request.method) {
          case 'resources/list': return gen.client.listResources(request.cursor === undefined ? undefined : { cursor: request.cursor }, options);
          case 'resources/templates/list': return gen.client.listResourceTemplates(request.cursor === undefined ? undefined : { cursor: request.cursor }, options);
          case 'resources/read': return gen.client.readResource({ uri: request.uri }, options);
          default: throw new Error(`unsupported resource request ${request.method}`);
        }
      },
    };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.state = 'stopped';
    this.instructions = '';
    if (this.timer !== undefined) { this.clearTimer(this.timer); this.timer = undefined; }
    const gen = this.gen;
    this.gen = undefined;
    if (gen) await this.closeGen(gen);
    await this.settling;
    await this.syncChain;
    this.unregisterAll();
    this.listeners.clear();
  }
}

/**
 * Whether a failed request means the connection itself is gone (as opposed to a
 * JSON-RPC error answer or a timeout). Decided from the SDK's typed error codes
 * and Node's network error codes, never from message text.
 */
const LOST_CODES = new Set(['CONNECTION_CLOSED', 'NOT_CONNECTED', 'SEND_FAILED', 'CLIENT_HTTP_AUTHENTICATION', 'CLIENT_HTTP_FORBIDDEN', 'CLIENT_HTTP_FAILED_TO_OPEN_STREAM']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

export function isConnectionError(error) {
  if (LOST_CODES.has(error?.code)) return true;
  return NETWORK_CODES.has(error?.code) || NETWORK_CODES.has(error?.cause?.code) || NETWORK_CODES.has(error?.cause?.cause?.code);
}
