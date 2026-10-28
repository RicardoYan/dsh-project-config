// User-facing strings, one language at a time (see locale.js).
// Messages are L(zh, en) values rendered when shown, so /project-config
// follows a language change. Anything interpolated may itself be an L value,
// so composed messages use the lazy `T` template.
import { L, T, type Text } from './locale.js';

export { L };

export const TEXT = {
  // /project-config
  commandDescription: L('查看本会话加载的项目配置；reload 重挂已加载的内容', 'Show the project settings loaded for this session; reload re-mounts them'),
  // One command per line: the transcript's GenericCommandCard only offers the
  // expander when the text contains a newline, and forces a one-line result into
  // a single `nowrap` row with an ellipsis (dsh-client-ui-chat GenericCommandCard).
  commandUsage: L(
    [
      '用法：',
      '/project-config 查看状态',
      '/project-config reload 全部重挂',
      '/project-config reload subagents|commands|hooks 只重挂一类',
      '/project-config reload mcp 重连全部 MCP 服务器',
      '/project-config reload mcp <名字> 只重连指定的服务器',
    ].join('\n'),
    [
      'Usage:',
      '/project-config shows the status',
      '/project-config reload re-mounts everything',
      '/project-config reload subagents|commands|hooks re-mounts one section',
      '/project-config reload mcp reconnects every MCP server',
      '/project-config reload mcp <name> reconnects that one server',
    ].join('\n'),
  ),
  // The four words `/project-config reload` accepts. They are the section names
  // the status report already shows, so they stay untranslated in every message.
  // Also used for an argument that is not `reload` at all (`… reconnect`).
  unknownArg: (arg: string) => L(
    T`不认识的参数 ${arg}`,
    T`Unknown argument ${arg}`,
  ),
  reloadUnknownPart: (arg: string) => L(
    T`不认识的重挂范围 ${arg}\n只能写 subagents、commands、mcp（可再跟一个服务器名）或 hooks`,
    T`Unknown reload scope ${arg}\nUse subagents, commands, mcp (optionally with one server name) or hooks`,
  ),
  // One section per line, for the same reason as `commandUsage`: a one-line
  // result cannot be expanded in the transcript.
  reloadDone: (c: { subagents: number; commands: number; mcp: number; hooks: number }) => L(
    ['reload 完成：', `subagents ${c.subagents}`, `commands ${c.commands}`, `mcp ${c.mcp}`, `hooks ${c.hooks}`].join('\n'),
    ['reload done:', `subagents ${c.subagents}`, `commands ${c.commands}`, `mcp ${c.mcp}`, `hooks ${c.hooks}`].join('\n'),
  ),
  // The failures follow on their own lines; the heading stands alone.
  // Every one of these ends with a newline so the assembled result stays
  // multi-line: the transcript offers the expander only for text containing one.
  reloadPartial: (detail: unknown) => L(T`reload 部分失败：${detail}\n`, T`reload partly failed: ${detail}\n`),
  // `count` is how many entries follow on the next lines.
  reloadPartDone: (part: unknown, count: unknown) => L(T`${part} 已重挂（${count} 项）：\n`, T`${part} re-mounted (${count}):\n`),
  reloadPartFailed: (part: unknown) => L(T`${part} 重挂失败：\n`, T`${part} failed to re-mount:\n`),
  reloadStale: (list: string) => L(
    T`另有改动没有重挂：${list}\n要用 /project-config reload 全量重挂才会生效`,
    T`Also changed but not re-mounted: ${list}\nrun /project-config reload to pick them up`,
  ),
  reloadSettingsGone: L(
    '工作区已经没有 .dsh/settings.yml，本会话不再加载项目配置',
    'The workspace no longer has .dsh/settings.yml; this session no longer loads project settings',
  ),
  reloadMcpUnknown: (name: string, list: string) => L(T`配置里没有名为 ${name} 的 MCP 服务器（现在有：${list || '—'}）`, T`No MCP server named ${name} in the settings (now: ${list || '—'})`),
  noSettings: L('此会话没有加载项目配置（工作区没有 .dsh/settings.yml）', 'No project settings loaded for this session (no .dsh/settings.yml in the workspace)'),
  subagentSession: (name: string) => L(name ? T`子代理会话（沿用主会话的配置）：${name}` : '子代理会话（沿用主会话的配置）', name ? T`Subagent session (uses its root session's settings): ${name}` : "Subagent session (uses its root session's settings)"),
  workspace: (r: string) => L(T`工作区：${r}`, T`Workspace: ${r}`),
  settingsFile: (f: string) => L(T`配置文件：${f}`, T`Settings: ${f}`),
  // marks after an entry name: added by / replaced by settings.local.yml
  fromLocal: L('(local)', '(local)'),
  overriddenByLocal: L('(local 覆盖)', '(local override)'),
  hooksLocal: (n: number) => L(`（local ${n}）`, ` (local ${n})`),
  kind: {
    subagents: L('子代理', 'subagent'),
    commands: L('命令', 'command'),
    mcp: L('MCP', 'MCP'),
  },
  removed: (list: string) => L(T`已移除（local enabled: false）：${list}`, T`Removed (local enabled: false): ${list}`),
  subagents: (list: string) => L(T`子代理：${list}`, T`Subagents: ${list}`),
  commands: (list: string, rootOnly: unknown) => L(T`命令：${list}${rootOnly ? '（只在主会话）' : ''}`, T`Commands: ${list}${rootOnly ? ' (root session only)' : ''}`),
  mcp: (list: string) => L(T`MCP：${list}`, T`MCP: ${list}`),
  mcpServer: (name: Text | string, state: Text | string, detail: unknown) => L(
    detail ? T`MCP ${name}：${state} — ${detail}` : T`MCP ${name}：${state}`,
    detail ? T`MCP ${name}: ${state} — ${detail}` : T`MCP ${name}: ${state}`,
  ),
  hooks: (list: Text | string, stats: { runs: number; failures: number }) => L(
    T`Hooks：${list}（已运行 ${stats.runs} 次，失败 ${stats.failures} 次）`,
    T`Hooks: ${list} (runs ${stats.runs}, failures ${stats.failures})`,
  ),
  log: (f: string) => L(T`日志：${f}`, T`Log: ${f}`),
  mcpState: {
    connecting: L('连接中', 'connecting'),
    connected: L('✓ 已连接', '✓ connected'),
    unresponsive: L('⚠ 无响应', '⚠ unresponsive'),
    failed: L('✗ 连接失败', '✗ failed'),
    retrying: L('✗ 连接失败，重试中', '✗ failed, retrying'),
    stopped: L('— 已停止', '— stopped'),
    reconnecting: L('⟳ 连接断开，重连中', '⟳ disconnected, reconnecting'),
    skipped: L('— 跳过', '— skipped'),
  },
  // A connected server that stopped answering: the tools are still listed.
  mcpUnresponsive: L(
    '连续 3 次检测没有回应，工具仍在（可以用 /project-config reload mcp 重连）',
    'no reply to 3 health checks; tools kept (use /project-config reload mcp to restart it)',
  ),
  tools: (n: number) => L(`${n} 个工具`, `${n} ${n === 1 ? 'tool' : 'tools'}`),
  // cause comes from the MCP client (English, already redacted)
  mcpRetry: (cause: string | undefined, a: { n: number; max: number }) => L(
    cause ? `${cause}（第 ${a.n}/${a.max} 次重试）` : `第 ${a.n}/${a.max} 次重试`,
    cause ? `${cause} (retry ${a.n}/${a.max})` : `retry ${a.n}/${a.max}`,
  ),

  // path checks
  notFound: (rel: string) => L(`路径不存在：${rel}`, `Path not found: ${rel}`),
  wrongType: (rel: string) => L(`路径类型不符：${rel}`, `Wrong path type: ${rel}`),
  tooLarge: (rel: string) => L(`文件过大：${rel}`, `File too large: ${rel}`),

  // settings.yml
  // Prefix for messages about one file: `settings.local.yml：…`.
  inFile: (name: string, m: unknown) => L(T`${name}：${m}`, T`${name}: ${m}`),
  // YAML errors give only the position: the offending line may hold a token.
  yamlError: (at: { line: number; col: number } | undefined) => L(
    at ? `YAML 解析失败（第 ${at.line} 行第 ${at.col} 列）` : 'YAML 解析失败',
    at ? `YAML parse error at line ${at.line}, column ${at.col}` : 'YAML parse error',
  ),
  notMapping: L('顶层必须是映射', 'must be a mapping at the top level'),
  tooBig: L('超过 1MB', 'exceeds 1MB'),
  readFailed: L('读取失败', 'could not be read'),
  localIgnored: (m: unknown) => L(T`${m}，整份文件已忽略`, T`${m}; the whole file is ignored`),
  enabledShared: (where: string) => L(`${where}：enabled 只能写在 settings.local.yml 里，已忽略`, `${where}: enabled only works in settings.local.yml; ignored`),
  nothingToRemove: (where: string) => L(`${where}：settings.yml 里没有同名条目，enabled: false 无效`, `${where}: no entry of that name in settings.yml; enabled: false has no effect`),
  skillsRemoved: L('skills：已不再支持，请把 skill 放到 .dsh/skills/<名字>/SKILL.md', 'skills: no longer supported; put skills in .dsh/skills/<name>/SKILL.md'),
  unknownTop: (k: string) => L(`未知的顶层字段 "${k}"，已忽略`, `unknown top-level field "${k}" ignored`),
  unknownField: (where: string, k: string) => L(`${where}：未知字段 "${k}"，已忽略`, `${where}: unknown field "${k}" ignored`),
  notList: (f: string) => L(`${f}：必须是列表，已忽略`, `${f}: must be a list; ignored`),
  notMappingEntry: (where: string) => L(`${where}：必须是映射，已跳过`, `${where}: must be a mapping; skipped`),
  skipped: (where: string, zh: string, en: string) => L(`${where}：${zh}，已跳过`, `${where}: ${en}; skipped`),
  hooksNotMapping: L('hooks：必须是以事件名为键的映射，已忽略', 'hooks: must be a mapping of event names; ignored'),
  unknownEvent: (e: string, list: string) => L(`hooks：未知事件 "${e}"，已忽略（支持：${list}）`, `hooks: unknown event "${e}" ignored (supported: ${list})`),
  invalidMatcher: (where: string, m: string) => L(`${where}：matcher 不是合法的正则（${m}），已跳过`, `${where}: ${m}; skipped`),

  // composed with messages raised while resolving MCP servers and subagents
  envMissing: (names: string) => L(`环境变量未设置：${names}`, `environment variable not set: ${names}`),
  cwdProblem: (m: unknown) => L(T`cwd：${m}`, T`cwd: ${m}`),
  subagentProblem: (name: string, m: unknown) => L(T`子代理 ${name}：${m}`, T`subagent ${name}: ${m}`),
  commandProblem: (name: string, m: unknown) => L(T`命令 /${name}：${m}`, T`command /${name}: ${m}`),
};
