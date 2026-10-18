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
import { createHash } from 'node:crypto'
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

export const RECONNECT_DEFAULTS = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768
const MAX_TIMER_DELAY_MS = 2_147_483_647
const CLOSE_TIMEOUT_MS = 5_000
const STDERR_TAIL_BYTES = 2_048
const CHECK_TIMEOUT_MS = 5_000

// ------------------------------------------------------------- tool names
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

/** Same rule as the official client's `publicToolName` (not exported there). */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Validated reconnect policy. */
export interface ReconnectPolicy {
  enabled: boolean
  initialDelayMs: number
  maxDelayMs: number
  maxAttempts: number
}

/** A resolved server config, as `resolveServerConfig` produces one. */
export interface ServerConfig {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
  maxInstructionBytes?: number
  reconnect?: Record<string, unknown>
}

/** Validated reconnect policy; throws a plain message (shown as the skip reason). */
export function resolveReconnectPolicy(config: Record<string, unknown> | undefined): ReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`reconnect.${key} is not a reconnect option`)
    }
  }
  const p = { ...RECONNECT_DEFAULTS, ...(config ?? {}) } as ReconnectPolicy & Record<string, unknown>
  if (typeof p.enabled !== 'boolean') throw new Error('reconnect.enabled must be true or false')
  if (!Number.isFinite(p.initialDelayMs) || p.initialDelayMs <= 0 || p.initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error('reconnect.initialDelayMs must be a positive number')
  }
  if (!Number.isFinite(p.maxDelayMs) || p.maxDelayMs <= 0 || p.maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error('reconnect.maxDelayMs must be a positive number')
  }
  if (p.initialDelayMs > p.maxDelayMs) {
    throw new Error('reconnect.initialDelayMs must not exceed maxDelayMs')
  }
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) {
    throw new Error('reconnect.maxAttempts must be a positive integer')
  }
  return Object.freeze({
    enabled: p.enabled,
    initialDelayMs: p.initialDelayMs,
    maxDelayMs: p.maxDelayMs,
    maxAttempts: p.maxAttempts,
  })
}

/** The transport shape this module drives; the SDK's own class satisfies it. */
interface TransportLike {
  stderr?: { on?: (event: string, cb: (chunk: unknown) => void) => unknown } | undefined
  close?(): Promise<void>
}

/** The client shape this module drives; the SDK's own class satisfies it. */
interface ClientLike {
  transport?: unknown
  onclose: (() => void) | undefined
  onerror: ((error: unknown) => void) | undefined
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
  getInstructions?(): string | undefined
  getServerCapabilities(): { tools?: unknown } | undefined
  listTools(
    params: unknown,
    options: { cacheMode: string },
  ): Promise<{ tools: ReadonlyArray<RawTool> }>
  callTool(params: unknown, options: unknown): Promise<unknown>
  ping(options: { timeout: number }): Promise<unknown>
  listResources(cursor: unknown, options: unknown): Promise<unknown>
  listResourceTemplates(cursor: unknown, options: unknown): Promise<unknown>
  readResource(params: { uri: string }, options: unknown): Promise<unknown>
}

/** One tool as the server lists it. */
interface RawTool {
  name: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  execution?: { taskSupport?: string }
}

/** Default transport factory (tests inject their own). */
export function createTransport(config: ServerConfig): TransportLike {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command as string,
      args: config.args ?? [],
      env: { ...scrubbedParentEnv(), ...(config.env ?? {}) },
      // exactOptionalPropertyTypes refuses an explicit undefined for an
      // optional field, so the cwd is spread in only when the server sets one.
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      stderr: 'pipe',
    }) as unknown as TransportLike
  }
  return new StreamableHTTPClientTransport(new URL(config.url as string), {
    requestInit: { headers: config.headers ?? {} },
  }) as unknown as TransportLike
}

/** The log surface the connection writes through (already redacted by the caller). */
export interface ConnectionLog {
  info(message: string): void
  warn(message: string): void
}

/** Constructor options for {@link McpConnection}. */
export interface McpConnectionOptions {
  /** Scope used to build tool definitions. */
  ctx: unknown
  /** Register one tool definition; returns its disposer. */
  register(definition: unknown): () => void
  log: ConnectionLog
  clean?(text: string): string
  now?(): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(timer: unknown): void
  transportFactory?(config: ServerConfig): TransportLike
  clientFactory?(onListChanged: () => void): ClientLike
}

