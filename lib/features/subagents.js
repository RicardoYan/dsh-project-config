// Project subagents: one official dsh-tool-subagent tool per settings entry.
//
// Official interfaces relied on (@deepseek-ai/dsh-tool-subagent):
// - `apply(ctx, config)` registers the delegation tool through `ctx.tools.register`
//   and its prompt section through `ctx.systemPrompt`.
// - config: provider, toolName, backgroundMode, persona, toolFilter, maxDepth.
// The delegation tool's `execute` is wrapped so the child created inside it can
// be identified (AsyncLocalStorage follows the creation chain).
import { AsyncLocalStorage } from 'node:async_hooks';
import { apply as subagentApply } from '@deepseek-ai/dsh-tool-subagent';

export const delegationStore = new AsyncLocalStorage();
const TRACKER = Symbol.for('cordis.tracker');

/** Whether a tool filter admits `name` (allow is a whitelist, deny removes). */
export function admits(filter, name) {
  if (!filter) return true;
  if (filter.allow !== undefined && !filter.allow.includes(name)) return false;
  if (filter.deny !== undefined && filter.deny.includes(name)) return false;
  return true;
}

/**
 * Tools DSH registers on every agent's own scope rather than inheriting:
 * the web presets' `subagent` delegation tool (`modelSelectionSettings: true`
 * installs it per agent on `agent/created`) and its `list_subagent_models`.
 * `tools.restrict` cannot mask scope-local tools and throws on their names, so
 * they are dropped from filters: every subagent keeps them, and the official
 * depth limit bounds nesting.
 */
export const PER_AGENT_TOOLS = new Set(['subagent', 'list_subagent_models']);

/**
 * The part of a filter the official `tools.restrict` may see: it rejects names
 * that are not inherited global tools, so project tool names are removed and
 * handled by this plugin instead, and per-agent official tools are removed.
 */
export function officialFilter(filter, isProjectName) {
  if (!filter) return undefined;
  const keep = (n) => !isProjectName(n) && !PER_AGENT_TOOLS.has(n);
  const allow = filter.allow?.filter(keep);
  const deny = filter.deny?.filter(keep);
  if (allow !== undefined) return deny?.length ? { allow, deny } : { allow };
  if (deny?.length) return { deny };
  return undefined;
}

/**
 * A stand-in for a traced `tools` service that replaces only `register`.
 * It hides the cordis tracker so the context proxy hands it out as-is instead
 * of re-wrapping the original service (which would bypass `register`).
 */
export function interceptTools(tools, register) {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (prop === 'register') return (definition) => register(definition, (d) => tools.register(d));
      if (prop === TRACKER || typeof prop === 'symbol') return undefined;
      const value = tools[prop];
      return typeof value === 'function' ? (...args) => tools[prop](...args) : value;
    },
    has(_target, prop) { return prop === 'register' || (typeof prop === 'string' && prop in tools); },
  });
}

export function rosterText(specs) {
  const lines = specs.map((s) => `- \`${s.entry.toolName}\`: ${s.description || '(no description)'}`);
  return `Project subagents defined for this workspace. Each one is a tool with the same name; delegate to the one whose purpose fits the task:\n${lines.join('\n')}`;
}

/**
 * Mount the given subagent tools on an agent scope.
 * @param agentCtx - the agent's scoped context.
 * @param specs - [{ entry, persona, description }] (mutated with `error` on failure).
 * @returns the owning fiber (dispose to remove), or undefined when nothing to mount.
 */
export function mountSubagentTools(agentCtx, specs, { log, isProjectName, label, sectionName = 'project-config:subagents' }) {
  if (specs.length === 0) return undefined;
  const byName = new Map(specs.map((s) => [s.entry.toolName, s]));
  return agentCtx.inject(['tools', 'subagents', 'systemPrompt', 'sessionProjections'], (c) => {
    const tools = interceptTools(c.tools, (definition, register) => {
      const spec = byName.get(definition.name);
      if (spec === undefined) return register(definition);
      const execute = definition.execute;
      return register({
        ...definition,
        execute: (args, exec) => delegationStore.run(
          { parentId: exec?.agent?.id, toolName: spec.entry.toolName },
          () => execute.call(definition, args, exec),
        ),
      });
    });
    const scoped = c.extend({ tools });
    for (const spec of specs) {
      const { entry } = spec;
      const filter = officialFilter(entry.toolFilter, isProjectName);
      try {
        subagentApply(scoped, {
          provider: entry.provider,
          toolName: entry.toolName,
          backgroundMode: entry.backgroundMode,
          persona: spec.persona,
          maxDepth: entry.maxDepth,
          ...(filter ? { toolFilter: filter } : {}),
        });
      } catch (error) {
        spec.error = String(error?.message ?? error);
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
