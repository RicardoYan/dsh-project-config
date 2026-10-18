// Project hooks keyed by DSH event names, run with the official hook protocol.
//
// Official interfaces relied on:
// - @deepseek-ai/dsh-hook-protocol: runHook, matchesMatcher, matcherDiagnostic,
//   mergeHookOutputs (exit 2 blocks with stderr; JSON stdout may carry decisions).
//   DSH 0.2.1 stopped shipping this package with the desktop app (the hook bridges
//   moved to devDependencies), so it is a `dependencies` entry here, not a peer;
//   its API is unchanged between 0.2.0-rc.2 and 0.2.1-rc.1.
// - extension points (same signatures the official claude-code bridge uses):
//   `tools/pre-execute(exec, next)` -> {kind:'deny'|'ask'} or next();
//   `tools/post-execute(exec, result, next)` -> {kind:'block', feedback, additionalContexts?} or next();
//   `agent/pre-step({agent, messages, turn, signal}, next)` -> {kind:'reject'} or next();
//   `agent/turn-stopping({agent, turn, signal})` (serial).
// Listeners are registered on the agent's scoped context, so they only see that agent.
import type { Context } from '@deepseek-ai/cordis'
import type { Text } from '../locale.js'
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  matcherDiagnostic,
  matchesMatcher,
  mergeHookOutputs,
  runHook,
  type CommandHook,
  type HookOutput,
  type MatcherMode,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { HookMap, HookSpec } from '../settings.js'
import { TEXT } from '../text.js'

const MODE: MatcherMode = 'claude-code'
// The plugin's own message source. It is deliberately outside the official
// MessageSourceMap union — the JS original shipped exactly this value, and
// narrowing it here would change what the message carries.
const SOURCE = { kind: 'plugin:dsh-project-config' } as unknown as Parameters<typeof createUserMessage>[0]['source']

/** Per-session hook counters shown by `/project-config`. */
export interface HookStats {
  runs: number
  failures: number
}

/** The log surface hooks write through. */
interface HookLog {
  info(message: string): void
  warn(message: string): void
}

/** What `mountHooks` needs besides the agent context. */
export interface HookMountOptions {
  hooks: HookMap
  root: string
  log: HookLog
  label: string
  stats: HookStats
}

/** What `runLifecycleHook` needs; counters are not part of it. */
export interface LifecycleHookOptions {
  hooks: HookMap
  root: string
  log: HookLog
  label: string
}

/** A shell service as the hook runner calls it. */
interface ShellLike {
  resolve(request: { command: string; [key: string]: unknown }): unknown
  execute(spec: unknown): unknown
}

/** One message content block, as the hook payload reads it. */
interface ContentBlock {
  type?: string
  text?: string
}

/** An agent as hooks read it; the real object is wider. */
export interface HookAgent {
  readonly id: string
  readonly session?: { readonly header?: { readonly cwd?: string } }
  steer?(message: unknown): void
  inject?(message: unknown): void
}

/** A tool execution, as `tools/pre-execute` and `tools/post-execute` deliver it. */
interface ToolExec {
  name: string
  agent: HookAgent | undefined
  arguments: unknown
  callId: string
  signal?: AbortSignal
}

/** Result of one downstream `next()` on `tools/post-execute`. */
interface PostExecResult {
  additionalContexts?: unknown[]
  [key: string]: unknown
}

/** The `agent/pre-step` payload hooks read. */
interface PreStepEventLike {
  agent: HookAgent
  messages?: ReadonlyArray<{ content?: ContentBlock[] | undefined }>
  signal?: AbortSignal
}

/** What `next()` may return on `agent/pre-step`. */
interface PreStepOutcome {
  kind?: string
  messages?: unknown[]
  [key: string]: unknown
}

/** The `subagent/start` and `subagent/end` payloads. */
interface SubagentInfo {
  id: string
  provider: string
  stopReason?: string
}

/** Drop hook entries whose matcher is an invalid regex; returns warnings. */
export function validateHookMatchers(hooks: HookMap): { hooks: HookMap; warnings: Text[] } {
  const warnings: Text[] = []
  const out: HookMap = {}
  for (const [event, list] of Object.entries(hooks)) {
    const kept = list.filter((h, i) => {
      const d = matcherDiagnostic(h.matcher, MODE)
      if (d !== undefined) warnings.push(TEXT.invalidMatcher(`hooks.${event}[${i}]`, d))
      return d === undefined
    })
    if (kept.length > 0) out[event] = kept
  }
  return { hooks: out, warnings }
}