/** The state machine's names, as `/project-config` prints them. */
export type ConnectionState = 'connecting' | 'connected' | 'retrying' | 'reconnecting' | 'failed' | 'stopped'

/** What `status()` reports. */
export interface ConnectionStatus {
  name: string
  state: ConnectionState
  tools: number
  error: string | undefined
  errorAt: number | undefined
  attempt: { n: number; max: number } | undefined
}

/** One connection attempt. */
interface Generation {
  client: ClientLike | undefined
  transport: TransportLike | undefined
  closed: boolean
  stderr: string
  closedPromise?: Promise<void>
  settled?: boolean
}

/** A resource request, as `ctx.mcpResources` forwards one. */
interface ResourceRequest {
  method: string
  cursor?: string
  uri: string
}

/** Resource execution context. */
interface ResourceExec {
  signal: AbortSignal
}

export class McpConnection {
  readonly config: ServerConfig
  readonly name: string
  readonly policy: ReconnectPolicy
  readonly timeoutMs: number
  readonly maxInstructionBytes: number
  readonly ctx: unknown
  readonly register: (definition: unknown) => () => void
  readonly log: ConnectionLog
  readonly clean: (text: string) => string
  readonly now: () => number
  readonly setTimer: (fn: () => void, ms: number) => unknown
  readonly clearTimer: (timer: unknown) => void
  readonly transportFactory: (config: ServerConfig) => TransportLike
  readonly clientFactory: (onListChanged: () => void) => ClientLike

  state: ConnectionState = 'connecting'
  /** `{ message, at }` of the last failure. */
  lastError: { message: string; at: number } | undefined = undefined
  /** Consecutive failed attempts in this outage. */
  attempt = 0
  connectedAt: number | undefined = undefined
  checkedAt: number | undefined = undefined
  nextAttemptAt: number | undefined = undefined
  instructions = ''
  disposers = new Map<string, () => void>()
  gen: Generation | undefined = undefined
  timer: unknown = undefined
  disposed = false
  syncChain: Promise<void> = Promise.resolve()
  settling: Promise<void> = Promise.resolve()
  readonly listeners = new Set<() => void>()

