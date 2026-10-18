// Project MCP servers: one connection per root session, shared with its subagents.
//
// Connections are owned here (features/mcp-connection.ts) rather than by the
// official dsh-mcp-client plugin, which keeps its connection state private:
// /project-config shows the real state and `/project-config reconnect` restarts
// a server in the running session.
// Tools are registered on the root agent's scope (`ctx.tools.register`) and
// mirrored into subagent scopes, where calls still go through the root's
// connection. Server instructions and resources use the same official seams as
// dsh-mcp-client: `systemPrompt.section` (order MCP_SERVERS) and
// `mcpResources.register(server, provider)`.
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Text } from '../locale.js'
import { expandVars, type McpSpec } from '../settings.js'
import { TEXT } from '../text.js'
import { McpConnection, type ServerConfig } from './mcp-connection.js'
import { admits } from './subagents.js'

const MASK = '***'
const MIN_SECRET = 4
const SCHEMES: ReadonlySet<string> = new Set(['bearer', 'basic', 'token', 'digest'])

/** The log surface the hub writes through. */
export interface HubLog {
  info(message: string): void
  warn(message: string): void
}

/** A tool definition as the registry accepts one. */
interface ToolDefinition {
  name: string
  [key: string]: unknown
}

/** The `tools` service the hub registers into. */
interface ToolsLike {
  register(definition: unknown): () => void
}

/** A path check, as `WorkspaceFacade.checkTarget` provides it. */
export type CheckTarget = (
  root: string,
  rel: string,
  opts?: { type?: 'file' | 'directory'; maxBytes?: number },
) => Promise<{ ok: true; realPath: string } | { ok: false; code: string; message: Text }>

/** What resolving one settings entry produced. */
export type ResolvedServer = { config: ServerConfig } | { error: Text }

/** What `summary()` reports for one server. */
export interface McpServerSummary {
  name: string
  status: string
  detail: string | Text | undefined
}

/** One server's registry record. */
interface ServerRecord {
  connection: McpConnection | undefined
  skipped: string | undefined
}

/** A live tool mirrored into a subagent scope. */
interface MirrorRecord {
  definition: ToolDefinition
  dispose: () => void
}

/** One subagent scope's mirror. */
interface Mirror {
  sync(): void
}

/**
 * Strings that must not reach logs or /project-config: every header and env
 * value, the url, and the parts of each (`Bearer <token>` -> the token; the
 * url's userinfo and query values), longest first.
 */
export function secretsOf(config: ServerConfig): string[] {
  const out = new Set<string>()
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.length >= MIN_SECRET) out.add(v)
  }
  const addParts = (v: unknown): void => {
    add(v)
    for (const part of String(v ?? '').split(/\s+/)) {
      if (!SCHEMES.has(part.toLowerCase())) add(part)
    }
  }
  for (const v of Object.values(config.headers ?? {})) addParts(v)
  for (const v of Object.values(config.env ?? {})) addParts(v)
  if (typeof config.url === 'string') {
    add(config.url)
    try {
      const u = new URL(config.url)
      add(u.href)
      add(u.origin + u.pathname)
      add(u.host)
      add(u.hostname)
      add(decodeURIComponent(u.username))
      add(decodeURIComponent(u.password))
      for (const v of u.searchParams.values()) add(v)
    } catch {
      /* not a URL: the whole string is masked */
    }
  }
  return [...out].sort((a, b) => b.length - a.length)
}

/** Replace every secret in `text` with `***`. */
export function redact(text: unknown, secrets: readonly string[]): string {
  let out = String(text)
  for (const s of secrets) out = out.split(s).join(MASK)
  return out
}

