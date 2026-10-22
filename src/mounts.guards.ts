// Shared shapes for the per-session mounts this plugin keeps.
//
// `index.ts` builds one RootMount per top-level session and one ChildMount per
// project subagent session; both live in a WeakMap keyed by agent and are torn
// down by hand, because they are mounted on `agent.ctx` (which the plugin fiber
// does not own). These interfaces are the single description of both, so the
// `reference.js` `index.ts` commands, the lifecycle hooks and the status report
// all agree on what a mount carries.
import type { Settings, SubagentSpec, Removal } from './settings.js'
import type { HookStats } from './features/hooks.js'
import type { McpHub } from './features/mcp.js'
import type { Text } from './locale.js'

/** A disposer the plugin runs on release; `disposeFiber` normalizes it. */
export interface Disposable {
  dispose(): unknown
}

/**
 * What a feature mount returns: a fiber to dispose, or `undefined` when the
 * feature had nothing to mount (no hooks configured, no commands, …). Callers
 * push the result straight into a mount's `fibers`, so this is the element type
 * of those arrays.
 */
export type FeatureMount = Disposable | undefined

/** One listener registered on a session scope, removed on release. */
export type Unsubscribe = () => void

/** A loaded subagent spec plus where it came from. */
export interface LoadedSpec {
  entry: SubagentSpec
  persona: string
  description: string | undefined
}

/** Per-session hook counters shown by `/project-config`. */
export type Stats = HookStats

/** The claim slot laid down before the first `await`, so a re-entrant
 * `agent/created` cannot mount the same tools twice. */
export interface MountClaim {
  agent: unknown
  pending: boolean
  fibers: Array<FeatureMount>
  released?: boolean
}

/** A top-level session's mount. */
export interface RootMount {
  agent: unknown
  /** Resolved workspace root (real path). */
  root: string
  /** `[<dirname>:<last 8 of agent id>]`, prefixed to every log line. */
  label: string
  file: string
  localFile: string | undefined
  ok: boolean
  error: Text | undefined
  warnings: Text[]
  settings: Settings
  origin: Record<string, Map<string, 'local' | 'override'> | undefined>
  hooksLocal: Record<string, number> | undefined
  removed: Removal[] | undefined
  subagentSpecs: LoadedSpec[]
  subagentNames: Set<string>
  children: Set<ChildMount>
  fibers: Array<FeatureMount>
  /** Commands, MCP and hooks; mounted once, after the settings are read. */
  features: Array<FeatureMount>
  listeners: Unsubscribe[]
  hub: McpHub | undefined
  featuresMounted: boolean
  prepared: boolean
  stats: Stats
  released?: boolean
  rootMount?: undefined
}

/** A project subagent session's mount; it borrows its root's settings. */
export interface ChildMount {
  agent: unknown
  rootMount: RootMount
  toolName: string | undefined
  filter: { allow?: string[]; deny?: string[] } | undefined
  fibers: Array<FeatureMount>
  /** MCP mirror and hooks, mounted once the root's features are up. */
  features: Array<FeatureMount>
  subagents: Array<{ entry: SubagentSpec; persona: string; description: string | undefined }>
  featuresMounted?: boolean
  released?: boolean
}

/** Either kind of mount. */
export type Mount = RootMount | ChildMount

/** The options every feature mount accepts. */
export interface FeatureOptions {
  log: { info(m: string): void; warn(m: string): void; error(m: string): void }
  label: string
  isProjectName?: (name: string) => boolean
  sectionName?: string
}
