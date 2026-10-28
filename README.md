# dsh-project-config

从工作区的 `.dsh/settings.yml` 为 DSH 加载项目级的子代理、命令、MCP 服务器和 hooks。

DSH 自带的只读取项目里的 `AGENTS.md` 和 `.dsh/skills/`；子代理、命令、MCP、hooks 只能在全局配置，没法跟着项目走。

## 安装

```sh
dsh plugin --profile desktop add github:RicardoYan/dsh-project-config#v0.4.1
```

Web 端把 `desktop` 换成你的 profile 名（一般是 `web`）。装完重启 DSH。

卸载：`dsh plugin --profile desktop remove dsh-project-config`

## 配置

完整字段、hook 输入输出、从 Claude Code 迁移、常见坑和排查：**[docs/settings.md](docs/settings.md)**。

在工作区根目录放 `.dsh/settings.yml`（工作区 = 从会话目录往上最近的含 `.dsh/settings.yml` 或 `.git` 的目录）：

```yaml
subagents:
  - toolName: code-reviewer              # 成为一个同名工具
    personaFile: agents/code-reviewer.md # 相对工作区根；frontmatter 的 description 用作用途
    toolFilter: { allow: [read, grep, mcp__github__search_code] }
    agentOptions: { reasoningEffort: high }  # 指定思考档；没写的字段继承主会话
commands:
  - name: release-notes                # /release-notes
    description: 生成发布说明
    handlerFile: tools/release-notes.mjs   # export default ({ rawInput, agent, workspaceRoot }) => '文本'
mcp:
  - serverName: github                 # 工具名 mcp__github__<工具>
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' }   # ${VAR} 取 DSH 进程的环境变量；也可以把 token 明文写进 settings.local.yml
hooks:
  tools/pre-execute:                   # 还支持 tools/post-execute、agent/pre-step、agent/turn-stopping、agent/created、agent/disposed、subagent/start、subagent/end
    - matcher: pwsh|bash
      command: node .dsh/hooks/check.mjs   # 在工作区根执行；stdin 收到 JSON；退出码 2 = 拦截，stderr 作为原因
```

- 个人配置（MCP 凭据、自己的 hooks）放 `.dsh/settings.local.yml`，**加进 `.gitignore`**：写法相同，同名条目整条覆盖 `settings.yml` 的，`enabled: false` 去掉 `settings.yml` 的同名条目，hooks 接在后面。只有 `settings.yml` 存在（可以是空文件）时才读取。详见 [docs/settings.md §8](docs/settings.md#8-settingslocalyml个人配置)
- skill 放 `.dsh/skills/<名字>/SKILL.md`，由 DSH 自己读取
- 子代理、MCP、hooks 对子代理同样生效；子代理共用主会话的 MCP 连接，按自己的 `toolFilter` 过滤（MCP 工具写全名）
- 子代理再派项目子代理：把对方的名字写进自己的 `allow`，并且对方的 `maxDepth` 要够（`maxDepth` 是它最多能出现在第几层，主会话直接派的是第 1 层）
- **按子代理指定模型/思考档**用 `agentOptions`：`provider` / `model` / `reasoningEffort` / `maxTokens`，四个都可选。写哪个就指定哪个，没写的继承主会话——只写 `reasoningEffort` 就只改思考档，模型跟着主会话；要指定模型则 `provider` 和 `model` 必须一起写。详见 [docs/settings.md §3](docs/settings.md#agentoptions)
- DSH 自带的通用 `subagent` 工具每个子代理都有，`toolFilter` 管不到它，写不写都一样；嵌套层数由 DSH 的子代理层数上限控制
- `/project-config` 查看本会话加载了什么、哪些被跳过及原因，以及每个 MCP 服务器的连接状态
- `/project-config reload` 在当前会话里重挂已加载的内容，**不用新开会话**：

| 命令 | 做什么 |
|---|---|
| `/project-config reload` | 重读配置，全部重挂（子代理 + 命令 + MCP + hooks） |
| `/project-config reload subagents` | 只重挂子代理工具 |
| `/project-config reload commands` | 只重挂斜杠命令 |
| `/project-config reload mcp` | 重读 MCP 配置，全部服务器断开重连 |
| `/project-config reload mcp <名字>` | 只重建这一个服务器的连接（也从新配置读） |
| `/project-config reload hooks` | 只重挂 hooks |

  单挂一类时，别的类改了配置不会跟着生效，命令会提示「另有改动没有重挂」。reload 会中断正在进行的 MCP 调用，长任务期间别用；详见下方「reload 的风险」

## 安全边界

- 命令、MCP、hooks 会运行项目里的代码，**配置了就会在会话里运行**，没有确认步骤
- 配置里的路径相对工作区根解析，可以落在工作区外（例如经 `tools/` 这类目录链接）；只检查存在性与类型，不做范围限制
- 有 `settings.yml` 的工作区只读取自己的 `AGENTS.md` 和项目 skill，不再继承外层 git 仓库根目录的

## reload 的风险

1. **`reload`（不带参数）会让全部 MCP 服务器重连，正在跑的 MCP 调用会被中断**（拿到 `Connection closed`）。长任务期间不要执行
2. **钩子计数会归零**：`/project-config` 里的「已运行 N 次」统计的是当前挂着的 hooks，重挂后从头算
3. **正在跑的子代理会被迁移**：它们的 MCP 工具镜像和 hooks 换成新配置（reload 不会让它们丢工具）；但它们已经能派生的嵌套子代理清单（`toolFilter` 决定的那些）保持 reload 前的样子，新派生的才用新配置
4. **`reload mcp <名字>` 删不出配置项**：从配置里删掉的服务器，工具和状态行会消失，但它注册的 prompt 段落要 `reload`（不带参数）才彻底清掉。这也意味着删服务器后建议直接全量 reload
5. **子代理工具重挂后旧引用失效**：若某次调用正持有 reload 前的工具句柄，拿到的是过期定义

## 注意

- 依赖 DSH 内部接口（agent 事件、`dsh-tool-subagent`、`dsh-mcp-client` 的工具定义、DSH 自带的 MCP SDK `@modelcontextprotocol/client`、`dsh-hook-protocol`、`dsh-skill-filesystem`、`dsh-agent-instructions`），适用于 `@deepseek-ai/dsh` `>=0.2.1-rc.1 <0.3.0-0`
- 装上或卸下本插件后，已有会话继续时会多收到一份完整的 AGENTS.md（只一次）
- 改了 `settings.yml` 或 `settings.local.yml`：新开的会话生效；当前会话发 `/project-config reload` 也行（见上方风险）
- hooks 的 `command` 由 DSH 的 shell 执行：Windows 上是 PowerShell，带引号的程序路径前要加 `&`，如 `& "C:/Program Files/nodejs/node.exe" check.mjs`
- `/project-config` 和配置告警跟随 DSH 的语言设置，只显示中文或英文；字段名、事件名照原样显示
- 诊断日志：`%TEMP%\dsh-project-config.log`（超过 1MB 轮转）；MCP 的 `url`、`headers`、`env` 的值不会写进日志和 `/project-config`

## 许可证

MIT
