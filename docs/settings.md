# `.dsh/settings.yml` 配置说明

本文是 dsh-project-config 的完整配置参考。快速上手看 [README](../README.md)；写配置、排查问题看这里。

## 1. 先看这几条（最常踩的坑）

1. **文件名只认 `.dsh/settings.yml`**，外加个人用的 `.dsh/settings.local.yml`（见 §7）。其他文件名（如 `project-config.yml`）不读取，也不提示
2. **凭据写在 `settings.local.yml`，并把它加进 `.gitignore`**。`settings.yml` 会提交到 git，不要写 token
3. **改完配置要新开会话**才生效；当前会话发 `/project-config` 看读到了什么、哪些被跳过、为什么
4. **写错的字段不会报错**，只在 `/project-config` 里给一条 `⚠`。改完配置先看一眼
5. **工具名用 DSH 的名字**：`read`、`write`、`edit`、`grep`、`glob`、`pwsh`（Windows）/ `bash`（macOS、Linux），不是 `Read`、`Bash`。`toolFilter` 里写了当前 DSH 不存在的工具名，这个子代理会启动失败
6. **命令、MCP、hooks 要工作区已信任才运行**（需要装 [dsh-workspace-trust](https://github.com/RicardoYan/dsh-workspace-trust)），子代理不需要
7. **`skills` 字段已不支持**：skill 放 `.dsh/skills/<名字>/SKILL.md`，DSH 自己读
8. **hooks 的事件名是 DSH 的**（`tools/pre-execute`），不是 `PreToolUse`；Windows 上 hook 命令由 PowerShell 执行

## 2. 文件位置与工作区

- 工作区根：从会话目录往上，最近的一个含 `.dsh/settings.yml` 或 `.git` 的目录；都没有时就是会话目录本身
- 只有工作区根下真有 `.dsh/settings.yml`，本插件才对该会话生效
- 配置里的所有路径（`personaFile`、`handlerFile`、MCP `cwd`）都**相对工作区根**写；不接受绝对路径、`~`、盘符，也不能用 `..` 跳出工作区
- 路径（含符号链接跟随后的真实路径）指向工作区外时，需要工作区已信任，且不在禁止访问列表里
- `.dsh` 本身可以是指向别处的符号链接（含 Windows junction），比如几个项目共用一份配置：`settings.yml` 和 `.dsh/skills/` 照常读取，工作区根仍是放链接的这个目录。但 `.dsh/` 里的 persona、命令文件算作工作区外，未信任时这些子代理不可用（`/project-config` 显示「需要信任」）；链接目标在禁止访问列表里时，即使已信任也不可用
- 有 `settings.yml` 的工作区只读自己的 `AGENTS.md` / `CLAUDE.md` 和 `.dsh/skills/`、`.agents/skills/`，**不再继承外层 git 仓库根目录的**。例如 monorepo 的子目录 `packages/app` 放了 `settings.yml`，它就是一个独立的工作区：外层仓库根的 `AGENTS.md` 不会被读到；`packages/shared` 对它来说也在工作区外
- `settings.yml`、`settings.local.yml` 和 persona 文件各不超过 1MB；YAML 顶层必须是映射

顶层只有四个字段，都可省略：

```yaml
subagents: []   # 子代理
commands: []    # 斜杠命令
mcp: []         # MCP 服务器
hooks: {}       # hooks
```

每个条目单独校验：一条写错只跳过这一条，不影响其他条目。

## 3. `subagents`：子代理

每个条目注册一个与 `toolName` 同名的工具，模型调用它就派出一个带指定 persona 的子代理。

```yaml
subagents:
  - toolName: code-reviewer                 # 必填
    personaFile: .dsh/agents/code-reviewer.md   # 必填
    description: 审查代码改动并指出问题      # 可选
    toolFilter:                             # 可选
      allow: [read, grep, glob, mcp__github__search_code]
    maxDepth: 1                             # 可选，默认 1
    backgroundMode: continuable             # 可选，默认 continuable
    provider: spawn                         # 可选，默认 spawn，一般不用改
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `toolName` | 是 | 小写字母开头，只含 `a-z 0-9 _ -`。不要与 DSH 自带工具同名，否则会把自带工具遮住 |
| `personaFile` | 是 | persona 文件（Markdown）。开头的 YAML frontmatter 会被去掉，正文作为子代理的系统提示 |
| `description` | 否 | 用途，显示在主会话的「项目子代理」清单里，模型据此选择。省略时用 persona frontmatter 的 `description` |
| `toolFilter` | 否 | `allow`（白名单）和/或 `deny`（黑名单），见下 |
| `maxDepth` | 否 | 这个子代理**最多能出现在第几层**。主会话直接派出的是第 1 层；默认 1，表示只有主会话能派它 |
| `backgroundMode` | 否 | `continuable`：默认后台运行，结束时通知主会话，之后还能继续对话；`one-shot`：默认前台运行，等结果 |
| `provider` | 否 | DSH 的子代理提供方，默认 `spawn`（全新子会话，看不到主会话的对话） |

persona 文件示例：

```markdown
---
description: 审查代码改动并指出问题
---
你是代码审查员。只读代码，不修改文件。……
```

### `toolFilter`

- 不写：子代理拥有和主会话一样的工具
- `allow` 是白名单：**没列出的都没有**。写了 `allow` 却漏掉 `read`，子代理就读不了文件
- 工具名必须是当前 DSH 里存在的（见 §1 第 5 条）。启动失败时报错 `tools.restrict() names unknown global tool "..."`，后面会列出可用的工具名
- MCP 工具写全名：`mcp__<serverName>__<工具名>`
- DSH 自带的通用 `subagent` 工具（和 `list_subagent_models`）每个子代理都有，`toolFilter` 管不到，写不写都一样；它能嵌套几层由 DSH 设置里的子代理层数上限决定

### 子代理再派项目子代理

两个条件都要满足：

1. 上层子代理的 `allow` 里写了下层的名字（或不写 `toolFilter`）
2. 下层子代理的 `maxDepth` ≥ 它所在的层数

```yaml
subagents:
  - toolName: planner
    personaFile: .dsh/agents/planner.md
    toolFilter: { allow: [read, grep, glob, code-reviewer] }   # 1. 允许派 code-reviewer
  - toolName: code-reviewer
    personaFile: .dsh/agents/code-reviewer.md
    maxDepth: 2                                              # 2. planner 派出的 code-reviewer 在第 2 层
```

## 4. `commands`：斜杠命令

在输入框发 `/<name>` 时运行工作区里的一个 JS 文件，结果只显示在界面上，**不发给模型**。只在主会话里有，子代理里没有。需要工作区已信任。

```yaml
commands:
  - name: release-notes                  # 必填，/release-notes
    description: 生成发布说明             # 必填，命令列表里显示
    handlerFile: .dsh/commands/release-notes.mjs   # 必填
    input: { hint: '<版本号>' }          # 要带参数就必须写（见下）；attachments: true 允许带附件
```

处理文件按 ES 模块加载（建议用 `.mjs` 扩展名）：

```js
// 导出 default 函数，或命名导出 handler
export default async ({ rawInput, workspaceRoot, agent, attachments, signal }) => {
  const version = rawInput.trim();      // rawInput 是命令名之后的全部文字，含前面的空格
  if (!version) return { kind: 'error', text: '用法：/release-notes <版本号>' };
  return `v${version} 的发布说明……`;    // 返回字符串 = 成功
};
```

- **要接收参数，必须写 `input`**：没写 `input` 的命令只能单独发 `/<name>`；后面带了文字（如 `/release-notes 1.2`），DSH 输入框会把整行当普通消息发给模型，命令不会执行。写了 `input` 后，选中命令或输入 `/<name>` 加空格，输入框会显示 `hint`，接着输入参数再回车
- 返回值：字符串；或 `{ kind: 'success' | 'error', text }`；其他值按 JSON 显示；抛异常显示为错误
- 处理文件改了**不用新开会话**，下次执行时自动重新加载（`settings.yml` 本身改了仍要新开会话）
- 不要和 DSH 自带命令同名，否则在这个会话里会把自带命令遮住

## 5. `mcp`：MCP 服务器

需要工作区已信任。每个主会话连一次，**子代理共用主会话的连接**，按各自的 `toolFilter` 过滤。第一次调用模型前会等所有服务器第一次连接出结果。连接由本插件自己管理（用 DSH 自带的 MCP SDK），行为和 DSH 内置的 MCP 客户端一致：工具名 `mcp__<serverName>__<工具>`、服务器说明加进系统提示、资源可用 DSH 的 MCP 资源工具读取、工具列表变化自动刷新。

```yaml
mcp:
  - serverName: github                    # 必填，工具名为 mcp__github__<工具>
    transport: stdio                      # 必填：stdio 或 streamable-http
    command: npx                          # stdio 必填
    args: ['-y', '@modelcontextprotocol/server-github']
    env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' }
    cwd: tools                            # 可选，默认工作区根
  - serverName: docs
    transport: streamable-http
    url: http://localhost:3000/mcp        # streamable-http 必填
    headers: { Authorization: 'Bearer ${DOCS_TOKEN}' }
```

| 字段 | 说明 |
|---|---|
| `serverName` | 只含 `A-Z a-z 0-9 _ -`，最长 32 |
| `transport` | `stdio` 或 `streamable-http`（不支持 SSE） |
| `command` / `args` / `env` / `cwd` | 仅 stdio。直接启动程序，不经过 shell；`args` 里的相对路径相对 `cwd` |
| `url` / `headers` | 仅 streamable-http |
| `toolCallTimeoutMs` | 每次调用超时，默认 60000 |
| `failOnStartupError` | 默认 `false`；`true` 时第一次连不上就不再重试（状态「连接失败」），可以用 `/project-config reconnect` 手动重连 |
| `maxInstructionBytes` | 服务器说明文字上限，默认 32768 |
| `reconnect` | 自动重连：`enabled`（默认 true）、`initialDelayMs`（默认 500）、`maxDelayMs`（默认 30000）、`maxAttempts`（默认 10）。间隔从 `initialDelayMs` 起每次翻倍，最长 `maxDelayMs`；连续失败 `maxAttempts` 次后放弃，工具移除。连上后稳定超过 `maxDelayMs`，次数重新计算 |

**凭据怎么传（重要）**

**不要把 token 明文写进 `settings.yml`**，它会被提交到 git。两种方式任选：

1. **明文写在 `settings.local.yml`**（推荐个人使用）：在 `settings.local.yml` 里写一条同名的完整条目，覆盖 `settings.yml` 里的那条（见 §7）。别忘了把它加进 `.gitignore`

   ```yaml
   # .dsh/settings.yml（提交）
   mcp:
     - serverName: docs
       transport: streamable-http
       url: https://docs.example.com/mcp
   # .dsh/settings.local.yml（不提交）
   mcp:
     - serverName: docs
       transport: streamable-http
       url: https://docs.example.com/mcp
       headers: { Authorization: 'Bearer <你的 token>' }
   ```

2. **`${VAR}` 从环境变量取值**（适合 CI 或共享机器）：`env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' }`
   - `${VAR}` 在 `command`、`args`、`env`、`url`、`headers` 里都可用（两个文件里都行）；变量不存在时，这个服务器跳过，`/project-config` 写明缺哪个变量
   - 改了系统环境变量要重启 DSH 才能读到

另外：

- DSH 启动子进程时会去掉名字含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD` 的环境变量。所以即使你本机设了 `GITHUB_TOKEN`，stdio 的 MCP 服务器默认也拿不到，要在 `env` 里显式写出来
- `url`、`headers`、`env` 的值不会出现在 `/project-config`、告警和诊断日志里：MCP 报错里出现这些值时会换成 `***`

**状态和重连**

`/project-config` 显示每个服务器当前的连接状态（查看时会先 ping 一下已连接的服务器，所以悄悄挂掉的也能发现）：

| 状态 | 含义 |
|---|---|
| `✓ 已连接 — N 个工具` | 正常 |
| `✗ 连接失败，重试中 — 原因（第 i/n 次重试）` | 还没连上过，正在自动重试 |
| `⟳ 连接断开，重连中 — 原因（第 i/n 次重试）` | 连上过，后来断了；重连期间工具还在，调用会报错 |
| `✗ 连接失败 — 原因` | 已放弃自动重试，工具已移除 |
| `— 跳过 — 原因` | 没有启动（缺环境变量、`cwd` 不合法、`reconnect` 写错） |

原因是 MCP 连接返回的真实错误（如 `HTTP 401`、`fetch failed`）；stdio 服务器还会附上它最后几行 stderr。

**手动重连**（不用重启 DSH，也不用新开会话）：

- `/project-config reconnect`：重连所有没连上的服务器
- `/project-config reconnect <名字>`：重连这一个，已连上的也会断开重连（比如服务器重启过、换了 token）
- 立即重连，重试次数清零；命令等这次连接有结果后返回状态
- 第一次调用模型前只等第一次连接；之后才连上的服务器，工具在下一次调用模型时出现

**连接什么时候断开**

- 每个打开过的主会话各有一份连接（stdio 就是各一个子进程）。DSH 打开过的会话会一直留在内存里直到 DSH 退出，关掉窗口或归档都不会释放，所以它的连接也一直在
- 会话被删除（如用 dsh-session-delete）、本插件被卸载或重新加载时，连接立即断开，stdio 子进程随之退出
- 工具名和已注册的工具重名时（比如别的插件或 DSH 配置里有同名服务器），直接判为「连接失败」，不再自动重试；去掉冲突后用 `/project-config reconnect <名字>`


## 6. `hooks`

需要工作区已信任。键是事件名，值是一组 hook；主会话和子代理里都生效。

```yaml
hooks:
  tools/pre-execute:
    - matcher: pwsh|bash                  # 可选，见下
      command: node .dsh/hooks/guard.mjs  # 必填，在工作区根执行
      timeout: 30                         # 可选，秒，默认 600
  tools/post-execute:
    - matcher: read
      command: node .dsh/hooks/note.mjs
```

### 事件

| 事件 | 时机 | matcher 匹配 | 能做什么 |
|---|---|---|---|
| `tools/pre-execute` | 工具执行前 | 工具名 | 拦截（原因给模型）；`ask` 转交 DSH 审批 |
| `tools/post-execute` | 工具执行后 | 工具名 | 拦下结果（原因作为反馈给模型）；附加上下文到结果后 |
| `agent/pre-step` | 用户发消息后、调用模型前 | — | 拒绝这条消息；附加上下文 |
| `agent/turn-stopping` | 模型准备结束本轮时 | — | 拦截 = 不结束，把原因作为新消息让模型继续 |
| `agent/created` | 会话创建 | `startup` / `resume` | 附加上下文到会话 |
| `agent/disposed` | 会话关闭 | — | 只通知 |
| `subagent/start`、`subagent/end` | 子代理开始 / 结束 | — | 只通知，后台运行 |

- 标「—」的事件**不要写 `matcher`**，写了就永远匹配不上
- `agent/turn-stopping` 拦截会让模型继续工作，hook 里要有结束条件，否则会一直循环
- `agent/created` 只在会话创建时工作区已信任才运行：工作区第一次弹信任询问的那个会话不会触发
- 从 Claude Code 迁移：`PreToolUse` → `tools/pre-execute`，`PostToolUse` → `tools/post-execute`，`UserPromptSubmit` → `agent/pre-step`，`Stop` → `agent/turn-stopping`，`SessionStart` → `agent/created`，`SessionEnd` → `agent/disposed`，`SubagentStart` / `SubagentStop` → `subagent/start` / `subagent/end`

### matcher

- 省略、空串或 `*`：匹配全部
- 只含字母、数字、`_`、`|`：按字面量匹配，`|` 分隔多个，必须完全相等（`read` 不匹配 `read_image`）
- 其他写法按正则匹配（不加锚点，`^read$` 才是精确匹配）；正则写错这条 hook 跳过
- 匹配的是 DSH 工具名：Windows 上执行命令的工具是 `pwsh`，不是 `Bash`；MCP 工具是 `mcp__<服务器>__<工具>`

### 输入

stdin 收到一行 JSON：

| 字段 | 出现于 |
|---|---|
| `event`、`session_id`、`cwd`、`workspace_root` | 全部 |
| `tool_name`、`tool_input`、`tool_use_id` | `tools/*` |
| `tool_response`（结果的文字部分） | `tools/post-execute` |
| `prompt` | `agent/pre-step` |
| `source` | `agent/created` |
| `agent_id`、`provider`（`subagent/end` 另有 `stop_reason`） | `subagent/*` |

环境变量额外有 `DSH_PROJECT_DIR`（工作区根）。和 MCP 一样，名字含 `KEY`/`TOKEN`/`SECRET`/`PASSWORD` 的环境变量不会传给 hook。

### 输出

- **退出码 0**：放行。stdout 若是 JSON，可以带：
  - `{"hookSpecificOutput": {"permissionDecision": "deny" | "ask" | "allow", "permissionDecisionReason": "原因"}}`
  - `{"hookSpecificOutput": {"additionalContext": "附加给模型的文字"}}`
  - `{"decision": "block", "reason": "原因"}`（等同 deny）
- **退出码 2**：拦截，stderr 作为原因给模型
- **其他退出码**：hook 失败，不拦截，操作照常；记在日志里，`/project-config` 显示失败次数
- 同一事件匹配多个 hook 时按顺序全部执行，取最严的结果（deny > ask > allow），附加上下文全部保留
- `continue: false`、`updatedInput`（改写工具参数）不生效

示例（拦截含 `rm -rf` 的命令）：

```js
// .dsh/hooks/guard.mjs
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const input = JSON.parse(s);
  if (JSON.stringify(input.tool_input ?? {}).includes('rm -rf')) {
    process.stderr.write('禁止 rm -rf');
    process.exit(2);
  }
});
```

### 执行环境

- 命令由 DSH 的 shell 执行：Windows 上是 PowerShell，macOS / Linux 上是 bash。工作目录是工作区根
- Windows 上带引号的程序路径前要加 `&`：`& "C:/Program Files/nodejs/node.exe" .dsh/hooks/guard.mjs`
- hook 受当前会话的沙箱限制：会话是只读模式时，hook 也写不了文件

## 7. `settings.local.yml`：个人配置

和 `settings.yml` 放在同一个目录（`.dsh/`），放只属于你自己的配置：MCP 凭据、个人的 hooks、自己才用的子代理。**要把它加进 `.gitignore`**（插件不检查它有没有被 git 跟踪）：

```gitignore
.dsh/settings.local.yml
```

- **只有 `settings.yml` 存在时才读取**（`settings.yml` 可以是空文件）。只有 `settings.local.yml` 时什么都不加载
- 写法和 `settings.yml` 完全一样：同样的四个顶层字段、字段规则、路径规则（相对工作区根）、`${VAR}`、1MB 上限
- 信任规则也一样：命令、MCP、hooks 要工作区已信任，子代理不需要
- `.dsh` 是链接时，从链接目标里读

### 合并规则

两个文件各自校验，再合并：

| 字段 | 按什么匹配 | 规则 |
|---|---|---|
| `subagents` | `toolName` | 同名：local 的整条替换 shared 的，位置不变；新名字：加在末尾 |
| `commands` | `name` | 同上 |
| `mcp` | `serverName` | 同上 |
| `hooks` | 事件名 | 同一事件：shared 的 hook 在前，local 的接在后面（不覆盖） |

- **整条替换，不合并字段**：local 里写了 `- serverName: docs`，就要写全 `transport`、`url`、`headers`，shared 那条的字段一个都不会留下
- local 里某条写错，只跳过这一条，shared 里的同名条目照常生效
- local 文件 YAML 写坏了（或顶层不是映射、超过 1MB）：整份 local 忽略，shared 照常生效，`/project-config` 给一条 `⚠`

### `enabled: false`：去掉 shared 里的条目

不想用 shared 里的某个子代理、命令或 MCP 服务器时，在 local 里写同名条目加 `enabled: false`，其他字段不用写：

```yaml
# .dsh/settings.local.yml
mcp:
  - serverName: github
    enabled: false
```

- 只在 `settings.local.yml` 里有效。写在 `settings.yml` 里会给 `⚠` 并被忽略，条目照常加载
- shared 里没有同名条目时给 `⚠`
- hooks 没有 `enabled`

### 在 `/project-config` 里

- 「配置文件」一行列出两个文件
- 来自 local 的条目名字后面标 `(local)`，覆盖了 shared 的标 `(local 覆盖)`；hooks 标出其中几个来自 local，如 `tools/pre-execute ×3（local 1）`
- 被 `enabled: false` 去掉的列在「已移除」一行
- 告警前面写明来自哪个文件：`settings.local.yml：mcp[0] (docs)：……`

## 8. 从 Claude Code 迁移

本插件只读 `.dsh/settings.yml`，不读 `.claude/` 下的任何配置，需要手动搬：

| Claude Code | 这里 |
|---|---|
| `.claude/agents/<名字>.md` | `subagents` 条目，`personaFile` 指向原文件即可（frontmatter 会被去掉）；frontmatter 里的 `tools` 不会被读取，要改写成 `toolFilter.allow`，并换成 DSH 工具名 |
| `.claude/commands/*.md`（提示词模板） | 不支持。这里的命令运行 JS，结果不发给模型；提示词模板可以改成 skill |
| `.claude/settings.json` 的 `hooks` | `hooks`，事件名按 §6 换；matcher 里的 `Bash` 换成 `pwsh` / `bash`，`Read` 换成 `read` 等 |
| `.mcp.json` 的 `mcpServers` | `mcp` 列表：键名变成 `serverName`，`type` 变成 `transport`（`http` → `streamable-http`）。不含凭据、要提交的放 `settings.yml` |
| 被 gitignore、含 token 的 `.mcp.json` | `settings.local.yml` 的 `mcp`（凭据可以明文写，见 §7） |
| `.claude/settings.local.json` | `settings.local.yml`（同样的合并思路，规则见 §7） |
| `CLAUDE.md` | 原样可用（DSH 读 `AGENTS.md` 和 `CLAUDE.md`） |

## 9. 排查

| 现象 | 看哪里 |
|---|---|
| 子代理、命令、MCP 都没出现 | `/project-config`：是否读到了 `settings.yml`、工作区根是不是你以为的那个目录 |
| `settings.local.yml` 没生效 | 有没有 `settings.yml`（可以是空的）；`/project-config` 的「配置文件」一行有没有列出它；有没有「整份文件已忽略」的 `⚠` |
| local 覆盖后 MCP 少了字段 | 整条替换，不合并字段：local 那条要写全 |
| 命令、MCP、hooks 显示「需要信任」 | `/workspace-trust trust` |
| 子代理启动失败 | 多半是 `toolFilter` 写了不存在的工具名，看报错里列出的可用工具 |
| 子代理里没有某个工具 | 它的 `allow` 没列出来；MCP 工具要写全名 |
| 子代理派不出下层子代理 | §3「子代理再派项目子代理」两个条件 |
| MCP「跳过」 | 缺环境变量、`cwd` 不合法，或 `reconnect` 写错 |
| MCP「连接失败」「重试中」 | 看后面的原因；stdio 先在终端里用同样的 `command` / `args` 跑一下。修好后 `/project-config reconnect <名字>` |
| MCP「连接失败 — tool registration failed: … already registered」 | 有同名工具：换一个 `serverName`，或去掉另一边的同名服务器 |
| stdio 子进程很多 | 每个打开过的主会话一个，直到 DSH 退出或会话被删除（§5「连接什么时候断开」） |
| hook 不触发 | 事件名、matcher 写法；标「—」的事件不能写 matcher |
| hook 应拦截却没拦 | 退出码必须正好是 2；或 JSON 写在 stdout 且退出码为 0 |

诊断日志：`%TEMP%\dsh-project-config.log`（macOS / Linux 为系统临时目录下同名文件），超过 1MB 轮转。
