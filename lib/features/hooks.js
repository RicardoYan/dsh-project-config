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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { DEFAULT_HOOK_TIMEOUT_MS, matcherDiagnostic, matchesMatcher, mergeHookOutputs, runHook } from '@deepseek-ai/dsh-hook-protocol';
import { TEXT } from '../text.js';

const MODE = 'claude-code';
const SOURCE = { kind: 'plugin:dsh-project-config' };

/** Drop hook entries whose matcher is an invalid regex; returns warnings. */
export function validateHookMatchers(hooks) {
  const warnings = [];
  const out = {};
  for (const [event, list] of Object.entries(hooks)) {
    const kept = list.filter((h, i) => {
      const d = matcherDiagnostic(h.matcher, MODE);
      if (d !== undefined) warnings.push(TEXT.invalidMatcher(`hooks.${event}[${i}]`, d));
      return d === undefined;
    });
    if (kept.length) out[event] = kept;
  }
  return { hooks: out, warnings };
}

const textOf = (content) => (content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
const contextMessage = (texts) => createUserMessage({ content: texts.map((text) => ({ type: 'text', text })), source: SOURCE });

/**
 * On Windows `ctx.shell` runs `powershell -Command <text>`, whose own exit code
 * is 1 whenever the last native program failed, so a hook's exit 2 would never
 * reach the protocol. Forward the program's real exit code explicitly.
 */
export function forwardExitCode(command, platform = process.platform) {
  if (platform !== 'win32') return command;
  return `${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
}

/** Session-policy-aware view of `ctx.shell` (the bridge default would use the deployment policy). */
function shellFor(ctx, agent) {
  const shell = ctx.get('shell');
  if (shell === undefined) return undefined;
  const policy = ctx.get('sandboxPolicy');
  return {
    resolve: (request) => shell.resolve({
      ...request,
      command: forwardExitCode(request.command),
      ...(policy && agent ? { sandboxPolicy: policy.resolve({ session: agent.session }) } : {}),
    }),
    execute: (spec) => shell.execute(spec),
  };
}

/**
 * Register hooks on one agent scope.
 * @param agentCtx - the agent's scoped context.
 * @param opts - { hooks, root, log, label, stats }
 * @returns the owning fiber.
 */
export function mountHooks(agentCtx, { hooks, root, log, label, stats }) {
  const events = Object.keys(hooks);
  if (events.length === 0) return undefined;
  return agentCtx.inject([], (c) => {
    const inflight = new Set();
    const lifetime = new AbortController();
    c.effect(() => () => { lifetime.abort(new Error('project hooks disposed')); }, 'project-config: hooks');

    async function runPoint(event, query, agent, payload, signal) {
      const outputs = [];
      for (const hook of hooks[event] ?? []) {
        if (!matchesMatcher(hook.matcher, query, MODE)) continue;
        const shell = shellFor(c, agent);
        if (shell === undefined) { log.warn(`${label}: hooks skipped, no shell service`); break; }
        const { output, durationMs } = await runHook(shell, {
          command: hook.command,
          ...(hook.timeout !== undefined ? { timeoutSec: hook.timeout } : {}),
        }, {
          payload: { event, session_id: agent?.id ?? '', cwd: agent?.session?.header?.cwd ?? root, workspace_root: root, ...payload },
          defaultTimeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
          env: { DSH_PROJECT_DIR: root },
          cwd: root,
          signal: signal ?? lifetime.signal,
          trailingNewline: true,
        }, () => performance.now());
        outputs.push(output);
        stats.runs++;
        if (output.exitCode !== 0) {
          stats.failures += output.exitCode === 2 ? 0 : 1;
          log.info(`${label}: hook ${event} "${hook.command}" exit=${output.exitCode ?? 'none'} ${Math.round(durationMs)}ms${output.stderr ? ` stderr=${output.stderr.slice(0, 300)}` : ''}`);
        }
      }
      return mergeHookOutputs(outputs);
    }

    const detached = (event, query, agent, payload) => {
      const run = runPoint(event, query, agent, payload, lifetime.signal).catch((error) => log.warn(`${label}: hook ${event} failed: ${error?.message ?? error}`));
      inflight.add(run);
      run.finally(() => inflight.delete(run));
      return run;
    };

    if (hooks['tools/pre-execute']) {
      c.on('tools/pre-execute', async (exec, next) => {
        const merged = await runPoint('tools/pre-execute', exec.name, exec.agent, { tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }, exec.signal);
        if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by project hook (tools/pre-execute)' };
        if (merged.decision === 'ask') return { kind: 'ask', ...(merged.reason !== undefined ? { reason: merged.reason } : {}) };
        return next();
      });
    }
    if (hooks['tools/post-execute']) {
      c.on('tools/post-execute', async (exec, result, next) => {
        const merged = await runPoint('tools/post-execute', exec.name, exec.agent, {
          tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: textOf(result.content),
        }, exec.signal);
        const extra = merged.additionalContext.length ? contextMessage(merged.additionalContext) : undefined;
        if (merged.decision === 'deny') {
          return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by project hook (tools/post-execute)' }], ...(extra ? { additionalContexts: [extra] } : {}) };
        }
        const downstream = await next();
        if (!extra) return downstream;
        return { ...downstream, additionalContexts: [extra, ...(downstream.additionalContexts ?? [])] };
      });
    }
    if (hooks['agent/pre-step']) {
      c.on('agent/pre-step', async (ev, next) => {
        if (!ev.messages || ev.messages.length === 0) return next();
        const merged = await runPoint('agent/pre-step', '', ev.agent, { prompt: textOf(ev.messages.flatMap((m) => m.content ?? [])) }, ev.signal);
        if (merged.decision === 'deny') return { kind: 'reject' };
        const downstream = await next();
        if (!merged.additionalContext.length || downstream.kind !== 'enter') return downstream;
        return { ...downstream, messages: [...downstream.messages, contextMessage(merged.additionalContext)] };
      });
    }
    if (hooks['agent/turn-stopping']) {
      c.on('agent/turn-stopping', async ({ agent, signal }) => {
        const merged = await runPoint('agent/turn-stopping', '', agent, {}, signal);
        if (merged.decision === 'deny') {
          agent.steer(createUserMessage({ content: [{ type: 'text', text: merged.reason ?? 'continue: blocked by project hook (agent/turn-stopping)' }], source: SOURCE }));
        }
      });
    }
    if (hooks['subagent/start']) c.on('subagent/start', (info) => { detached('subagent/start', '', undefined, { agent_id: info.id, provider: info.provider }); });
    if (hooks['subagent/end']) c.on('subagent/end', (info) => { detached('subagent/end', '', undefined, { agent_id: info.id, provider: info.provider, stop_reason: info.stopReason }); });

    c.effect(() => async () => { await Promise.allSettled([...inflight]); }, 'project-config: hooks drain');
  });
}

/** Lifecycle hooks that run outside the agent scope (created / disposed). */
export async function runLifecycleHook(ctx, { hooks, root, log, label }, event, agent, extra = {}) {
  const list = hooks[event];
  if (!list || list.length === 0) return undefined;
  const shell = shellFor(ctx, agent);
  if (shell === undefined) return undefined;
  const outputs = [];
  for (const hook of list) {
    if (!matchesMatcher(hook.matcher, extra.source ?? '', MODE)) continue;
    const { output } = await runHook(shell, { command: hook.command, ...(hook.timeout !== undefined ? { timeoutSec: hook.timeout } : {}) }, {
      payload: { event, session_id: agent.id, cwd: agent.session?.header?.cwd ?? root, workspace_root: root, ...extra },
      defaultTimeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
      env: { DSH_PROJECT_DIR: root },
      cwd: root,
      signal: AbortSignal.timeout(DEFAULT_HOOK_TIMEOUT_MS),
      trailingNewline: true,
    }, () => performance.now());
    outputs.push(output);
    if (output.exitCode !== 0) log.info(`${label}: hook ${event} "${hook.command}" exit=${output.exitCode ?? 'none'}`);
  }
  const merged = mergeHookOutputs(outputs);
  if (merged.additionalContext.length && event === 'agent/created') agent.inject(contextMessage(merged.additionalContext));
  return merged;
}