const textOf = (content: readonly ContentBlock[] | undefined): string =>
  (content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('')

const contextMessage = (texts: string[]): unknown =>
  createUserMessage({ content: texts.map((text) => ({ type: 'text', text })), source: SOURCE })

/**
 * On Windows `ctx.shell` runs `powershell -Command <text>`, whose own exit code
 * is 1 whenever the last native program failed, so a hook's exit 2 would never
 * reach the protocol. Forward the program's real exit code explicitly.
 */
export function forwardExitCode(command: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return command
  return `${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`
}

/** Session-policy-aware view of `ctx.shell` (the bridge default would use the deployment policy). */
function shellFor(ctx: Context, agent: HookAgent | undefined): ShellLike | undefined {
  const shell = ctx.get('shell') as ShellLike | undefined
  if (shell === undefined) return undefined
  const policy = ctx.get('sandboxPolicy') as
    | { resolve(request: { session: unknown }): unknown }
    | undefined
  return {
    resolve: (request) =>
      shell.resolve({
        ...request,
        command: forwardExitCode(request.command),
        ...(policy !== undefined && agent !== undefined
          ? { sandboxPolicy: policy.resolve({ session: agent.session }) }
          : {}),
      }),
    execute: (spec) => shell.execute(spec),
  }
}

/** One event's hooks, run in order; the merged protocol outcome. */
async function runPoint(
  ctx: Context,
  opts: HookMountOptions,
  event: string,
  query: string,
  agent: HookAgent | undefined,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<MergedHookOutcome> {
  const outputs: HookOutput[] = []
  for (const hook of opts.hooks[event] ?? []) {
    if (!matchesMatcher(hook.matcher, query, MODE)) continue
    const shell = shellFor(ctx, agent)
    if (shell === undefined) {
      opts.log.warn(`${opts.label}: hooks skipped, no shell service`)
      break
    }
    const { output, durationMs } = await runHook(
      shell as never,
      {
        command: hook.command,
        ...(hook.timeout !== undefined ? { timeoutSec: hook.timeout } : {}),
      } satisfies CommandHook,
      {
        payload: {
          event,
          session_id: agent?.id ?? '',
          cwd: agent?.session?.header?.cwd ?? opts.root,
          workspace_root: opts.root,
          ...payload,
        },
        defaultTimeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
        env: { DSH_PROJECT_DIR: opts.root },
        cwd: opts.root,
        signal,
        trailingNewline: true,
      },
      () => performance.now(),
    )
    outputs.push(output)
    opts.stats.runs++
    if (output.exitCode !== 0) {
      opts.stats.failures += output.exitCode === 2 ? 0 : 1
      opts.log.info(
        `${opts.label}: hook ${event} "${hook.command}" exit=${output.exitCode ?? 'none'} ${Math.round(durationMs)}ms${output.stderr ? ` stderr=${output.stderr.slice(0, 300)}` : ''}`,
      )
    }
  }
  return mergeHookOutputs(outputs)
}

/**
 * Register hooks on one agent scope.
 * @param agentCtx - the agent's scoped context.
 * @returns the owning fiber.
 */
export function mountHooks(
  agentCtx: Context,
  opts: HookMountOptions,
): { dispose(): unknown } | undefined {
  const { hooks } = opts
  const events = Object.keys(hooks)
  if (events.length === 0) return undefined
  return agentCtx.inject([], (c) => {
    const inflight = new Set<Promise<unknown>>()
    const lifetime = new AbortController()
    c.effect(
      () => () => {
        lifetime.abort(new Error('project hooks disposed'))
      },
      'project-config: hooks',
    )

    const run = (
      event: string,
      query: string,
      agent: HookAgent | undefined,
      payload: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ): Promise<MergedHookOutcome> =>
      runPoint(c, opts, event, query, agent, payload, signal ?? lifetime.signal)

    const detached = (
      event: string,
      query: string,
      agent: HookAgent | undefined,
      payload: Record<string, unknown>,
    ): void => {
      const pending = run(event, query, agent, payload, lifetime.signal).catch((error: unknown) =>
        opts.log.warn(`${opts.label}: hook ${event} failed: ${errorMessage(error)}`),
      )
      inflight.add(pending)
      void pending.finally(() => inflight.delete(pending))
    }

    if (hooks['tools/pre-execute'] !== undefined) {
      ;(c as unknown as {
        on(event: string, cb: (exec: ToolExec, next: () => unknown) => Promise<unknown>): void
      }).on('tools/pre-execute', async (exec, next) => {
        const merged = await run(
          'tools/pre-execute',
          exec.name,
          exec.agent,
          { tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId },
          exec.signal,
        )
        if (merged.decision === 'deny') {
          return { kind: 'deny', reason: merged.reason ?? 'blocked by project hook (tools/pre-execute)' }
        }
        if (merged.decision === 'ask') {
          return { kind: 'ask', ...(merged.reason !== undefined ? { reason: merged.reason } : {}) }
        }
        return next()
      })
    }
    if (hooks['tools/post-execute'] !== undefined) {
      ;(c as unknown as {
        on(
          event: string,
          cb: (exec: ToolExec, result: { content?: ContentBlock[] }, next: () => Promise<PostExecResult>) => Promise<unknown>,
        ): void
      }).on('tools/post-execute', async (exec, result, next) => {
        const merged = await run(
          'tools/post-execute',
          exec.name,
          exec.agent,
          {
            tool_name: exec.name,
            tool_input: exec.arguments,
            tool_use_id: exec.callId,
            tool_response: textOf(result.content),
          },
          exec.signal,
        )
        const extra = merged.additionalContext.length > 0 ? contextMessage(merged.additionalContext) : undefined
        if (merged.decision === 'deny') {
          return {
            kind: 'block',
            feedback: [{ type: 'text', text: merged.reason ?? 'blocked by project hook (tools/post-execute)' }],
            ...(extra !== undefined ? { additionalContexts: [extra] } : {}),
          }
        }
        const downstream = await next()
        if (extra === undefined) return downstream
        return { ...downstream, additionalContexts: [extra, ...(downstream.additionalContexts ?? [])] }
      })
    }
    if (hooks['agent/pre-step'] !== undefined) {
      ;(c as unknown as {
        on(event: string, cb: (ev: PreStepEventLike, next: () => Promise<PreStepOutcome>) => Promise<unknown>): void
      }).on('agent/pre-step', async (ev, next) => {
        if (ev.messages === undefined || ev.messages.length === 0) return next()
        const merged = await run(
          'agent/pre-step',
          '',
          ev.agent,
          { prompt: textOf(ev.messages.flatMap((m) => m.content ?? [])) },
          ev.signal,
        )
        if (merged.decision === 'deny') return { kind: 'reject' }
        const downstream = await next()
        if (merged.additionalContext.length === 0 || downstream.kind !== 'enter') return downstream
        return { ...downstream, messages: [...(downstream.messages ?? []), contextMessage(merged.additionalContext)] }
      })
    }
    if (hooks['agent/turn-stopping'] !== undefined) {
      ;(c as unknown as {
        on(event: string, cb: (ev: { agent: HookAgent; signal?: AbortSignal }) => Promise<void>): void
      }).on('agent/turn-stopping', async ({ agent, signal }) => {
        const merged = await run('agent/turn-stopping', '', agent, {}, signal)
        if (merged.decision === 'deny') {
          agent.steer?.(
            createUserMessage({
              content: [
                {
                  type: 'text',
                  text: merged.reason ?? 'continue: blocked by project hook (agent/turn-stopping)',
                },
              ],
              source: SOURCE,
            }),
          )
        }
      })
    }
    if (hooks['subagent/start'] !== undefined) {
      ;(c as unknown as { on(event: string, cb: (info: SubagentInfo) => void): void }).on(
        'subagent/start',
        (info) => detached('subagent/start', '', undefined, { agent_id: info.id, provider: info.provider }),
      )
    }
    if (hooks['subagent/end'] !== undefined) {
      ;(c as unknown as { on(event: string, cb: (info: SubagentInfo) => void): void }).on(
        'subagent/end',
        (info) =>
          detached('subagent/end', '', undefined, {
            agent_id: info.id,
            provider: info.provider,
            stop_reason: info.stopReason,
          }),
      )
    }

    c.effect(
      () => async () => {
        await Promise.allSettled([...inflight])
      },
      'project-config: hooks drain',
    )
  }) as unknown as { dispose(): unknown }
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | undefined)?.message ?? error)
}

