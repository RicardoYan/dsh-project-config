// Guards the type chain this plugin's Host half depends on.
//
// Two things silently degrade when a type-only dependency is missing:
// - a `declare module '@deepseek-ai/cordis'` augmentation from an uninstalled
//   package simply does not exist, so `ctx.<service>` stops being typed and
//   every call on it becomes `any` (checks pass, nothing is checked);
// - an `import type {} from 'x'` whose package is absent is an error only while
//   the specifier is still in the file — once a well-meaning cleanup drops it,
//   the augmentation is gone with no trace.
//
// The assertions below pin the augmentations this plugin relies on, so dropping
// a devDependency fails the build instead of quietly untyping the plugin.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-instructions'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-hook-protocol'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import type { McpConnection } from './features/mcp-connection.js'
import type { Settings } from './settings.js'
import type { RootMount } from './mounts.guards.js'

/** `'ANY'` when the service seat collapsed to `any` (its augmentation is gone). */
type ServiceVerdict<T> = 0 extends 1 & T ? 'ANY' : 'TYPED'

// Each of these must stay TYPED: they are the services the plugin calls.
export const agentsSeat: ServiceVerdict<Context['agents']> = 'TYPED'
export const commandsSeat: ServiceVerdict<Context['commands']> = 'TYPED'
export const toolsSeat: ServiceVerdict<Context['tools']> = 'TYPED'
export const sessionsSeat: ServiceVerdict<Context['sessions']> = 'TYPED'
// ctx.loader is reached through ctx.inject(['loader'], …) and a narrowed cast\n// (the Loader class ships without a declaration here), so it has no direct seat.

// The settings shape is read by every feature module; an `unknown` here would
// mean the parser stopped describing its own output.
export const subagentsField: keyof Settings = 'subagents'
export const hooksField: keyof Settings = 'hooks'

// A mount's identity fields, read by the status report and the release paths.
export const mountLabel: keyof RootMount = 'label'
export const mountFeatures: keyof RootMount = 'features'

// The connection's public surface, driven by the hub and the status report.
export const connectionState: keyof McpConnection = 'state'
export const connectionInstructions: keyof McpConnection = 'instructions'
