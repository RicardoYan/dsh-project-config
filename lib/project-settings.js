// The workspace's settings: `.dsh/settings.yml` plus, when present, the personal
// `.dsh/settings.local.yml` (kept out of git; credentials may be written in it).
//
// - settings.local.yml is read only when settings.yml exists.
// - Each file is validated on its own; then local entries are merged by name:
//   subagents by `toolName`, commands by `name`, mcp by `serverName`. A local
//   entry with the same name replaces the shared one whole, in its place; a new
//   name is appended. `enabled: false` in the local file removes the shared one.
//   Hooks are appended per event: shared hooks first, then local ones.
// - A local file that cannot be parsed is ignored as a whole with one warning.
// - Every warning is prefixed with the file it came from.
import path from 'node:path';
import { LOCAL_NAME, LOCAL_REL, SETTINGS_NAME, SETTINGS_REL, readSettingsFile } from './settings.js';
import { validateHookMatchers } from './features/hooks.js';
import { TEXT } from './text.js';

export const LIST_KEYS = Object.freeze({ subagents: 'toolName', commands: 'name', mcp: 'serverName' });

const empty = () => ({ subagents: [], commands: [], mcp: [], hooks: {} });

/** Settings of one parsed file with invalid hook matchers dropped. */
function checked(parsed) {
  const v = validateHookMatchers(parsed.settings.hooks);
  return { settings: { ...parsed.settings, hooks: v.hooks }, warnings: [...parsed.warnings, ...v.warnings] };
}

/**
 * Merge validated local settings into validated shared settings.
 * @returns { settings, origin: { subagents|commands|mcp: Map<name, 'local'|'override'> },
 *   hooksLocal: { [event]: count }, removed: [{ kind, name }], warnings } (warnings unprefixed)
 */
export function mergeSettings(shared, local, removals = []) {
  const settings = empty();
  const origin = { subagents: new Map(), commands: new Map(), mcp: new Map() };
  const removed = [];
  const warnings = [];
  for (const [kind, key] of Object.entries(LIST_KEYS)) {
    const list = [...shared[kind]];
    for (const entry of local[kind]) {
      const at = list.findIndex((e) => e[key] === entry[key]);
      if (at >= 0) { list[at] = entry; origin[kind].set(entry[key], 'override'); } else { list.push(entry); origin[kind].set(entry[key], 'local'); }
    }
    for (const r of removals.filter((x) => x.kind === kind)) {
      const at = list.findIndex((e) => e[key] === r.name);
      if (at < 0) { warnings.push(TEXT.nothingToRemove(r.where)); continue; }
      list.splice(at, 1);
      removed.push({ kind, name: r.name });
    }
    settings[kind] = list;
  }
  const hooksLocal = {};
  for (const [event, list] of Object.entries(shared.hooks)) settings.hooks[event] = [...list];
  for (const [event, list] of Object.entries(local.hooks)) {
    settings.hooks[event] = [...(settings.hooks[event] ?? []), ...list];
    hooksLocal[event] = list.length;
  }
  return { settings, origin, hooksLocal, removed, warnings };
}

/**
 * Load the settings for a workspace root; `undefined` when settings.yml does not exist.
 * @returns { file, localFile?, ok, error?, warnings, settings, origin, hooksLocal, removed }
 */
export async function loadProjectSettings(root) {
  const shared = await readSettingsFile(path.join(root, SETTINGS_REL));
  if (shared === undefined) return undefined;
  const base = { file: shared.file, origin: { subagents: new Map(), commands: new Map(), mcp: new Map() }, hooksLocal: {}, removed: [] };
  const inShared = (w) => TEXT.inFile(SETTINGS_NAME, w);
  const inLocal = (w) => TEXT.inFile(LOCAL_NAME, w);
  if (!shared.ok) return { ...base, ok: false, error: inShared(shared.error), warnings: shared.warnings.map(inShared), settings: empty() };
  const s = checked(shared);
  const warnings = s.warnings.map(inShared);

  const local = await readSettingsFile(path.join(root, LOCAL_REL), { local: true });
  if (local === undefined) return { ...base, ok: true, warnings, settings: s.settings };
  if (!local.ok) {
    warnings.push(inLocal(TEXT.localIgnored(local.error)));
    return { ...base, localFile: local.file, ok: true, warnings, settings: s.settings };
  }
  const l = checked(local);
  warnings.push(...l.warnings.map(inLocal));
  const merged = mergeSettings(s.settings, l.settings, local.removals);
  warnings.push(...merged.warnings.map(inLocal));
  return {
    ...base, localFile: local.file, ok: true, warnings,
    settings: merged.settings, origin: merged.origin, hooksLocal: merged.hooksLocal, removed: merged.removed,
  };
}
