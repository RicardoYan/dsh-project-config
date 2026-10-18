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
import { LOCAL_NAME, LOCAL_REL, SETTINGS_NAME, SETTINGS_REL, readSettingsFile, } from './settings.js';
import { validateHookMatchers } from './features/hooks.js';
import { TEXT } from './text.js';
/** The key each named list merges by. */
export const LIST_KEYS = Object.freeze({ subagents: 'toolName', commands: 'name', mcp: 'serverName' });
const emptySettings = () => ({ subagents: [], commands: [], mcp: [], hooks: {} });
const emptyOrigin = () => ({ subagents: new Map(), commands: new Map(), mcp: new Map() });
/** Settings of one parsed file with invalid hook matchers dropped. */
function checked(parsed) {
    const v = validateHookMatchers(parsed.settings.hooks);
    return { settings: { ...parsed.settings, hooks: v.hooks }, warnings: [...parsed.warnings, ...v.warnings] };
}
/** Read a named field off any of the three list entries. */
function nameOf(entry, key) {
    return String(entry[key]);
}
/**
 * Merge validated local settings into validated shared settings.
 * @returns settings, origin (which names came from settings.local.yml),
 *   hooksLocal (per-event counts), removed, and unprefixed warnings.
 */
export function mergeSettings(shared, local, removals = []) {
    const settings = emptySettings();
    const origin = emptyOrigin();
    const removed = [];
    const warnings = [];
    for (const [kind, key] of Object.entries(LIST_KEYS)) {
        const k = kind;
        const list = [...shared[k]];
        for (const entry of local[k]) {
            const name = nameOf(entry, key);
            const at = list.findIndex((e) => nameOf(e, key) === name);
            if (at >= 0) {
                list[at] = entry;
                origin[k].set(name, 'override');
            }
            else {
                list.push(entry);
                origin[k].set(name, 'local');
            }
        }
        for (const r of removals.filter((x) => x.kind === k)) {
            const at = list.findIndex((e) => nameOf(e, key) === r.name);
            if (at < 0) {
                warnings.push(TEXT.nothingToRemove(r.where ?? r.name));
                continue;
            }
            list.splice(at, 1);
            // `where` is only for the warning above; a removal names its kind and name.
            removed.push({ kind: k, name: r.name });
        }
        settings[k] = list;
    }
    const hooksLocal = {};
    for (const [event, list] of Object.entries(shared.hooks))
        settings.hooks[event] = [...list];
    for (const [event, list] of Object.entries(local.hooks)) {
        settings.hooks[event] = [...(settings.hooks[event] ?? []), ...list];
        hooksLocal[event] = list.length;
    }
    return { settings, origin, hooksLocal, removed, warnings };
}
/**
 * Load the settings for a workspace root; `undefined` when settings.yml does not exist.
 */
export async function loadProjectSettings(root) {
    const shared = await readSettingsFile(path.join(root, SETTINGS_REL));
    if (shared === undefined)
        return undefined;
    const base = { file: shared.file, origin: emptyOrigin(), hooksLocal: {}, removed: [] };
    const inShared = (w) => TEXT.inFile(SETTINGS_NAME, w);
    const inLocal = (w) => TEXT.inFile(LOCAL_NAME, w);
    if (!shared.ok) {
        return {
            ...base,
            ok: false,
            error: inShared(shared.error),
            warnings: shared.warnings.map(inShared),
            settings: emptySettings(),
        };
    }
    const s = checked(shared);
    const warnings = s.warnings.map(inShared);
    const local = await readSettingsFile(path.join(root, LOCAL_REL), { local: true });
    if (local === undefined)
        return { ...base, ok: true, warnings, settings: s.settings };
    if (!local.ok) {
        warnings.push(inLocal(TEXT.localIgnored(local.error)));
        return { ...base, localFile: local.file, ok: true, warnings, settings: s.settings };
    }
    const l = checked(local);
    warnings.push(...l.warnings.map(inLocal));
    const merged = mergeSettings(s.settings, l.settings, local.removals);
    warnings.push(...merged.warnings.map(inLocal));
    return {
        ...base,
        localFile: local.file,
        ok: true,
        warnings,
        settings: merged.settings,
        origin: merged.origin,
        hooksLocal: merged.hooksLocal,
        removed: merged.removed,
    };
}
