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
    if (value === undefined || value === null)
        return { kind: 'success' };
    if (typeof value === 'string')
        return { kind: 'success', text: value };
    if (typeof value === 'object') {
        const declared = value;
        if (declared.kind === 'success' || declared.kind === 'error') {
            const text = declared.text === undefined ? undefined : String(declared.text);
            if (declared.kind === 'error') {
                return { kind: 'error', text: text !== undefined && text.trim() !== '' ? text : 'command failed' };
            }
            return text === undefined ? { kind: 'success' } : { kind: 'success', text };
        }
        return { kind: 'success', text: JSON.stringify(value, null, 2) };
    }
    return { kind: 'success', text: String(value) };
}
/** Import a handler file, reloading when its modification time changes. */
export async function loadHandler(realPath) {
    const st = await fs.promises.stat(realPath);
    const mod = (await import(`${pathToFileURL(realPath).href}?mtime=${st.mtimeMs}`));
    const dflt = mod.default;
    if (typeof mod.default === 'function')
        return mod.default;
    if (typeof mod.handler === 'function')
        return mod.handler;
    if (typeof dflt?.handler === 'function')
        return dflt.handler;
    throw new Error('handler file must export a default function or `handler`');
}
function errorMessage(error) {
    return String(error?.message ?? error);
}
/**
 * Register commands on a root agent scope.
 */
export function mountCommands(agentCtx, specs, { root, log, label }) {
    if (specs.length === 0)
        return undefined;
    return agentCtx.inject(['commands'], (c) => {
        for (const { entry, realPath } of specs) {
            try {
                c.commands.register({
                    name: entry.name,
                    description: entry.description,
                    ...(entry.input !== undefined ? { input: entry.input } : {}),
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
                        }
                        catch (error) {
                            log.warn(`${label}: command /${entry.name} failed: ${errorMessage(error)}`);
                            return { kind: 'error', text: `/${entry.name}: ${errorMessage(error)}` };
                        }
                    },
                });
            }
            catch (error) {
                log.warn(`${label}: command /${entry.name} not registered: ${errorMessage(error)}`);
            }
        }
    });
}
