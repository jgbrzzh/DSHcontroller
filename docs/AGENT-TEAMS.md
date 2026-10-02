# 官方 Agent Teams 核查与运行验收

验收日期：2026-10-02。接入官方团队组合包，使用上游团队运行时。

## 当前结果

`@deepseek-ai/dsh-experimental-agent-team-profile@0.1.7-rc.2` 已在本机 DSH 的 `0.1.7-rc.2` profile 启用。它是随 DSH 提供的可选组合包，运行实例已存在该包；本次没有重复安装其他版本。重启后，团队服务、团队工具和 UI 三行均为 `enabled:true / fiberPhase:active`。

真实模型验收完成了 lead + alpha + beta 团队、成员双向通信、依赖任务领取和完成、主代理汇总。原生 DSHL 的 Web 内容中已打开团队看板，并视觉确认成员 3、共享任务 2、两个任务均「已完成」。

测试会话标题：`官方智能体团队验收 2026-10-02`。专用测试路由为 `openrouter / stealth/space-bunny-alpha / max`，两个 teammate 继承它；没有修改其他会话的默认模型。

## 实现与工具

profile 自身入口是空模块，实际通过 `cordis.patch.yml` 组合三个插件：

| 插件 | 职责 |
| --- | --- |
| `dsh-experimental-agent-team` | 实时成员身份、Lead 日志事务、持久 mailbox、共享任务板 |
| `dsh-experimental-tool-agent-team` | 在成员作用域注册模型工具与团队策略 |
| `dsh-experimental-client-ui-agent-team` | Web 成员列表、任务板与成员会话导航 |