  /**
   * @param config - resolved server config ({ serverName, transport, ... }).
   * @param opts - scope, registration hook, redacting log, and injectable clocks
   *   and factories (tests supply their own).
   */
  constructor(config: ServerConfig, opts: McpConnectionOptions) {
    this.config = config
    this.name = config.serverName
    this.policy = resolveReconnectPolicy(config.reconnect)
    this.timeoutMs = config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
    this.maxInstructionBytes = config.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES
    this.ctx = opts.ctx
    this.register = opts.register
    this.log = opts.log
    this.clean = opts.clean ?? ((t) => t)
    this.now = opts.now ?? Date.now
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return t
      })
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
    this.transportFactory = opts.transportFactory ?? createTransport
    this.clientFactory =
      opts.clientFactory ??
      ((onListChanged) =>
        new Client(
          { name: 'dsh-project-config', version: '0.1.1' },
          {
            capabilities: {},
            versionNegotiation: { mode: 'auto' },
            listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: onListChanged } },
          },
        ) as unknown as ClientLike)
  }

  /** Start the first attempt; resolves when it settled (connected or failed). */
  start(): Promise<void> {
    this.settling = this.connect()
    return this.settling
  }

  onChange(fn: () => void): () => boolean {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  changed(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        /* listener */
      }
    }
  }

  get toolCount(): number {
    return this.disposers.size
  }

  status(): ConnectionStatus {
    return {
      name: this.name,
      state: this.state,
      tools: this.toolCount,
      error: this.lastError?.message,
      errorAt: this.lastError?.at,
      attempt:
        this.state === 'retrying' || this.state === 'reconnecting'
          ? { n: this.attempt, max: this.policy.maxAttempts }
          : undefined,
    }
  }

  setError(error: unknown): void {
    this.lastError = { message: this.clean(errorText(error)), at: this.now() }
  }

  isCurrent(gen: Generation): boolean {
    return !this.disposed && this.gen === gen
  }

  /** One attempt: fresh transport + client, connect, list tools, swap them in. Never rejects. */
  async connect(): Promise<void> {
    if (this.disposed) return
    const gen: Generation = { client: undefined, transport: undefined, closed: false, stderr: '' }
    this.gen = gen
    let closedResolve: (() => void) | undefined
    gen.closedPromise = new Promise<void>((r) => {
      closedResolve = r
    })
    try {
      gen.transport = this.transportFactory(this.config)
      gen.transport.stderr?.on?.('data', (chunk: unknown) => {
        gen.stderr = (gen.stderr + String(chunk)).slice(-STDERR_TAIL_BYTES)
      })
      gen.client = this.clientFactory(() => {
        void this.refreshTools(gen)
      })
      gen.client.onclose = () => {
        gen.closed = true
        closedResolve?.()
        if (gen.settled === true) this.lost(gen, undefined)
      }
      gen.client.onerror = (error: unknown) => {
        if (this.isCurrent(gen) && this.state === 'connected') this.setError(error)
      }
      await gen.client.connect(gen.transport)
      if (gen.closed) throw new Error('connection closed during startup')
      if (!this.isCurrent(gen)) {
        await this.closeGen(gen)
        return
      }
      const text = gen.client.getInstructions?.()?.trimEnd() ?? ''
      const instructions = text !== '' ? `### MCP server: ${this.name}\n\n${text}` : ''
      if (Buffer.byteLength(instructions) > this.maxInstructionBytes) {
        throw new Error(`server instructions exceed maxInstructionBytes (${this.maxInstructionBytes})`)
      }
      await this.enqueueSync(gen)
      if (!this.isCurrent(gen)) return
      if (gen.closed) throw new Error('connection closed during startup')
      gen.settled = true
      const recovered = this.attempt > 0
      this.instructions = instructions
      this.connectedAt = this.now()
      this.state = 'connected'
      this.lastError = undefined
      this.log.info(
        `mcp ${this.name}: connected (${this.toolCount} ${this.toolCount === 1 ? 'tool' : 'tools'})${recovered ? ` after ${this.attempt} failed attempts` : ''}`,
      )
      this.changed()
    } catch (error) {
      gen.settled = true
      if (!this.isCurrent(gen)) {
        await this.closeGen(gen)
        return
      }
      const tail = gen.stderr.trim()
      this.setError(
        tail !== '' && this.config.transport === 'stdio'
          ? `${errorText(error)} | stderr: ${tail.split(/\r?\n/).slice(-3).join(' / ')}`
          : error,
      )
      this.log.warn(`mcp ${this.name}: connection attempt failed: ${this.lastError?.message ?? ''}`)
      await this.closeGen(gen)
      if (!this.isCurrent(gen)) return
      this.gen = undefined
      if ((error as { permanent?: boolean } | undefined)?.permanent === true) {
        this.state = 'failed'
        this.connectedAt = undefined
        this.unregisterAll()
        this.log.warn(`mcp ${this.name}: stopped, retrying cannot fix this`)
        this.changed()
        return
      }
      if (
        this.config.failOnStartupError === true &&
        this.connectedAt === undefined &&
        this.attempt === 0 &&
        this.state === 'connecting'
      ) {
        this.state = 'failed'
        this.unregisterAll()
        this.changed()
        return
      }
      this.scheduleRetry(false)
    }
  }

  /** An established generation went away (transport closed or a call proved it dead). */
  lost(gen: Generation, error: unknown): void {
    if (!this.isCurrent(gen) || this.state !== 'connected') return
    this.gen = undefined
    if (error !== undefined) this.setError(error)
    else if (this.lastError === undefined) {
      this.setError(
        gen.stderr.trim() !== ''
          ? `connection closed | stderr: ${gen.stderr.trim().split(/\r?\n/).slice(-3).join(' / ')}`
          : 'connection closed',
      )
    }
    this.log.warn(`mcp ${this.name}: connection lost: ${this.lastError?.message ?? ''}`)
    void this.closeGen(gen)
    this.scheduleRetry(true)
  }

  scheduleRetry(wasConnected: boolean): void {
    if (this.disposed) return
    if (!this.policy.enabled) {
      this.state = 'failed'
      if (!wasConnected) this.unregisterAll()
      this.log.warn(`mcp ${this.name}: reconnect disabled; stopped`)
      this.changed()
      return
    }
    if (
      wasConnected &&
      this.connectedAt !== undefined &&
      this.now() - this.connectedAt >= this.policy.maxDelayMs
    ) {
      this.attempt = 0
    }
    if (wasConnected) this.connectedAt = undefined
    this.attempt += 1
    if (this.attempt > this.policy.maxAttempts) {
      this.attempt = this.policy.maxAttempts
      this.state = 'failed'
      this.unregisterAll()
      this.log.warn(`mcp ${this.name}: giving up after ${this.policy.maxAttempts} failed attempts`)
      this.changed()
      return
    }
    this.state = wasConnected || this.state === 'reconnecting' ? 'reconnecting' : 'retrying'
    const delay = Math.min(this.policy.maxDelayMs, this.policy.initialDelayMs * 2 ** (this.attempt - 1))
    this.nextAttemptAt = this.now() + delay
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.settling = this.connect()
    }, delay)
    this.changed()
  }

  /** Close the current connection and connect again now, with a fresh attempt budget. */
  async reconnect(): Promise<ConnectionStatus> {
    if (this.disposed) return this.status()
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    const gen = this.gen
    this.gen = undefined
    if (gen !== undefined) await this.closeGen(gen)
    await this.settling
    this.attempt = 0
    this.connectedAt = undefined
    this.state = 'connecting'
    this.changed()
    this.settling = this.connect()
    await this.settling
    return this.status()
  }

  async closeGen(gen: Generation): Promise<void> {
    const { client, transport } = gen
    try {
      if (client?.transport !== undefined) await client.close()
      else await transport?.close?.()
    } catch {
      /* already closed */
    }
    if (client?.transport !== undefined && !gen.closed) {
      await Promise.race([
        gen.closedPromise ?? Promise.resolve(),
        new Promise<void>((r) => {
          const t = setTimeout(r, CLOSE_TIMEOUT_MS)
          t.unref?.()
        }),
      ])
    }
  }

  enqueueSync(gen: Generation): Promise<void> {
    const run = this.syncChain.then(async () => {
      if (!this.isCurrent(gen)) return
      await this.syncTools(gen)
    })
    this.syncChain = run.catch(() => {})
    return run
  }

  async refreshTools(gen: Generation): Promise<void> {
    if (!this.isCurrent(gen) || this.state !== 'connected') return
    try {
      await this.enqueueSync(gen)
      this.changed()
    } catch (error) {
      if (!this.disposed) {
        this.setError(error)
        this.log.warn(`mcp ${this.name}: tool re-sync failed: ${this.lastError?.message ?? ''}`)
      }
    }
  }

  /** List the server's tools and swap them in as one generation (official two-phase rule). */
  async syncTools(gen: Generation): Promise<void> {
    const client = gen.client as ClientLike
    // Called directly, then `?.tools`: the SDK client always has it, and the
    // original form keeps a missing method a loud failure rather than a silent
    // "no tools" (which would unregister every tool of the server).
    const response =
      client.getServerCapabilities()?.tools === undefined
        ? { tools: [] as RawTool[] }
        : await client.listTools(undefined, { cacheMode: 'refresh' })
    const definitions = new Map<string, unknown>()
    for (const tool of response.tools) {
      const name = publicToolName(this.name, tool.name)
      if (definitions.has(name)) throw new Error(`server listed tool "${tool.name}" more than once`)
      definitions.set(
        name,
        createMcpToolDefinition(this.ctx as never, {
          name,
          rawName: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          taskRequired: tool.execution?.taskSupport === 'required',
          call: (args: unknown, execution: { signal: AbortSignal }) => this.callTool(tool, args, execution),
        } as never),
      )
    }
    this.unregisterAll()
    const next = new Map<string, () => void>()
    try {
      for (const [name, definition] of definitions) next.set(name, this.register(definition))
    } catch (error) {
      for (const dispose of next.values()) {
        try {
          dispose()
        } catch {
          /* gone */
        }
      }
      // The scope already holds that name (another server, plugin or a leftover
      // registration): trying again cannot help, so this attempt is final.
      throw Object.assign(new Error(`tool registration failed: ${errorText(error)}`), { permanent: true })
    }
    this.disposers = next
  }

  /** Calls always go to the current connection; a transport-level failure marks it lost. */
  async callTool(tool: RawTool, args: unknown, execution: { signal: AbortSignal }): Promise<unknown> {
    const gen = this.gen
    if (gen === undefined || this.state !== 'connected') {
      throw new Error(
        `MCP server "${this.name}" is not connected (${this.state}${this.lastError !== undefined ? `: ${this.lastError.message}` : ''})`,
      )
    }
    try {
      return await (gen.client as ClientLike).callTool(
        { name: tool.name, arguments: args },
        { signal: execution.signal, timeout: this.timeoutMs, toolDefinition: tool },
      )
    } catch (error) {
      if (!execution.signal?.aborted && !(error instanceof ProtocolError) && isConnectionError(error)) {
        this.lost(gen, error)
      }
      throw error
    }
  }

  /**
   * Confirm a connected server still answers (`ping`, 5s). Only a transport
   * failure marks it lost: a JSON-RPC error answer proves the connection, and a
   * timeout or an unsupported ping leaves the state as it is.
   */
  async check(): Promise<void> {
    const gen = this.gen
    if (gen === undefined || this.state !== 'connected') return
    try {
      await (gen.client as ClientLike).ping({ timeout: CHECK_TIMEOUT_MS })
      this.checkedAt = this.now()
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.checkedAt = this.now()
        return
      }
      if (isConnectionError(error)) this.lost(gen, error)
    }
  }

  unregisterAll(): void {
    for (const dispose of this.disposers.values()) {
      try {
        dispose()
      } catch {
        /* gone */
      }
    }
    this.disposers = new Map()
  }

  /** MCP resources for `ctx.mcpResources` (same contract as the official provider). */
  get resources(): { request(request: ResourceRequest, exec: ResourceExec): Promise<unknown> } {
    return {
      request: async (request: ResourceRequest, exec: ResourceExec) => {
        const gen = this.gen
        if (gen === undefined || this.state !== 'connected') {
          throw new Error(`MCP server "${this.name}" is not connected`)
        }
        const client = gen.client as ClientLike
        const options = { signal: exec.signal, timeout: this.timeoutMs }
        switch (request.method) {
          case 'resources/list':
            return client.listResources(
              request.cursor === undefined ? undefined : { cursor: request.cursor },
              options,
            )
          case 'resources/templates/list':
            return client.listResourceTemplates(
              request.cursor === undefined ? undefined : { cursor: request.cursor },
              options,
            )
          case 'resources/read':
            return client.readResource({ uri: request.uri }, options)
          default:
            throw new Error(`unsupported resource request ${request.method}`)
        }
      },
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.state = 'stopped'
    this.instructions = ''
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    const gen = this.gen
    this.gen = undefined
    if (gen !== undefined) await this.closeGen(gen)
    await this.settling
    await this.syncChain
    this.unregisterAll()
    this.listeners.clear()
  }
}

