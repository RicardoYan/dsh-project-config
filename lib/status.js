// `/project-config`: read-only report of what this session loaded. UI-only.
import { TEXT } from './text.js';

export function statusText(mount, { hasTrust, logFile }) {
  if (mount === undefined) return String(TEXT.noSettings);
  const root = mount.rootMount ?? mount;
  const lines = [];
  if (mount.rootMount) lines.push(TEXT.subagentSession(mount.toolName));
  lines.push(TEXT.workspace(root.root));
  lines.push(TEXT.settingsFile(root.file));
  lines.push(TEXT.trust(TEXT.state[root.trust] ?? root.trust, !hasTrust));
  if (!root.ok) {
    lines.push(`✗ ${root.error}`);
    return lines.join('\n');
  }
  const subs = mount.rootMount ? mount.subagents : [...root.subagentSpecs, ...(root.trustedSpecs ?? [])];
  lines.push(TEXT.subagents(subs.length ? subs.map((s) => s.entry.toolName + (s.error ? ` ✗ ${s.error}` : '')).join(', ') : '—'));
  const gated = root.trust === 'trusted';
  const blocked = gated ? '' : TEXT.requiresTrust;
  if (!gated && root.deferredSpecs?.length) {
    lines.push(TEXT.deferredSubagents(blocked, root.deferredSpecs.map((e) => e.toolName).join(', ')));
  }
  if (root.settings.commands.length) {
    lines.push(TEXT.commands(blocked, root.settings.commands.map((c) => `/${c.name}`).join(', '), !!mount.rootMount));
  }
  if (root.settings.mcp.length) {
    if (!gated) lines.push(TEXT.mcpBlocked(blocked, root.settings.mcp.map((m) => m.serverName).join(', ')));
    else for (const s of root.hub?.summary() ?? []) lines.push(TEXT.mcpServer(s.name, TEXT.mcpState[s.status] ?? s.status, s.detail));
  }
  const hookEvents = Object.entries(root.settings.hooks);
  if (hookEvents.length) {
    lines.push(TEXT.hooks(blocked, hookEvents.map(([e, l]) => `${e} ×${l.length}`).join(', '), gated ? root.stats : undefined));
  }
  for (const w of [...root.warnings, ...(root.gatedWarnings ?? [])]) lines.push(`⚠ ${w}`);
  lines.push(TEXT.log(logFile));
  return lines.join('\n');
}
