import { TEXT } from './text.js';
/** Index the mode tables by a value that may not be a known key. */
function lookup(table, key) {
    return typeof key === 'string' ? table[key] : undefined;
}
/** Name plus its settings.local.yml mark: `knot (local)` / `knot (local override)`. */
function marked(root, kind, name, shown = name) {
    // `origin` itself may be absent on a mount built before the merge existed.
    const o = root.origin?.[kind]?.get(name);
    if (o === 'local')
        return `${shown} ${TEXT.fromLocal}`;
    if (o === 'override')
        return `${shown} ${TEXT.overriddenByLocal}`;
    return shown;
}
export function statusText(mount, { logFile }) {
    if (mount === undefined)
        return String(TEXT.noSettings);
    const root = mount.rootMount ?? mount;
    // Mixed on purpose: bilingual `Text` values and already-rendered strings share
    // one array; `join` renders both.
    const lines = [];
    if (mount.rootMount)
        lines.push(TEXT.subagentSession(mount.toolName));
    lines.push(TEXT.workspace(root.root));
    lines.push(TEXT.settingsFile(root.localFile ? `${root.file} + ${root.localFile}` : root.file));
    if (!root.ok) {
        lines.push(`✗ ${root.error}`);
        return lines.join('\n');
    }
    const subs = mount.rootMount ? (mount.subagents ?? []) : root.subagentSpecs;
    lines.push(TEXT.subagents(subs.length
        ? subs
            .map((s) => marked(root, 'subagents', s.entry.toolName) + (s.error ? ` ✗ ${s.error}` : ''))
            .join(', ')
        : '—'));
    if (root.settings.commands.length > 0) {
        lines.push(TEXT.commands(root.settings.commands.map((c) => marked(root, 'commands', c.name, `/${c.name}`)).join(', '), mount.rootMount !== undefined));
    }
    if (root.settings.mcp.length > 0) {
        const servers = root.hub?.summary();
        if (servers === undefined || servers.length === 0) {
            lines.push(TEXT.mcp(root.settings.mcp.map((m) => marked(root, 'mcp', m.serverName)).join(', ')));
        }
        else {
            for (const s of servers) {
                lines.push(TEXT.mcpServer(marked(root, 'mcp', s.name), lookup(TEXT.mcpState, s.status) ?? s.status, s.detail));
            }
        }
    }
    const hookEvents = Object.entries(root.settings.hooks);
    if (hookEvents.length > 0) {
        lines.push(TEXT.hooks(hookEvents
            .map(([e, l]) => `${e} ×${l.length}${root.hooksLocal?.[e] ? TEXT.hooksLocal(root.hooksLocal[e]) : ''}`)
            .join(', '), root.stats ?? { runs: 0, failures: 0 }));
    }
    if (root.removed !== undefined && root.removed.length > 0) {
        lines.push(TEXT.removed(root.removed
            .map((r) => `${lookup(TEXT.kind, r.kind) ?? r.kind} ${r.kind === 'commands' ? '/' : ''}${r.name}`)
            .join(', ')));
    }
    for (const w of root.warnings)
        lines.push(`⚠ ${w}`);
    lines.push(TEXT.log(logFile));
    return lines.join('\n');
}
/** Result of `/project-config reconnect`: one line per server reconnected. */
export function reconnectText(root, names) {
    const byName = new Map((root.hub?.summary() ?? []).map((x) => [x.name, x]));
    return names
        .map((n) => {
        const x = byName.get(n);
        return String(TEXT.mcpServer(marked(root, 'mcp', n), lookup(TEXT.mcpState, x?.status) ?? x?.status ?? '', x?.detail));
    })
        .join('\n');
}
