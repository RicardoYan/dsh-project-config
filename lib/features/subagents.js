// Project subagents: one official dsh-tool-subagent tool per settings entry.
//
// Official interfaces relied on (@deepseek-ai/dsh-tool-subagent):
// - `apply(ctx, config)` registers the delegation tool through `ctx.tools.register`
//   and its prompt section through `ctx.systemPrompt`.
// - config: provider, toolName, maxDepth, agentOptions, agentPreset.
//   DSH 0.2.1 removed `persona` and `toolFilter` from this config: both now throw
//   ("no longer supported; configure persona and tool plugins in an Agent Preset
//   and select it with agentPreset"). Selecting a preset is optional, and NOT
//   selecting one is what this plugin relies on: `applyChildComposition` then
//   calls `agentPresets.composeFrom(childCtx, parent.ctx)`, so the child joins
//   the parent's retained revision and inherits its whole composition — every
//   tool, MCP client and prompt section the parent has (measured: 30 of 31; the
//   one difference is the parent's own per-agent delegation tool).
// The child's role is then applied to the child's OWN scope, which is the same
// mechanism dsh-subagent uses when restoring a historical child: a
// `deployment:persona-prefix` prompt section on the child context shadows the
// preset's, and `tools.restrict` narrows the inherited tool set. Both are
// per-scope registrations, so they affect one child and no other.
// The delegation tool's `execute` is wrapped so the child created inside it can
// be identified (AsyncLocalStorage follows the creation chain).
import { AsyncLocalStorage } from 'node:async_hooks';
import { apply as subagentApply } from '@deepseek-ai/dsh-tool-subagent';
export const delegationStore = new AsyncLocalStorage();
const TRACKER = Symbol.for('cordis.tracker');
/**
 * Whether a tool filter admits `name` (allow is a whitelist, deny removes).
 *
 * A missing filter means no restriction. The check is falsy rather than
 * `=== undefined` so a `null` filter still admits, matching the original —
 * `=== undefined` would throw on `.allow` instead.
 */
export function admits(filter, name) {
    if (filter === undefined || filter === null)
        return true;
    if (filter.allow !== undefined && !filter.allow.includes(name))
        return false;
    if (filter.deny !== undefined && filter.deny.includes(name))
        return false;
    return true;
}
/**
 * Tools DSH registers on every agent's own scope rather than inheriting:
 * the web presets' `subagent` delegation tool (`modelSelectionSettings: true`
 * installs it per agent on `agent/created`) and its `list_subagent_models`.
 */
export const PER_AGENT_TOOLS = new Set(['subagent', 'list_subagent_models']);
/**
 * The part of a filter `tools.restrict` may see. Project subagent names and the
 * per-agent delegation tools are stripped: the first are registered by this
 * plugin per child, the second DSH registers on each agent itself, and
 * `restrict` rejects names it cannot find in the inherited layer.
 */
export function officialFilter(filter, isProjectName) {
    if (filter === undefined || filter === null)
        return undefined;
    const keep = (n) => !isProjectName(n) && !PER_AGENT_TOOLS.has(n);
    const allow = filter.allow?.filter(keep);
    const deny = filter.deny?.filter(keep);
    if (allow !== undefined)
        return deny !== undefined && deny.length > 0 ? { allow, deny } : { allow };
    if (deny !== undefined && deny.length > 0)
        return { deny };
    return undefined;
}
/**
 * A stand-in for a traced `tools` service that replaces only `register`.
 * It hides the cordis tracker so the context proxy hands it out as-is instead
 * of re-wrapping the original service (which would bypass `register`).
 *
 * `register` also absorbs a duplicate tool name. DSH's registry throws
 * `tool "<name>" is already registered in this scope`, and the loader treats
 * that throw as a fatal load failure — the whole host exits. A plugin reload can
 * make this plugin mount the same agent twice, so a name already registered
 * through this proxy is skipped and logged instead of taking the host down.
 *
 * Scope of the guard: only registrations that pass through this proxy, i.e. the
 * ones this plugin mounts. Other plugins register on their own contexts and are
 * unaffected — notably `dsh-tool-subagent`, which installs its per-agent
 * `subagent` tool through its own `runtimeCtx` (dsh-tool-subagent/lib/index.js,
 * `mount()` -> `runtimeCtx.tools.register`). A duplicate there still throws.
 * @param tools - the real registry.
 * @param register - wraps one definition; receives the real `register` as its
 *   second argument so the caller can still forward a plain definition.
 * @param options - { log, label }: a duplicate is reported, never thrown.
 */
