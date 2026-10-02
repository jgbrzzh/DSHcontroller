# DSHcontroller

**通过 MCP，让 Codex 接入正在运行的 DeepSeek Harness，并操作 DSHL 原生窗口。**

A local MCP server for controlling existing DeepSeek Harness sessions and the DSHL Windows UI.

DSHcontroller 提供 **28 个 MCP 工具**，覆盖会话、任务、模型、设置、插件与原生界面。任务由 DSH 已配置的模型执行，Controller 使用 DSH 的 HTTP RPC 和 WebSocket 事件观察结果，并通过 Windows UI Automation 操作界面。

> 当前为 Windows 上的预览版本，适配 DSH **0.1.7-rc.2**。该项目独立维护，未隶属于 DeepSeek 或 OpenAI。GitHub 发布的是源码，目前没有 npm 安装包或预编译发行包。

## 能做什么

- 发现并接入现有 DSH 实例，列出、查找、创建、重命名和读取会话。
- 将任务发送到指定会话，排队或引导执行，观察本次请求的结果并取消任务。
- 按会话选择模型和推理强度，读取配置及插件状态。
- 修改普通设置并保存加密回滚前值，通过 DSH 原有接口管理插件。
- 查看持续型子代理，并提供续发、停止和会话分叉接口。
- 读取 DSHL 可访问控件、截图、打开会话或面板，执行点击、填写和按键等动作。

已经实测：MCP 初始化与调用、现有实例认证、核心会话操作、模型切换、任务完成和停止、原生截图及会话/插件页打开。部分管理写操作仍需进一步验收，见 [实现与验收记录](docs/IMPLEMENTATION.md)。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows |
| Node.js | 24 或以上，需提供 node:sqlite |
| .NET | .NET 8 SDK，以及 Windows Desktop Runtime 8 |
| DSH | 已启动的 0.1.7-rc.2 实例 |
| 界面控制 | DSHL 原生窗口；最小化时先恢复 |

当前发现器针对 DSHL 的 versions/<version>/node_modules 安装布局，并以父进程关系关联原生窗口。其他安装布局、普通浏览器窗口、Linux 和 macOS 尚未适配。

## 快速开始

先安装上述运行环境，在 DSHL 中启动 DSH，再执行：

~~~powershell
git clone https://github.com/jgbrzzh/DSHcontroller.git
Set-Location DSHcontroller
npm ci --ignore-scripts
npm run build
npm test
npm run cli -- dsh_discover
~~~

build 编译 TypeScript 与 C# UI 桥接程序。首次工具调用自动启动后台 Controller，同一个检出目录中的 CLI 和 MCP 共用它。

关闭 MCP 客户端不会取消已经交给 DSH 的任务。更新代码后执行以下命令关闭旧 Controller，下次调用会加载新版本：

~~~powershell
npm run cli -- shutdown
~~~

## 接入 Codex

将下面配置加入 Codex 的 MCP 设置，或写入受信任项目的 .codex/config.toml。**把示例路径替换为自己的检出目录**；不在 PATH 中的 node 需要填写绝对路径。

~~~toml
[mcp_servers.dshcontroller]
command = 'node'
args = ['--disable-warning=ExperimentalWarning', 'C:\path\to\DSHcontroller\dist\entrypoints\mcp.js']
cwd = 'C:\path\to\DSHcontroller'
startup_timeout_sec = 20
tool_timeout_sec = 60
enabled = true
~~~

配置样例：[examples/codex-mcp.toml](examples/codex-mcp.toml)。配置后重新加载 MCP，检查 dshcontroller 是否出现。详情参阅 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。已有聊天不一定会即时获得新工具，需要按客户端提示重载。

接入后可以这样向 Codex 描述任务：

> 使用 dshcontroller 接入正在运行的 DSH。在指定项目目录创建专用会话，从模型目录选择一个可用模型，发送分析任务，等待本次请求完成，再打开该会话并截图确认。

典型调用顺序：

1. dsh_discover → dsh_attach，使用发现结果中的 instanceId。
2. dsh_session_create 或 dsh_sessions_list，明确目标 sessionId。
3. 可选 dsh_model_select，然后 dsh_session_send；保存 runId 和 idempotencyKey。
4. dsh_run_wait / dsh_run_get，检查本次任务的最终状态。
5. dsh_ui_snapshot → dsh_ui_action → 新快照，确认界面动作结果。

实例重启后需要重新发现，不能继续复用旧 instanceId。

## MCP 工具

表中的 / 表示同一前缀下的多个独立工具。完整参数定义见 [src/tools.ts](src/tools.ts)。

| 范围 | 工具 |
| --- | --- |
| 实例 | dsh_discover、dsh_attach、dsh_status |
| 会话 | dsh_sessions_list、dsh_session_create/read/fork/rename/send/stop |
| 任务结果 | dsh_run_get、dsh_run_wait |
| 持续型子代理 | dsh_subagents_list、dsh_subagent_send/stop |
| 模型 | dsh_models_list、dsh_model_select |
| 设置 | dsh_settings_get/update、dsh_change_rollback |
| 插件 | dsh_plugins_list、dsh_plugin_change、dsh_plugin_install_wait |
| 原生界面 | dsh_ui_restore/open/snapshot/action |
| 重启条件检查 | dsh_instance_restart |

### 任务状态