/** Lifecycle hooks that run outside the agent scope (created / disposed). */
export async function runLifecycleHook(
  ctx: Context,
  opts: LifecycleHookOptions,
  event: string,
  agent: HookAgent,
  extra: Record<string, unknown> = {},
): Promise<MergedHookOutcome | undefined> {
  const list = opts.hooks[event]
  if (list === undefined || list.length === 0) return undefined
  const shell = shellFor(ctx, agent)
  if (shell === undefined) return undefined
  const outputs: HookOutput[] = []
  for (const hook of list) {
    if (!matchesMatcher(hook.matcher, String(extra['source'] ?? ''), MODE)) continue
    const { output } = await runHook(
      shell as never,
      {
        command: hook.command,
        ...(hook.timeout !== undefined ? { timeoutSec: hook.timeout } : {}),
      } satisfies CommandHook,
      {
        payload: {
          event,
          session_id: agent.id,
          cwd: agent.session?.header?.cwd ?? opts.root,
          workspace_root: opts.root,
          ...extra,
        },
        defaultTimeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
        env: { DSH_PROJECT_DIR: opts.root },
        cwd: opts.root,
        signal: AbortSignal.timeout(DEFAULT_HOOK_TIMEOUT_MS),
        trailingNewline: true,
      },
      () => performance.now(),
    )
    outputs.push(output)
    if (output.exitCode !== 0) {
      opts.log.info(`${opts.label}: hook ${event} "${hook.command}" exit=${output.exitCode ?? 'none'}`)
    }
  }
  const merged = mergeHookOutputs(outputs)
  if (merged.additionalContext.length > 0 && event === 'agent/created') {
    agent.inject?.(contextMessage(merged.additionalContext))
  }
  return merged
}

export type { HookSpec }
