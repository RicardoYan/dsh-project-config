// `/project-config`: read-only report of what this session loaded. UI-only.
// Shows names and states only, never values from the settings (urls, headers, env).
import { TEXT } from './text.js';

/** Name plus its settings.local.yml mark: `knot (local)` / `knot (local override)`. */
function marked(root, kind, name, shown = name) {
  const o = root.origin?.[kind]?.get(name);
  if (o === 'local') return `${shown} ${TEXT.fromLocal}`;
  if (o === 'override') return `${shown} ${TEXT.overriddenByLocal}`;
  return shown;
}

export function statusText(mount, { hasTrust, logFile }) {
  if (mount === undefined) return String(TEXT.noSettings);
  const root = mount.rootMount ?? mount;
  const lines = [];
  if (mount.rootMount) lines.push(TEXT.subagentSession(mount.toolName));
  lines.push(TEXT.workspace(root.root));
  lines.push(TEXT.settingsFile(root.localFile ? `${root.file} + ${root.localFile}` : root.file));
  lines.push(TEXT.trust(TEXT.state[root.trust] ?? root.trust, !hasTrust));
  if (!root.ok) {
    lines.push(`✗ ${root.error}`);
    return lines.join('\n');
  }
  const subs = mount.rootMount ? mount.subagents : [...root.subagentSpecs, ...(root.trustedSpecs ?? [])];
  lines.push(TEXT.subagents(subs.length ? subs.map((s) => marked(root, 'subagents', s.entry.toolName) + (s.error ? ` ✗ ${s.error}` : '')).join(', ') : '—'));
  const gated = root.trust === 'trusted';
  const blocked = gated ? '' : TEXT.requiresTrust;
  if (!gated && root.deferredSpecs?.length) {
    lines.push(TEXT.deferredSubagents(blocked, root.deferredSpecs.map((e) => marked(root, 'subagents', e.toolName)).join(', ')));
  }
  if (root.settings.commands.length) {
    lines.push(TEXT.commands(blocked, root.settings.commands.map((c) => marked(root, 'commands', c.name, `/${c.name}`)).join(', '), !!mount.rootMount));
  }
  if (root.settings.mcp.length) {
    if (!gated) lines.push(TEXT.mcpBlocked(blocked, root.settings.mcp.map((m) => marked(root, 'mcp', m.serverName)).join(', ')));
    else for (const s of root.hub?.summary() ?? []) lines.push(TEXT.mcpServer(marked(root, 'mcp', s.name), TEXT.mcpState[s.status] ?? s.status, s.detail));
  }
  const hookEvents = Object.entries(root.settings.hooks);
  if (hookEvents.length) {
    lines.push(TEXT.hooks(blocked, hookEvents.map(([e, l]) => `${e} ×${l.length}${root.hooksLocal?.[e] ? TEXT.hooksLocal(root.hooksLocal[e]) : ''}`).join(', '), gated ? root.stats : undefined));
  }
  if (root.removed?.length) {
    lines.push(TEXT.removed(root.removed.map((r) => `${TEXT.kind[r.kind]} ${r.kind === 'commands' ? '/' : ''}${r.name}`).join(', ')));
  }
  for (const w of [...root.warnings, ...(root.gatedWarnings ?? [])]) lines.push(`⚠ ${w}`);
  lines.push(TEXT.log(logFile));
  return lines.join('\n');
}

/** Result of `/project-config reconnect`: one line per server reconnected. */
export function reconnectText(root, names) {
  const byName = new Map((root.hub?.summary() ?? []).map((x) => [x.name, x]));
  return names.map((n) => {
    const x = byName.get(n);
    return String(TEXT.mcpServer(marked(root, 'mcp', n), TEXT.mcpState[x?.status] ?? x?.status, x?.detail));
  }).join('\n');
}
