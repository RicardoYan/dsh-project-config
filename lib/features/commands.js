// Project slash commands backed by a JS handler file in the workspace.
//
// Official interface relied on (@deepseek-ai/dsh-commands):
// `ctx.commands.register({ name, description, input?, handler })`; registered through
// an agent-scoped context the command is visible to that agent only. The handler
// receives `{ commandId, agent, rawInput, attachments, signal }` and returns
// `{ kind: 'success', text? } | { kind: 'error', text }`; results are UI-only.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Normalize whatever a project handler returned into a CommandResult. */
export function normalizeResult(value) {
  if (value === undefined || value === null) return { kind: 'success' };
  if (typeof value === 'string') return { kind: 'success', text: value };
  if (typeof value === 'object' && (value.kind === 'success' || value.kind === 'error')) {
    const text = value.text === undefined ? undefined : String(value.text);
    if (value.kind === 'error') return { kind: 'error', text: text && text.trim() ? text : 'command failed' };
    return text === undefined ? { kind: 'success' } : { kind: 'success', text };
  }
  return { kind: 'success', text: typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value) };
}

/** Import a handler file, reloading when its modification time changes. */
export async function loadHandler(realPath) {
  const st = await fs.promises.stat(realPath);
  const mod = await import(`${pathToFileURL(realPath).href}?mtime=${st.mtimeMs}`);
  const fn = typeof mod.default === 'function' ? mod.default
    : typeof mod.handler === 'function' ? mod.handler
    : typeof mod.default?.handler === 'function' ? mod.default.handler
    : undefined;
  if (fn === undefined) throw new Error('handler file must export a default function or `handler`');
  return fn;
}

/**
 * Register commands on a root agent scope.
 * @param specs - [{ entry, realPath }]
 */
export function mountCommands(agentCtx, specs, { root, log, label }) {
  if (specs.length === 0) return undefined;
  return agentCtx.inject(['commands'], (c) => {
    for (const { entry, realPath } of specs) {
      try {
        c.commands.register({
          name: entry.name,
          description: entry.description,
          ...(entry.input ? { input: entry.input } : {}),
          handler: async (invocation) => {
            try {
              const fn = await loadHandler(realPath);
              return normalizeResult(await fn({
                agent: invocation.agent,
                rawInput: invocation.rawInput,
                attachments: invocation.attachments,
                signal: invocation.signal,
                workspaceRoot: root,
              }));
            } catch (error) {
              log.warn(`${label}: command /${entry.name} failed: ${error?.message ?? error}`);
              return { kind: 'error', text: `/${entry.name}: ${error?.message ?? error}` };
            }
          },
        });
      } catch (error) {
        log.warn(`${label}: command /${entry.name} not registered: ${error?.message ?? error}`);
      }
    }
  });
}