send 和 stop 的 accepted 只表示受理。Controller 用请求 ID、持久事件序号和轮次关联结果，避免把历史回复误当成新任务完成。主要状态为 accepted、running、completed、failed、interrupted、blocked、max_tokens 和 unknown。

发送回执丢失时保持 unknown，继续通过持久事件确认；重试同一任务应复用同一个 idempotencyKey。Controller 不会自动重新提交结果未知的请求。单次 run_wait 最长等待 25 秒。

### 设置与插件

设置更新使用 DSH revision，保存 DPAPI 加密前值；回滚恢复用户覆盖层，并拒绝覆盖并发变更。schema 声明的凭据字段通过 DSH 界面配置，不通过 MCP 写入。

插件管理区分配置变化和运行生效。applied、restart-required、failed 等状态应分别处理；失败也可能已经写入配置。已知 profile reload requires the root Include entry 故障见 [热重载排障](docs/PROFILE-RELOAD.md)。

### 原生界面

优先使用快照中的 nodeId 执行语义动作。快照绑定窗口，90 秒过期且只能使用一次；窗口移动、控件身份变化或截图变化时，相应动作会被拒绝。动作返回 performed:true / verified:false，需要新快照确认结果。

## Agent Teams

本项目可以接入已启用官方 @deepseek-ai/dsh-experimental-agent-team-profile 的 DSH，发送团队任务、观察会话事件并打开团队看板。官方插件提供队友通信和共享依赖任务板；这些是 **DSH 的团队工具**，不是额外新增的 Controller MCP 工具。

本地验收记录包括两个队友互发消息、依赖任务完成、主代理汇总和团队看板。启用步骤、脚本准备方法及限制见 [Agent Teams](docs/AGENT-TEAMS.md)。本版本 teammate 继承主会话模型，没有独立模型选择参数。

## 验证与开发

~~~powershell
# 离线检查，不需要 DSH 或模型账户
npm run typecheck
npm test
npm run build

# 真正的 MCP stdio 读取验收，不操作窗口
npm run verify:live -- --skip-ui

# 加上恢复窗口、控件读取和截图
npm run verify:live
~~~

模型与停止验收需要专用测试会话，可能产生模型用量。先用 dsh_models_list 查询自己的可用路由，再选择参数：

~~~powershell
npm run verify:task -- --provider=<provider> --model=<model> --reasoning=<effort>
npm run verify:stop -- <test-session-id>
npm run verify:ui -- <test-session-id>
~~~

verify:task 可加 --session=<test-session-id> 复用专用会话。不要将停止验收指向工作中的普通会话。CI 只执行离线测试与编译，不调用模型或读取用户 DSH。

~~~text
src/entrypoints/       MCP、后台服务、CLI、验收入口
src/controller.ts     业务调度、设置与界面流程
src/runs.ts           任务关联、持久观察与恢复
native/DshUiBridge/   C# UI Automation、Win32 与 DPAPI
scripts/              实例发现及可选诊断/团队验收
tests/                离线协议与状态测试
docs/                 架构、接口、验收与故障说明
~~~

## 本地数据与认证

认证从绑定 DSHL 的有限启动日志中查找匹配本机地址的登录链接，交换 Cookie 后用当前 Windows 用户的 DPAPI 加密保存。自动认证不可用时，可在本机环境变量 DSH_LOGIN_URL 中提供登录链接，再执行 npm run cli -- login <instance-id>；不要将登录链接或凭据写入公开 issue。

.state/ 保存本地 SQLite、任务输出、截图和验收报告。其中认证、IPC 密钥和设置前值使用 DPAPI；任务输出与截图并非全部加密。该目录、构建产物、依赖、日志、环境文件以及本机 .codex 配置均被 Git 忽略。提交故障报告前应检查内容是否包含工作资料。

## 当前限制

- 适配版本和发现布局有限；DSH 上游 API 是版本相关接口，不保证跨版本兼容。
- 尚未实现自动重启、CDP/DOM 控制或从 Controller 直接创建子代理。
- dsh_instance_restart 目前只检查并报告阻碍，不执行重启。
- 设置写入/回滚、插件安装/移除、子代理续发/停止、分叉及所有 UI 动作组合尚未全部通过真实运行验收。
- 单个命名管道服务以用户和检出目录区分；命名管道使用应用层密钥校验，未实现自定义 Windows ACL。
- 多个 DSH 实例共用同一 Launcher 时，窗口绑定存在限制；UI 操作前需核对快照标题和内容。

欢迎通过 Issues 提交可复现问题。请注明 Windows、Node、DSH 版本、启动方式、工具名称及脱敏错误信息。

## 文档与许可证

- [架构设计](docs/ARCHITECTURE.md)
- [DSH 0.1.7-rc.2 接口核查](docs/DSH-0.1.7-rc.2.md)
- [实现与验收记录](docs/IMPLEMENTATION.md)
- [插件热重载故障](docs/PROFILE-RELOAD.md)
- [官方 Agent Teams](docs/AGENT-TEAMS.md)

Copyright (C) 2026 jgbrzzh and DSHcontroller contributors.

本项目采用 [GNU GPL v3](LICENSE)（GPL-3.0-only）。允许使用、修改与商用；分发本项目或其衍生版本时，应遵守 GPL v3 的源码提供和许可保留要求。DSH、DSHL 和其他依赖遵循各自许可证。
