// User-facing strings, one language at a time (see locale.js).
// Messages are L(zh, en) values rendered when shown, so /project-config
// follows a language change. Anything interpolated may itself be an L value,
// so composed messages use the lazy `T` template.
import { L, T } from './locale.js';

export { L };

export const TEXT = {
  // /project-config
  commandDescription: L('查看本会话加载的项目配置', 'Show the project settings loaded for this session'),
  noSettings: L('此会话没有加载项目配置（工作区没有 .dsh/settings.yml）', 'No project settings loaded for this session (no .dsh/settings.yml in the workspace)'),
  subagentSession: (name) => L(name ? T`子代理会话（沿用主会话的配置）：${name}` : '子代理会话（沿用主会话的配置）', name ? T`Subagent session (uses its root session's settings): ${name}` : "Subagent session (uses its root session's settings)"),
  workspace: (r) => L(T`工作区：${r}`, T`Workspace: ${r}`),
  settingsFile: (f) => L(T`配置文件：${f}`, T`Settings: ${f}`),
  trust: (s, missing) => L(T`信任：${s}${missing ? '（未安装 dsh-workspace-trust，按不信任处理）' : ''}`, T`Trust: ${s}${missing ? ' (dsh-workspace-trust not installed, treated as untrusted)' : ''}`),
  subagents: (list) => L(T`子代理：${list}`, T`Subagents: ${list}`),
  requiresTrust: L('（需要信任）', ' (requires trust)'),
  deferredSubagents: (blocked, list) => L(T`子代理${blocked}（persona 在工作区外）：${list}`, T`Subagents${blocked} (persona outside the workspace): ${list}`),
  commands: (blocked, list, rootOnly) => L(T`命令${blocked}：${list}${rootOnly ? '（只在主会话）' : ''}`, T`Commands${blocked}: ${list}${rootOnly ? ' (root session only)' : ''}`),
  mcpBlocked: (blocked, list) => L(T`MCP${blocked}：${list}`, T`MCP${blocked}: ${list}`),
  mcpServer: (name, state, detail) => L(
    detail ? T`MCP ${name}：${state} — ${detail}` : T`MCP ${name}：${state}`,
    detail ? T`MCP ${name}: ${state} — ${detail}` : T`MCP ${name}: ${state}`,
  ),
  hooks: (blocked, list, stats) => L(
    stats ? T`Hooks${blocked}：${list}（已运行 ${stats.runs} 次，失败 ${stats.failures} 次）` : T`Hooks${blocked}：${list}`,
    stats ? T`Hooks${blocked}: ${list} (runs ${stats.runs}, failures ${stats.failures})` : T`Hooks${blocked}: ${list}`,
  ),
  log: (f) => L(T`日志：${f}`, T`Log: ${f}`),
  state: {
    trusted: L('已信任', 'Trusted'),
    untrusted: L('不信任', 'Not trusted'),
    unknown: L('未选择', 'Not chosen'),
  },
  mcpState: {
    connecting: L('连接中', 'connecting'),
    connected: L('✓ 已连接', '✓ connected'),
    failed: L('✗ 连接失败', '✗ failed'),
    skipped: L('— 跳过', '— skipped'),
  },
  tools: (n) => L(`${n} 个工具`, `${n} tools`),

  // built-in path check (only used without dsh-workspace-trust)
  badPath: (rel, problem) => L(`路径写法不允许：${rel}（${problem.zh}）`, `Path not allowed: ${rel} (${problem.en})`),
  notFound: (rel) => L(`路径不存在：${rel}`, `Path not found: ${rel}`),
  outsideNoTrust: (p) => L(`路径在工作区外，未安装 dsh-workspace-trust 时不允许：${p}`, `Path is outside the workspace; not allowed without dsh-workspace-trust: ${p}`),
  wrongType: (rel) => L(`路径类型不符：${rel}`, `Wrong path type: ${rel}`),
  tooLarge: (rel) => L(`文件过大：${rel}`, `File too large: ${rel}`),
  pathProblem: {
    empty: { zh: '路径为空', en: 'empty path' },
    nul: { zh: '含有 NUL 字符', en: 'contains NUL' },
    home: { zh: '不能以 ~ 开头', en: 'home-relative paths are not allowed' },
    absolute: { zh: '不能是绝对路径', en: 'absolute paths are not allowed' },
    escape: { zh: '跳出了工作区', en: 'escapes the workspace' },
  },

  // settings.yml
  yamlError: (e) => L(`YAML 解析失败：${e}`, `YAML parse error: ${e}`),
  notMapping: L('settings.yml 顶层必须是映射', 'settings.yml must be a mapping at the top level'),
  tooBig: L('settings.yml 超过 1MB', 'settings.yml exceeds 1MB'),
  skillsRemoved: L('skills：已不再支持，请把 skill 放到 .dsh/skills/<名字>/SKILL.md', 'skills: no longer supported; put skills in .dsh/skills/<name>/SKILL.md'),
  unknownTop: (k) => L(`未知的顶层字段 "${k}"，已忽略`, `unknown top-level field "${k}" ignored`),
  unknownField: (where, k) => L(`${where}：未知字段 "${k}"，已忽略`, `${where}: unknown field "${k}" ignored`),
  notList: (f) => L(`${f}：必须是列表，已忽略`, `${f}: must be a list; ignored`),
  notMappingEntry: (where) => L(`${where}：必须是映射，已跳过`, `${where}: must be a mapping; skipped`),
  skipped: (where, zh, en) => L(`${where}：${zh}，已跳过`, `${where}: ${en}; skipped`),
  hooksNotMapping: L('hooks：必须是以事件名为键的映射，已忽略', 'hooks: must be a mapping of event names; ignored'),
  unknownEvent: (e, list) => L(`hooks：未知事件 "${e}"，已忽略（支持：${list}）`, `hooks: unknown event "${e}" ignored (supported: ${list})`),
  invalidMatcher: (where, m) => L(`${where}：matcher 不是合法的正则（${m}），已跳过`, `${where}: ${m}; skipped`),

  // composed with messages that may come from dsh-workspace-trust (plain strings) or from here (L values)
  envMissing: (names) => L(`环境变量未设置：${names}`, `environment variable not set: ${names}`),
  cwdProblem: (m) => L(T`cwd：${m}`, T`cwd: ${m}`),
  subagentProblem: (name, m) => L(T`子代理 ${name}：${m}`, T`subagent ${name}: ${m}`),
  commandProblem: (name, m) => L(T`命令 /${name}：${m}`, T`command /${name}: ${m}`),
};