精确版本的发布代码注册 9 个工具：`spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、`team_task_create`、`team_task_list`、`team_task_get`、`team_task_update`。

成员可向队友或 lead 发消息。消息先落入 Lead 的持久队列，再通过 host 专用子代理投递路径发送；不会通过普通父子 `sendMessage` 伪装发送者。运行中的接收方在步骤边界收到消息，空闲接收方被唤醒。`accepted` 是 inbox 准入，不是模型已消费；`queued` 是已经持久保存，不应重新发送同一消息。

共享任务通过 `expected_revision` 做 compare-and-set，并由每个 Lead 的事务队列串行化。任务依赖全部完成后才允许领取；`write_scopes` 只是重叠提示，不是文件锁。

## 分层证据

### 发布包与离线检查

精确下载三个 `0.1.7-rc.2` npm tarball，分别核对 npm 发布的 SHA-1；隔离导入下载代码，使用内存 host adapter 执行原有 TeamJournal、TeamTaskBoard、Team projection 和工具插件。

历史本机运行 `node scripts/probe-agent-team.mjs`：12 项通过，包括包身份、依赖阻止领取、两个同时领取请求只有一个成功、过期 revision 拒绝、依赖环拒绝、完成后解锁、日志回放、成功事务 flush、9 工具注册、spawn schema 和卸载清理。

该层未启动用户 profile、模型或真实 mailbox。证据：`.state/team-package-audit/report.json`。

### 真实 DSH 与模型

- 父会话：`<test-session-id>`。
- 本次请求 run：`<local-record-id>`，终态 `completed`。
- alpha：`<local-record-id>`；beta：`<local-record-id>`。
- `task-1`：alpha 完成、revision 3，Lead 日志 seq 58。
- `task-2`：依赖 task-1，beta 领取发生在 task-1 完成之后，最终 completed、revision 3。
- alpha → beta：queued seq 61，delivered seq 65。
- beta → alpha：queued seq 81，delivered seq 82。
- 两个 child 的 `user/message` 均恰好消费一次对应 `team-message` 身份，最后 turn/end 均为 completed。
- lead 收到 `ALPHA_ACK_BETA` 与 `BETA_TASK_DONE`；最终回复位于 seq 112，包含 `DSH_AGENT_TEAM_OK`，本次 turn/end 位于 seq 114。

`node scripts/verify-agent-team.mjs observe`：7 项真实验收检查通过，检查实际 Team 事件、成员日志和任务投影，不单靠模型宣称成功。5 条不同 mailbox 消息各有一次 delivered；主会话无失败 tool/result。

完整报告：`.state/team-package-audit/live-report.json`。报告保留主会话和成员快照，可能包含模型上下文，仅本地存储于已忽略的 `.state/`。

### GUI

已在原生 DSHL 打开测试会话，点击顶部「智能体团队」，取得新快照并视觉核对看板。截图：`.state/screenshots/<snapshot-id>.png`。成员均显示「未运行」，两个共享任务均显示「已完成」；成员未运行与任务完成是不同状态。

## 使用

直接在 DSH 说：

> 使用智能体团队，创建 researcher 和 reviewer 两个队友。researcher 分析方案，reviewer 审查方案；队友通过 send_message 互相讨论，用共享任务板管理依赖，最后由主代理汇总。

在主会话顶部点击「智能体团队」可查看 roster 与任务板，点成员可进入成员会话。只在用户明确要求团队时创建 teammate。

本机正在使用的包已匹配 `0.1.7-rc.2`。npm 的 `latest` 标签在核查时仍指向 `0.1.5-alpha.2`，新安装需要显式版本，不要直接用无版本包名推断匹配关系。

首次进行可选离线团队核查，先运行 `node scripts/prepare-team-audit.mjs` 下载固定版本、校验发布包并解压到 `.state/`，再执行 `node scripts/probe-agent-team.mjs`。它还需要本机 DSH 安装；默认解析当前用户的 `.dsh-win/versions/0.1.7-rc.2`，可设置 `DSH_VERSION_DIR` 或 `DSH_PNPM_STORE`。上游包只保存在本地，不随本仓库分发。

真实 `send` 验收前设置 `DSH_TEST_PROVIDER`、`DSH_TEST_MODEL`，可设置 `DSH_TEST_REASONING`；也可以提供已选择模型的专用会话 ID。这会实际调用模型并创建队友。

复查当前启用状态：`node scripts/verify-agent-team.mjs inspect`。`observe` 检查已记录主会话及队友日志；`gui` 会恢复窗口、打开该测试会话与团队面板，核对控件并保存截图；`send` 会创建/使用专用会话并实际请求模型，保存幂等键防止重复发送，本次已发出时拒绝另发同一测试。窗口被再次最小化或界面被用户切换时，GUI 复查可能失败，需要在稳定的窗口状态下重跑。

## 当前限制与启用故障

- 本版本 `spawn_teammate` 只有 name、description、prompt、context 参数；没有 provider/model/reasoning_effort 的队友独立路由选择。服务创建 child 时也未传 `agentOptions`。
- 组合包禁用普通 `tool-subagent`、`tool-subagent-fork` 和全局 child-control 行；作用域预设中的注册仍需独立核查。
- 单进程、共享工作目录；没有 worktree 隔离或强制文件锁。任务归属不会因为成员空闲、失败或中断自动释放。
- 崩溃后的 mailbox 恢复有发布代码与静态依据，本次未进行杀进程/重启后消息恢复验收。
- 首次检查发现 bundle 配置 enabled，但 Team 运行行缺失。再次启用回执为 `changed:false / application:failed`，诊断为 `profile reload requires the root Include entry`。用户通过 DSHL 完整重启后，三个 Team 行正常 active；未修改外部安装代码或重复添加 Include。详见 [热重载核查](PROFILE-RELOAD.md)。

## 参考项目

- [官方 profile 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/agent-team-profile/README.zh.md)：组合包与 UI。master 会变化，本报告行为以实际下载的 0.1.7-rc.2 代码和执行结果为准。
- [官方 Team 服务说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/agent-team/README.zh.md)：持久日志、mailbox 与任务语义。
- [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)：第三方 captain 团队、调度器和质量门控；本次未安装。
- [MisRightW/dsh-agent-teams](https://github.com/MisRightW/dsh-agent-teams)：按角色 DAG 调度并汇总，侧重一次任务编排；本次未安装。
- [PerryLink/dsh-team-rooms](https://github.com/PerryLink/dsh-team-rooms)：独立会话之间的持久协作房间；本次未安装。
