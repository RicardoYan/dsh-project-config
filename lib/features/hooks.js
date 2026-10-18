import { DEFAULT_HOOK_TIMEOUT_MS, matcherDiagnostic, matchesMatcher, mergeHookOutputs, runHook, } from '@deepseek-ai/dsh-hook-protocol';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { TEXT } from '../text.js';
const MODE = 'claude-code';
// The plugin's own message source. It is deliberately outside the official
// MessageSourceMap union — the JS original shipped exactly this value, and
// narrowing it here would change what the message carries.
const SOURCE = { kind: 'plugin:dsh-project-config' };
/** Drop hook entries whose matcher is an invalid regex; returns warnings. */
export function validateHookMatchers(hooks) {
    const warnings = [];
    const out = {};
    for (const [event, list] of Object.entries(hooks)) {
        const kept = list.filter((h, i) => {
            const d = matcherDiagnostic(h.matcher, MODE);
            if (d !== undefined)
                warnings.push(TEXT.invalidMatcher(`hooks.${event}[${i}]`, d));
            return d === undefined;
        });
        if (kept.length > 0)
            out[event] = kept;
    }
    return { hooks: out, warnings };
}
const textOf = (content) => (content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
const contextMessage = (texts) => createUserMessage({ content: texts.map((text) => ({ type: 'text', text })), source: SOURCE });
/**
 * On Windows `ctx.shell` runs `powershell -Command <text>`, whose own exit code
 * is 1 whenever the last native program failed, so a hook's exit 2 would never
 * reach the protocol. Forward the program's real exit code explicitly.
 */
export function forwardExitCode(command, platform = process.platform) {
    if (platform !== 'win32')
        return command;
    return `${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
}
/** Session-policy-aware view of `ctx.shell` (the bridge default would use the deployment policy). */
function shellFor(ctx, agent) {
    const shell = ctx.get('shell');
    if (shell === undefined)
        return undefined;
    const policy = ctx.get('sandboxPolicy');
    return {
        resolve: (request) => shell.resolve({
            ...request,
            command: forwardExitCode(request.command),
            ...(policy !== undefined && agent !== undefined
                ? { sandboxPolicy: policy.resolve({ session: agent.session }) }
                : {}),
        }),
        execute: (spec) => shell.execute(spec),
    };
}
/** One event's hooks, run in order; the merged protocol outcome. */
async function runPoint(ctx, opts, event, query, agent, payload, signal) {
    const outputs = [];
    for (const hook of opts.hooks[event] ?? []) {
        if (!matchesMatcher(hook.matcher, query, MODE))
            continue;
        const shell = shellFor(ctx, agent);
        if (shell === undefined) {
            opts.log.warn(`${opts.label}: hooks skipped, no shell service`);
            break;
        }
        const { output, durationMs } = await runHook(shell, {
            command: hook.command,
            ...(hook.timeout !== undefined ? { timeoutSec: hook.timeout } : {}),
        }, {
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
        }, () => performance.now());
        outputs.push(output);
        opts.stats.runs++;
        if (output.exitCode !== 0) {
            opts.stats.failures += output.exitCode === 2 ? 0 : 1;
            opts.log.info(`${opts.label}: hook ${event} "${hook.command}" exit=${output.exitCode ?? 'none'} ${Math.round(durationMs)}ms${output.stderr ? ` stderr=${output.stderr.slice(0, 300)}` : ''}`);
        }
    }
    return mergeHookOutputs(outputs);
}
/**
 * Register hooks on one agent scope.
 * @param agentCtx - the agent's scoped context.
 * @returns the owning fiber.
 */
export function mountHooks(agentCtx, opts) {
    const { hooks } = opts;
    const events = Object.keys(hooks);
    if (events.length === 0)
        return undefined;
    return agentCtx.inject([], (c) => {
        const inflight = new Set();
        const lifetime = new AbortController();
        c.effect(() => () => {
            lifetime.abort(new Error('project hooks disposed'));
        }, 'project-config: hooks');
        const run = (event, query, agent, payload, signal) => runPoint(c, opts, event, query, agent, payload, signal ?? lifetime.signal);
        const detached = (event, query, agent, payload) => {
            const pending = run(event, query, agent, payload, lifetime.signal).catch((error) => opts.log.warn(`${opts.label}: hook ${event} failed: ${errorMessage(error)}`));
            inflight.add(pending);
            void pending.finally(() => inflight.delete(pending));
        };
        if (hooks['tools/pre-execute'] !== undefined) {
            ;
            c.on('tools/pre-execute', async (exec, next) => {
                const merged = await run('tools/pre-execute', exec.name, exec.agent, { tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }, exec.signal);
                if (merged.decision === 'deny') {
                    return { kind: 'deny', reason: merged.reason ?? 'blocked by project hook (tools/pre-execute)' };
                }
                if (merged.decision === 'ask') {
                    return { kind: 'ask', ...(merged.reason !== undefined ? { reason: merged.reason } : {}) };
                }
                return next();
            });
        }
        if (hooks['tools/post-execute'] !== undefined) {
            ;
            c.on('tools/post-execute', async (exec, result, next) => {
                const merged = await run('tools/post-execute', exec.name, exec.agent, {
                    tool_name: exec.name,
                    tool_input: exec.arguments,
                    tool_use_id: exec.callId,
                    tool_response: textOf(result.content),
                }, exec.signal);
                const extra = merged.additionalContext.length > 0 ? contextMessage(merged.additionalContext) : undefined;
                if (merged.decision === 'deny') {
                    return {
                        kind: 'block',
                        feedback: [{ type: 'text', text: merged.reason ?? 'blocked by project hook (tools/post-execute)' }],
                        ...(extra !== undefined ? { additionalContexts: [extra] } : {}),
                    };
                }
                const downstream = await next();
                if (extra === undefined)
                    return downstream;
                return { ...downstream, additionalContexts: [extra, ...(downstream.additionalContexts ?? [])] };
            });
        }
        if (hooks['agent/pre-step'] !== undefined) {
            ;
            c.on('agent/pre-step', async (ev, next) => {
                if (ev.messages === undefined || ev.messages.length === 0)
                    return next();
                const merged = await run('agent/pre-step', '', ev.agent, { prompt: textOf(ev.messages.flatMap((m) => m.content ?? [])) }, ev.signal);
                if (merged.decision === 'deny')
                    return { kind: 'reject' };
                const downstream = await next();
                if (merged.additionalContext.length === 0 || downstream.kind !== 'enter')
                    return downstream;
                return { ...downstream, messages: [...(downstream.messages ?? []), contextMessage(merged.additionalContext)] };
            });
        }
        if (hooks['agent/turn-stopping'] !== undefined) {
            ;
            c.on('agent/turn-stopping', async ({ agent, signal }) => {
                const merged = await run('agent/turn-stopping', '', agent, {}, signal);
                if (merged.decision === 'deny') {
                    agent.steer?.(createUserMessage({
                        content: [
                            {
                                type: 'text',
                                text: merged.reason ?? 'continue: blocked by project hook (agent/turn-stopping)',
                            },
                        ],
                        source: SOURCE,
                    }));
                }
            });
        }
        if (hooks['subagent/start'] !== undefined) {
            ;
            c.on('subagent/start', (info) => detached('subagent/start', '', undefined, { agent_id: info.id, provider: info.provider }));
        }
        if (hooks['subagent/end'] !== undefined) {
            ;
            c.on('subagent/end', (info) => detached('subagent/end', '', undefined, {
                agent_id: info.id,
                provider: info.provider,
                stop_reason: info.stopReason,
            }));
        }
        c.effect(() => async () => {
            await Promise.allSettled([...inflight]);
        }, 'project-config: hooks drain');
    });
}
function errorMessage(error) {
    return String(error?.message ?? error);
}
/** Lifecycle hooks that run outside the agent scope (created / disposed). */
export async function runLifecycleHook(ctx, opts, event, agent, extra = {}) {
    const list = opts.hooks[event];
    if (list === undefined || list.length === 0)
        return undefined;
    const shell = shellFor(ctx, agent);
    if (shell === undefined)
        return undefined;
    const outputs = [];
    for (const hook of list) {
        if (!matchesMatcher(hook.matcher, String(extra['source'] ?? ''), MODE))
            continue;
        const { output } = await runHook(shell, {
            command: hook.command,
            ...(hook.timeout !== undefined ? { timeoutSec: hook.timeout } : {}),
        }, {
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
        }, () => performance.now());
        outputs.push(output);
        if (output.exitCode !== 0) {
            opts.log.info(`${opts.label}: hook ${event} "${hook.command}" exit=${output.exitCode ?? 'none'}`);
        }
    }
    const merged = mergeHookOutputs(outputs);
    if (merged.additionalContext.length > 0 && event === 'agent/created') {
        agent.inject?.(contextMessage(merged.additionalContext));
    }
    return merged;
}