export function interceptTools(tools, register, { log, label } = {}) {
    const seen = new Set();
    /**
     * Report a duplicate and say whether the caller must give up on it.
     * @returns true when the duplicate was absorbed (skip the registration); the
     *   no-logger fallback throws DSH's own error instead, which is exactly what
     *   this guard exists to avoid.
     */
    const absorb = (name, error) => {
        if (log === undefined)
            throw new Error(`tool "${name}" is already registered in this scope`);
        log.warn(`${label ?? 'tools'}: tool ${name} was already registered in this scope; kept the first one (${errorMessage(error)})`);
        return true;
    };
    return new Proxy(Object.create(null), {
        get(_target, prop) {
            if (prop === 'register') {
                return (definition) => {
                    const name = definition?.name;
                    if (typeof name === 'string' && seen.has(name)) {
                        absorb(name, 'duplicate name');
                        return () => { };
                    }
                    if (typeof name === 'string')
                        seen.add(name);
                    const release = () => {
                        if (typeof name === 'string')
                            seen.delete(name);
                    };
                    try {
                        const dispose = register(definition, (d) => tools.register(d));
                        return () => {
                            try {
                                if (typeof dispose === 'function')
                                    dispose();
                            }
                            finally {
                                release();
                            }
                        };
                    }
                    catch (error) {
                        release();
                        if (typeof name === 'string' && /already registered/.test(errorMessage(error))) {
                            absorb(name, error);
                            return () => { };
                        }
                        throw error;
                    }
                };
            }
            if (prop === TRACKER || typeof prop === 'symbol')
                return undefined;
            const value = tools[prop];
            if (typeof value === 'function') {
                return (...args) => tools[prop].apply(tools, args);
            }
            return value;
        },
        has(_target, prop) {
            return prop === 'register' || (typeof prop === 'string' && prop in tools);
        },
    });
}
function errorMessage(error) {
    return String(error?.message ?? error);
}
export function rosterText(specs) {
    const lines = specs.map((s) => `- \`${s.entry.toolName}\`: ${s.description !== undefined && s.description !== '' ? s.description : '(no description)'}`);
    return `Project subagents defined for this workspace. Each one is a tool with the same name; delegate to the one whose purpose fits the task:\n${lines.join('\n')}`;
}
/**
 * Apply one project subagent's role to its own child scope.
 *
 * Two per-scope registrations, both undone when the child goes away:
 * - a `deployment:persona-prefix` prompt section, which shadows the preset's
 *   (that is the section name and order dsh-persona itself registers, and the
 *   one dsh-subagent uses for historical children);
 * - `tools.restrict(filter)` to narrow the tools inherited from the parent.
 *
 * The filter is optional: without one the child keeps every inherited tool,
 * which is what an unqualified project subagent should get.
 * @param childCtx - the child agent's scoped context.
 * @param spec - { persona, filter }, or undefined when the child is not a project one.
 * @param options - { log, label, isProjectName }.
 */
export function applyChildRole(childCtx, spec, { log, label, isProjectName }) {
    if (spec === undefined)
        return undefined;
    return childCtx.inject(['tools', 'systemPrompt'], (c) => {
        if (typeof spec.persona === 'string' && spec.persona !== '') {
            c.systemPrompt.section({
                name: 'deployment:persona-prefix',
                order: c.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
                text: spec.persona,
            });
        }
        const filter = officialFilter(spec.filter, isProjectName);
        if (filter !== undefined) {
            try {
                c.tools.restrict(filter);
            }
            catch (error) {
                log.warn(`${label}: toolFilter not applied: ${errorMessage(error)}`);
            }
        }
    });
}
/**
 * Mount the given subagent tools on an agent scope.
 * @param agentCtx - the agent's scoped context.
 * @param specs - [{ entry, persona }] (mutated with `error` on failure).
 * @returns the owning fiber (dispose to remove), or undefined when nothing to mount.
 */
export function mountSubagentTools(agentCtx, specs, { log, isProjectName, label, sectionName = 'project-config:subagents' }) {
    if (specs.length === 0)
        return undefined;
    const byName = new Map(specs.map((s) => [s.entry.toolName, s]));
    return agentCtx.inject(['tools', 'subagents', 'systemPrompt', 'sessionProjections'], async (c) => {
        const tools = interceptTools(c.tools, (definition, register) => {
            const spec = byName.get(definition.name);
            if (spec === undefined)
                return register(definition);
            const execute = definition.execute;
            return register({
                ...definition,
                execute: (args, exec) => delegationStore.run({ parentId: exec?.agent?.id, toolName: spec.entry.toolName }, () => execute.call(definition, args, exec)),
            });
        }, { log, label });
        const scoped = c.extend({ tools });
        // `subagentApply` is async: it awaits preset validation before it registers
        // the tool and its `tool:<name>` prompt section. Awaiting it here keeps the
        // registrations ahead of `systemPrompt.section(sectionName)` below and lets a
        // failure be reported against the spec it belongs to; without the await the
        // section could be written for a roster the tool never joined.
        // (The callback itself is async, so cordis still waits for it before the
        // fiber settles — a reload's dispose cannot cut in mid-registration.)
        for (const spec of specs) {
            const { entry } = spec;
            if (spec.error !== undefined)
                continue;
            try {
                // No `agentPreset`: the child joins the delegating parent's composition
                // and inherits its tools. The role is applied per child in
                // applyChildRole, not carried by a preset.
                await subagentApply(scoped, {
                    provider: entry.provider,
                    toolName: entry.toolName,
                    maxDepth: entry.maxDepth,
                    ...(entry.agentOptions !== undefined ? { agentOptions: entry.agentOptions } : {}),
                });
            }
            catch (error) {
                spec.error = errorMessage(error);
                log.warn(`${label}: subagent tool ${entry.toolName} failed: ${spec.error}`);
            }
        }
        const mounted = specs.filter((s) => s.error === undefined);
        if (mounted.length > 0) {
            c.systemPrompt.section({
                name: sectionName,
                order: (c.systemPrompt.getSectionOrder('TOOL_SUBAGENT') ?? 2800) + 1,
                interpolate: false,
                text: rosterText(mounted),
            });
        }
    });
}
