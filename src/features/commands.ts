// Project slash commands backed by a JS handler file in the workspace.
//
// Official interface relied on (@deepseek-ai/dsh-commands):
// `ctx.commands.register({ name, description, input?, handler })`; registered through
// an agent-scoped context the command is visible to that agent only. The handler
// receives `{ commandId, agent, rawInput, attachments, signal }` and returns
// `{ kind: 'success', text? } | { kind: 'error', text }`; results are UI-only.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandSpec } from '../settings.js'

/** What a project handler may return; `normalizeResult` accepts anything. */
export type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** The log surface commands write through. */
interface CommandLog {
  warn(message: string): void
}

/** What a project handler receives. */
export interface HandlerInvocation {
  agent: unknown
  rawInput: unknown
  attachments: unknown
  signal: unknown
  workspaceRoot: string
}

/** A project handler: may throw, may return anything `normalizeResult` accepts. */
export type CommandHandler = (invocation: HandlerInvocation) => unknown

/** One command to register: the validated entry plus where its handler lives. */
export interface LoadedCommand {
  entry: CommandSpec
  realPath: string
}

/** What `mountCommands` needs besides the agent context. */
export interface CommandMountOptions {
  root: string
  log: CommandLog
  label: string
}

/** `kind` of a value the handler returned, if it declared one. */
interface DeclaredResult {
  kind?: unknown
  text?: unknown
}

/** Normalize whatever a project handler returned into a CommandResult. */
export function normalizeResult(value: unknown): CommandResult {
  if (value === undefined || value === null) return { kind: 'success' }
  if (typeof value === 'string') return { kind: 'success', text: value }
  if (typeof value === 'object') {
    const declared = value as DeclaredResult
    if (declared.kind === 'success' || declared.kind === 'error') {
      const text = declared.text === undefined ? undefined : String(declared.text)
      if (declared.kind === 'error') {
        return { kind: 'error', text: text !== undefined && text.trim() !== '' ? text : 'command failed' }
      }
      return text === undefined ? { kind: 'success' } : { kind: 'success', text }
    }
    return { kind: 'success', text: JSON.stringify(value, null, 2) }
  }
  return { kind: 'success', text: String(value) }
}

/** The module shapes a handler file may export. */
interface HandlerModule {
  default?: unknown
  handler?: unknown
}

/** Import a handler file, reloading when its modification time changes. */
export async function loadHandler(realPath: string): Promise<CommandHandler> {
  const st = await fs.promises.stat(realPath)
  const mod = (await import(`${pathToFileURL(realPath).href}?mtime=${st.mtimeMs}`)) as HandlerModule
  const dflt = mod.default as (HandlerModule & { handler?: unknown }) | undefined
  if (typeof mod.default === 'function') return mod.default as CommandHandler
  if (typeof mod.handler === 'function') return mod.handler as CommandHandler
  if (typeof dflt?.handler === 'function') return dflt.handler as CommandHandler
  throw new Error('handler file must export a default function or `handler`')
}

/** The invocation `ctx.commands.register` delivers to a handler. */
interface RegisteredInvocation {
  agent?: unknown
  rawInput?: unknown
  attachments?: unknown
  signal?: unknown
}

/** The registration option shape this module fills. */
interface Registration {
  name: string
  description: string
  input?: { hint: string; attachments?: boolean }
  handler: (invocation: RegisteredInvocation) => Promise<CommandResult>
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | undefined)?.message ?? error)
}

/**
 * Register commands on a root agent scope.
 */
export function mountCommands(
  agentCtx: Context,
  specs: readonly LoadedCommand[],
  { root, log, label }: CommandMountOptions,
): { dispose(): unknown } | undefined {
  if (specs.length === 0) return undefined
  return agentCtx.inject(['commands'], (c) => {
    for (const { entry, realPath } of specs) {
      try {
        c.commands.register({
          name: entry.name,
          description: entry.description,
          ...(entry.input !== undefined ? { input: entry.input } : {}),
          handler: async (invocation: RegisteredInvocation) => {
            try {
              const fn = await loadHandler(realPath)
              return normalizeResult(
                await fn({
                  agent: invocation.agent,
                  rawInput: invocation.rawInput,
                  attachments: invocation.attachments,
                  signal: invocation.signal,
                  workspaceRoot: root,
                }),
              )
            } catch (error) {
              log.warn(`${label}: command /${entry.name} failed: ${errorMessage(error)}`)
              return { kind: 'error' as const, text: `/${entry.name}: ${errorMessage(error)}` }
            }
          },
        } satisfies Registration as never)
      } catch (error) {
        log.warn(`${label}: command /${entry.name} not registered: ${errorMessage(error)}`)
      }
    }
  }) as unknown as { dispose(): unknown }
}