/** Resolve one settings entry into an official client config (or a skip reason). */
export async function resolveServerConfig(
  entry: McpSpec,
  root: string,
  checkTarget: CheckTarget,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedServer> {
  const missing = new Set<string>()
  const exp = (s: unknown): string => {
    // The original passed the raw value; `expandVars` stringifies it itself.
    const r = expandVars(s as string, env)
    if ('missing' in r) {
      r.missing.forEach((m) => missing.add(m))
      return ''
    }
    return r.value
  }
  const cfg: ServerConfig = { serverName: entry.serverName, transport: entry.transport }
  for (const key of ['toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect'] as const) {
    if (entry[key] !== undefined) (cfg as unknown as Record<string, unknown>)[key] = entry[key]
  }
  if (entry.transport === 'stdio') {
    cfg.command = exp(entry.command)
    cfg.args = (entry.args ?? []).map(exp)
    cfg.env = Object.fromEntries(Object.entries(entry.env ?? {}).map(([k, v]) => [k, exp(v)]))
    if (entry.cwd !== undefined) {
      const checked = await checkTarget(root, entry.cwd, { type: 'directory' })
      if (!checked.ok) return { error: TEXT.cwdProblem(checked.message) }
      cfg.cwd = checked.realPath
    } else cfg.cwd = root
  } else {
    cfg.url = exp(entry.url)
    cfg.headers = Object.fromEntries(Object.entries(entry.headers ?? {}).map(([k, v]) => [k, exp(v)]))
  }
  if (missing.size > 0) return { error: TEXT.envMissing([...missing].join(', ')) }
  return { config: cfg }
}

/**
 * Connections of one root session.
 * `summary()`: [{ name, status, detail }] for /project-config, computed when shown.
 */
export class McpHub {
  readonly log: HubLog
  readonly label: string
  /** public tool name -> definition */
  readonly live = new Map<string, ToolDefinition>()
  /** serverName -> { connection?, skipped? } */
  readonly servers = new Map<string, ServerRecord>()
  readonly mirrors = new Set<Mirror>()
  ready: Promise<void> = Promise.resolve()
  disposed = false
  scheduled = false

  constructor(log: HubLog, label: string) {
    this.log = log
    this.label = label
  }

  /**
   * Start every server under the root agent scope. Returns the owning fiber;
   * `this.ready` settles when every server finished its first attempt.
   */
  start(
    agentCtx: Context,
    entries: readonly McpSpec[],
    resolveEntry: (entry: McpSpec) => Promise<ResolvedServer>,
    connectionOpts: Record<string, unknown> = {},
  ): { dispose(): unknown } | undefined {
    let release: (() => void) | undefined
    this.ready = new Promise<void>((r) => {
      release = r
    })
    return agentCtx.inject(['tools'], (c) => {
      c.effect(() => () => this.disposeAll(), 'project-config: mcp connections')
      void this.startIn(c, entries, resolveEntry, connectionOpts).then(release, release)
    }) as unknown as { dispose(): unknown } | undefined
  }

  startIn(
    c: Context,
    entries: readonly McpSpec[],
    resolveEntry: (entry: McpSpec) => Promise<ResolvedServer>,
    connectionOpts: Record<string, unknown> = {},
  ): Promise<void> {
    const pending = entries.map(async (entry) => {
      const name = entry.serverName
      const record: ServerRecord = { connection: undefined, skipped: undefined }
      this.servers.set(name, record)
      const resolved = await resolveEntry(entry)
      if (this.disposed) return
      if ('error' in resolved) {
        record.skipped = String(resolved.error)
        this.log.warn(`${this.label}: mcp ${name} skipped: ${record.skipped}`)
        return
      }
      // Errors may quote the url or echo a header (an HTTP error body, a server
      // message): mask before they reach the log or the status.
      const secrets = secretsOf(resolved.config)
      const clean = (t: string): string => redact(t, secrets)
      let connection: McpConnection
      try {
        connection = new McpConnection(resolved.config, {
          ctx: c,
          register: (definition) =>
            this.track(definition as ToolDefinition, (d) => (c.tools as unknown as ToolsLike).register(d)),
          log: {
            info: (t: string) => this.log.info(`${this.label}: ${clean(t)}`),
            warn: (t: string) => this.log.warn(`${this.label}: ${clean(t)}`),
          },
          clean,
          ...connectionOpts,
        })
      } catch (error) {
        record.skipped = String((error as { message?: unknown } | undefined)?.message ?? error)
        this.log.warn(`${this.label}: mcp ${name} skipped: ${record.skipped}`)
        return
      }
      record.connection = connection
      // Both services are optional: a composition without them keeps the tools.
      ;(c as unknown as {
        inject?(deps: string[], cb: (inner: { mcpResources: { register(n: string, r: unknown): void } }) => void): void
      }).inject?.(['mcpResources'], (inner) => {
        inner.mcpResources.register(name, connection.resources)
      })
      ;(c as unknown as {
        inject?(
          deps: string[],
          cb: (inner: {
            systemPrompt: {
              section(o: { name: string; order: number; interpolate: boolean; text: () => string }): void
              getSectionOrder(n: string): number
            }
          }) => void,
        ): void
      }).inject?.(['systemPrompt'], (inner) => {
        inner.systemPrompt.section({
          name: `mcp:${name}`,
          order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
          interpolate: false,
          text: () => connection.instructions,
        })
      })
      await connection.start()
    })
    return Promise.allSettled(pending).then(() => {})
  }

  /** Ping every connected server so the status reflects servers that went away silently. */
  async checkAll(): Promise<void> {
    await Promise.allSettled([...this.servers.values()].map((r) => r.connection?.check()))
  }

  /**
   * Reconnect one server (any state) or, without a name, every server that is not connected.
   * @returns the names reconnected, or undefined when `name` is unknown.
   */
  async reconnect(name: string | undefined): Promise<string[] | undefined> {
    let targets: McpConnection[]
    if (name !== undefined) {
      const record = this.servers.get(name)
      if (record === undefined) return undefined
      targets = record.connection !== undefined ? [record.connection] : []
    } else {
      targets = [...this.servers.values()]
        .map((r) => r.connection)
        .filter((x): x is McpConnection => x !== undefined && x.state !== 'connected')
    }
    await Promise.allSettled(targets.map((x) => x.reconnect()))
    return targets.map((x) => x.name)
  }

  async disposeAll(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.servers.values()].map((r) => r.connection?.dispose()))
  }

  track(definition: ToolDefinition, register: (d: unknown) => () => void): () => void {
    const dispose = register(definition)
    this.live.set(definition.name, definition)
    this.notify()
    let done = false
    return () => {
      if (done) return
      done = true
      if (this.live.get(definition.name) === definition) this.live.delete(definition.name)
      this.notify()
      return dispose()
    }
  }

  notify(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      for (const m of this.mirrors) m.sync()
    })
  }

  /** Mirror this hub's tools into a subagent scope, filtered by `filter`. */
  mirror(
    childCtx: Context,
    filter: { allow?: string[]; deny?: string[] } | undefined,
  ): { dispose(): unknown } | undefined {
    const hub = this
    const registered = new Map<string, MirrorRecord>()
    let tools: ToolsLike | undefined
    const m: Mirror = {
      sync(): void {
        if (tools === undefined) return
        for (const [name, r] of registered) {
          if (hub.live.get(name) !== r.definition || !admits(filter, name)) {
            registered.delete(name)
            try {
              r.dispose()
            } catch {
              /* already gone */
            }
          }
        }
        for (const [name, definition] of hub.live) {
          if (registered.has(name) || !admits(filter, name)) continue
          try {
            registered.set(name, { definition, dispose: tools.register(definition) })
          } catch (error) {
            hub.log.warn(
              `${hub.label}: mirror ${name} failed: ${String((error as { message?: unknown } | undefined)?.message ?? error)}`,
            )
          }
        }
      },
    }
    const fiber = childCtx.inject(['tools'], (c) => {
      tools = c.tools as unknown as ToolsLike
      hub.mirrors.add(m)
      m.sync()
      c.effect(
        () => () => {
          hub.mirrors.delete(m)
          for (const r of registered.values()) {
            try {
              r.dispose()
            } catch {
              /* gone */
            }
          }
          registered.clear()
          tools = undefined
        },
        'project-config: mcp mirror',
      )
    })
    return fiber as unknown as { dispose(): unknown } | undefined
  }

  summary(): McpServerSummary[] {
    return [...this.servers.entries()].map(([name, r]) => {
      if (r.skipped !== undefined || r.connection === undefined) {
        return { name, status: 'skipped', detail: r.skipped }
      }
      const st = r.connection.status()
      let detail: string | Text | undefined
      if (st.state === 'connected') detail = TEXT.tools(st.tools)
      else if (st.state === 'retrying' || st.state === 'reconnecting') {
        detail = TEXT.mcpRetry(st.error, st.attempt ?? { n: 0, max: 0 })
      } else if (st.state === 'failed') detail = st.error
      return { name, status: st.state, detail }
    })
  }
}

export const relativeToRoot = (root: string, p: string): string => path.relative(root, p) || '.'