/**
 * The message of a thrown value, with the first errno-style code found up to
 * three `cause` links deep appended (`fetch failed (ECONNREFUSED)`). The code
 * is what tells a dead connection apart from a refused request.
 */
function errorText(error: unknown): string {
  const text = String((error as { message?: unknown } | undefined)?.message ?? error)
  let cause = (error as { cause?: { code?: unknown; cause?: unknown } } | undefined)?.cause
  for (let i = 0; cause !== undefined && i < 3; i++, cause = cause.cause as typeof cause) {
    if (typeof cause.code === 'string' && !text.includes(cause.code)) return `${text} (${cause.code})`
  }
  return text
}

/**
 * Whether a failed request means the connection itself is gone (as opposed to a
 * JSON-RPC error answer or a timeout). Decided from the SDK's typed error codes
 * and Node's network error codes, never from message text.
 */
const LOST_CODES: ReadonlySet<string> = new Set([
  'CONNECTION_CLOSED',
  'NOT_CONNECTED',
  'SEND_FAILED',
  'CLIENT_HTTP_AUTHENTICATION',
  'CLIENT_HTTP_FORBIDDEN',
  'CLIENT_HTTP_FAILED_TO_OPEN_STREAM',
])
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

/** Reads a numeric or nested `code` off a thrown value. */
interface CodedError {
  code?: unknown
  cause?: CodedError
}

export function isConnectionError(error: unknown): boolean {
  const e = error as CodedError | undefined
  const code = e?.code
  if (typeof code === 'string' && LOST_CODES.has(code)) return true
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true
  const cause = e?.cause?.code
  if (typeof cause === 'string' && NETWORK_CODES.has(cause)) return true
  const nested = e?.cause?.cause?.code
  return typeof nested === 'string' && NETWORK_CODES.has(nested)
}
