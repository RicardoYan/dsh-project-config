// `/project-config`: read-only report of what this session loaded. UI-only.
// Shows names and states only, never values from the settings (urls, headers, env).
import type { Text } from './locale.js'
import { TEXT } from './text.js'

/** One loaded subagent spec, as `index.ts` builds it. */
export interface StatusSpec {
  entry: { toolName: string; [key: string]: unknown }
  persona?: string | undefined
  description?: string | undefined
  error?: unknown
}

/** One MCP server's state as `McpHub.summary` reports it. */
export interface StatusMcpServer {
  name: string
  status: string
  detail?: string | undefined
}

/** What the hub exposes to the status text. */
export interface StatusHub {
  summary(): StatusMcpServer[]
}

/** The settings a mount reports on. */
export interface StatusSettings {
  subagents: ReadonlyArray<{ toolName: string }>
  commands: ReadonlyArray<{ name: string }>
  mcp: ReadonlyArray<{ serverName: string }>
  hooks: Record<string, ReadonlyArray<unknown>>
}

/** One entry that settings.local.yml removed. */
export interface StatusRemoval {
  kind: 'subagents' | 'commands' | 'mcp'
  name: string
}

/** Where each name came from: added or overridden by settings.local.yml. */
export type StatusOrigin = Record<string, Map<string, 'local' | 'override'> | undefined>

/** Everything `statusText` reads off a root mount. */
export interface StatusRoot {
  root: string
  file: string
  localFile?: string | undefined
  ok: boolean
  error?: unknown
  origin: StatusOrigin | undefined
  warnings: ReadonlyArray<unknown>
  subagentSpecs: ReadonlyArray<StatusSpec>
  settings: StatusSettings
  hooksLocal?: Record<string, number> | undefined
  removed?: ReadonlyArray<StatusRemoval> | undefined
  stats?: { runs: number; failures: number } | undefined
  hub?: StatusHub | undefined
}

/** A root mount, or a child mount that points at its root. */
export interface StatusMount extends Partial<StatusRoot> {
  rootMount?: StatusRoot | undefined
  toolName?: string | undefined
  subagents?: ReadonlyArray<StatusSpec> | undefined
}

/** Services `statusText` needs besides the mount. */
export interface StatusDeps {
  logFile: string
}

/** Index the mode tables by a value that may not be a known key. */
function lookup<V>(table: Record<string, V>, key: unknown): V | undefined {
  return typeof key === 'string' ? table[key] : undefined
}

/** Name plus its settings.local.yml mark: `knot (local)` / `knot (local override)`. */
function marked(root: StatusRoot, kind: string, name: string, shown: string = name): string {
  // `origin` itself may be absent on a mount built before the merge existed.
  const o = root.origin?.[kind]?.get(name)
  if (o === 'local') return `${shown} ${TEXT.fromLocal}`
  if (o === 'override') return `${shown} ${TEXT.overriddenByLocal}`
  return shown
}

export function statusText(mount: StatusMount | undefined, { logFile }: StatusDeps): string {
  if (mount === undefined) return String(TEXT.noSettings)
  const root: StatusRoot = mount.rootMount ?? (mount as StatusRoot)
  // Mixed on purpose: bilingual `Text` values and already-rendered strings share
  // one array; `join` renders both.
  const lines: Array<Text | string> = []
  if (mount.rootMount) lines.push(TEXT.subagentSession(mount.toolName as string))
  lines.push(TEXT.workspace(root.root))
  lines.push(TEXT.settingsFile(root.localFile ? `${root.file} + ${root.localFile}` : root.file))
  if (!root.ok) {
    lines.push(`✗ ${root.error}`)
    return lines.join('\n')
  }
  const subs = mount.rootMount ? (mount.subagents ?? []) : root.subagentSpecs
  lines.push(
    TEXT.subagents(
      subs.length
        ? subs
            .map((s) => marked(root, 'subagents', s.entry.toolName) + (s.error ? ` ✗ ${s.error}` : ''))
            .join(', ')
        : '—',
    ),
  )
  if (root.settings.commands.length > 0) {
    lines.push(
      TEXT.commands(
        root.settings.commands.map((c) => marked(root, 'commands', c.name, `/${c.name}`)).join(', '),
        mount.rootMount !== undefined,
      ),
    )
  }
  if (root.settings.mcp.length > 0) {
    const servers = root.hub?.summary()
    if (servers === undefined || servers.length === 0) {
      lines.push(TEXT.mcp(root.settings.mcp.map((m) => marked(root, 'mcp', m.serverName)).join(', ')))
    } else {
      for (const s of servers) {
        lines.push(TEXT.mcpServer(marked(root, 'mcp', s.name), lookup(TEXT.mcpState, s.status) ?? s.status, s.detail))
      }
    }
  }
  const hookEvents = Object.entries(root.settings.hooks)
  if (hookEvents.length > 0) {
    lines.push(
      TEXT.hooks(
        hookEvents
          .map(([e, l]) => `${e} ×${l.length}${root.hooksLocal?.[e] ? TEXT.hooksLocal(root.hooksLocal[e]) : ''}`)
          .join(', '),
        root.stats ?? { runs: 0, failures: 0 },
      ),
    )
  }
  if (root.removed !== undefined && root.removed.length > 0) {
    lines.push(
      TEXT.removed(
        root.removed
          .map((r) => `${lookup(TEXT.kind, r.kind) ?? r.kind} ${r.kind === 'commands' ? '/' : ''}${r.name}`)
          .join(', '),
      ),
    )
  }
  for (const w of root.warnings) lines.push(`⚠ ${w}`)
  lines.push(TEXT.log(logFile))
  return lines.join('\n')
}

/** `/project-config reload mcp`: one line per server, in its current state. */
export function mcpStateText(root: StatusRoot, names: readonly string[]): string {
  const byName = new Map((root.hub?.summary() ?? []).map((x) => [x.name, x]))
  return names
    .map((n) => {
      const x = byName.get(n)
      return String(
        TEXT.mcpServer(marked(root, 'mcp', n), lookup(TEXT.mcpState, x?.status) ?? x?.status ?? '', x?.detail),
      )
    })
    .join('\n')
}
