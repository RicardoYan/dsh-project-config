// User-facing strings, one language at a time (see locale.js).
// Messages are L(zh, en) values rendered when shown, so /project-config
// follows a language change. Anything interpolated may itself be an L value,
// so composed messages use the lazy `T` template.
import { L, T } from './locale.js';
export { L };
export const TEXT = {
    // /project-config
    commandDescription: L('查看本会话加载的项目配置；reconnect 重连 MCP', 'Show the project settings loaded for this session; reconnect MCP servers'),
    commandUsage: L('用法：/project-config 查看状态；/project-config reconnect 重连所有未连上的 MCP 服务器；/project-config reconnect <名字> 重连指定的服务器', 'Usage: /project-config shows the status; /project-config reconnect reconnects every MCP server that is not connected; /project-config reconnect <name> reconnects that server'),
    reconnectNoMcp: L('本会话没有项目 MCP 服务器', 'This session has no project MCP servers'),
    reconnectUnknown: (name, list) => L(`没有名为 ${name} 的 MCP 服务器（本会话有：${list || '—'}）`, `No MCP server named ${name} (this session has: ${list || '—'})`),
    reconnectNothing: L('所有 MCP 服务器都已连接；要强制重连某一个，请写上它的名字', 'Every MCP server is connected; name one to force a reconnect'),
    reconnectSkipped: (name, reason) => L(T `MCP 服务器 ${name} 在挂载时就被跳过了，重连无法恢复（${reason}）；请修好配置后新开会话`, T `MCP server ${name} was skipped while mounting and cannot be reconnected (${reason}); fix the config, then start a new session`),
    reconnectAllSkipped: (list) => L(T `没有可重连的服务器；以下服务器在挂载时就被跳过了，修好配置后新开会话才会生效：${list}`, T `Nothing to reconnect; these servers were skipped while mounting, so a settings fix takes effect in a new session: ${list}`),
    noSettings: L('此会话没有加载项目配置（工作区没有 .dsh/settings.yml）', 'No project settings loaded for this session (no .dsh/settings.yml in the workspace)'),
    subagentSession: (name) => L(name ? T `子代理会话（沿用主会话的配置）：${name}` : '子代理会话（沿用主会话的配置）', name ? T `Subagent session (uses its root session's settings): ${name}` : "Subagent session (uses its root session's settings)"),
    workspace: (r) => L(T `工作区：${r}`, T `Workspace: ${r}`),
    settingsFile: (f) => L(T `配置文件：${f}`, T `Settings: ${f}`),
    // marks after an entry name: added by / replaced by settings.local.yml
    fromLocal: L('(local)', '(local)'),
    overriddenByLocal: L('(local 覆盖)', '(local override)'),
    hooksLocal: (n) => L(`（local ${n}）`, ` (local ${n})`),
    kind: {
        subagents: L('子代理', 'subagent'),
        commands: L('命令', 'command'),
        mcp: L('MCP', 'MCP'),
    },
    removed: (list) => L(T `已移除（local enabled: false）：${list}`, T `Removed (local enabled: false): ${list}`),
    subagents: (list) => L(T `子代理：${list}`, T `Subagents: ${list}`),
    commands: (list, rootOnly) => L(T `命令：${list}${rootOnly ? '（只在主会话）' : ''}`, T `Commands: ${list}${rootOnly ? ' (root session only)' : ''}`),
    mcp: (list) => L(T `MCP：${list}`, T `MCP: ${list}`),
    mcpServer: (name, state, detail) => L(detail ? T `MCP ${name}：${state} — ${detail}` : T `MCP ${name}：${state}`, detail ? T `MCP ${name}: ${state} — ${detail}` : T `MCP ${name}: ${state}`),
    hooks: (list, stats) => L(T `Hooks：${list}（已运行 ${stats.runs} 次，失败 ${stats.failures} 次）`, T `Hooks: ${list} (runs ${stats.runs}, failures ${stats.failures})`),
    log: (f) => L(T `日志：${f}`, T `Log: ${f}`),
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
    mcpUnresponsive: L('连续 3 次检测没有回应，工具仍在（可以用 /project-config reconnect 重连）', 'no reply to 3 health checks; tools kept (use /project-config reconnect to restart it)'),
    tools: (n) => L(`${n} 个工具`, `${n} ${n === 1 ? 'tool' : 'tools'}`),
    // cause comes from the MCP client (English, already redacted)
    mcpRetry: (cause, a) => L(cause ? `${cause}（第 ${a.n}/${a.max} 次重试）` : `第 ${a.n}/${a.max} 次重试`, cause ? `${cause} (retry ${a.n}/${a.max})` : `retry ${a.n}/${a.max}`),
    // path checks
    notFound: (rel) => L(`路径不存在：${rel}`, `Path not found: ${rel}`),
    wrongType: (rel) => L(`路径类型不符：${rel}`, `Wrong path type: ${rel}`),
    tooLarge: (rel) => L(`文件过大：${rel}`, `File too large: ${rel}`),
    // settings.yml
    // Prefix for messages about one file: `settings.local.yml：…`.
    inFile: (name, m) => L(T `${name}：${m}`, T `${name}: ${m}`),
    // YAML errors give only the position: the offending line may hold a token.
    yamlError: (at) => L(at ? `YAML 解析失败（第 ${at.line} 行第 ${at.col} 列）` : 'YAML 解析失败', at ? `YAML parse error at line ${at.line}, column ${at.col}` : 'YAML parse error'),
    notMapping: L('顶层必须是映射', 'must be a mapping at the top level'),
    tooBig: L('超过 1MB', 'exceeds 1MB'),
    readFailed: L('读取失败', 'could not be read'),
    localIgnored: (m) => L(T `${m}，整份文件已忽略`, T `${m}; the whole file is ignored`),
    enabledShared: (where) => L(`${where}：enabled 只能写在 settings.local.yml 里，已忽略`, `${where}: enabled only works in settings.local.yml; ignored`),
    nothingToRemove: (where) => L(`${where}：settings.yml 里没有同名条目，enabled: false 无效`, `${where}: no entry of that name in settings.yml; enabled: false has no effect`),
    skillsRemoved: L('skills：已不再支持，请把 skill 放到 .dsh/skills/<名字>/SKILL.md', 'skills: no longer supported; put skills in .dsh/skills/<name>/SKILL.md'),
    unknownTop: (k) => L(`未知的顶层字段 "${k}"，已忽略`, `unknown top-level field "${k}" ignored`),
    unknownField: (where, k) => L(`${where}：未知字段 "${k}"，已忽略`, `${where}: unknown field "${k}" ignored`),
    notList: (f) => L(`${f}：必须是列表，已忽略`, `${f}: must be a list; ignored`),
    notMappingEntry: (where) => L(`${where}：必须是映射，已跳过`, `${where}: must be a mapping; skipped`),
    skipped: (where, zh, en) => L(`${where}：${zh}，已跳过`, `${where}: ${en}; skipped`),
    hooksNotMapping: L('hooks：必须是以事件名为键的映射，已忽略', 'hooks: must be a mapping of event names; ignored'),
    unknownEvent: (e, list) => L(`hooks：未知事件 "${e}"，已忽略（支持：${list}）`, `hooks: unknown event "${e}" ignored (supported: ${list})`),
    invalidMatcher: (where, m) => L(`${where}：matcher 不是合法的正则（${m}），已跳过`, `${where}: ${m}; skipped`),
    // composed with messages raised while resolving MCP servers and subagents
    envMissing: (names) => L(`环境变量未设置：${names}`, `environment variable not set: ${names}`),
    cwdProblem: (m) => L(T `cwd：${m}`, T `cwd: ${m}`),
    subagentProblem: (name, m) => L(T `子代理 ${name}：${m}`, T `subagent ${name}: ${m}`),
    commandProblem: (name, m) => L(T `命令 /${name}：${m}`, T `command /${name}: ${m}`),
};
