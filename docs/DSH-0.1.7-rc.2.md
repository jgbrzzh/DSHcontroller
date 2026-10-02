# DSH 0.1.7-rc.2 本机接口核查

核查日期：2026-10-02。本文记录架构阶段的只读核查，当时未发送模型任务、安装插件、改配置或重启实例。后续实现已执行认证、专用会话任务与原生界面验收，见 [实现与验收记录](IMPLEMENTATION.md)。

## 1. 环境与运行事实

| 项目 | 本次结果 | 证据等级 |
| --- | --- | --- |
| 项目目录 | `<checkout>` 初始为空，不是 Git 仓库 | 文件与 Git 检查 |
| 用户指定版本 | `C:\Users\<user>\.dsh-win\versions\0.1.7-rc.2` | 用户说明与安装清单 |
| 版本依赖 | 安装目录 package.json 指向 `dsh-0.1.7-rc.2.tgz` | 本机文件 |
| PATH 中的 dsh | `C:\Users\<user>\AppData\Roaming\npm\dsh.ps1`，版本 `0.1.1-rc.2` | 实际 CLI 输出 |
| 运行服务 | 指定版本 `lib/bin.js --profile 0.1.7-rc.2 --port 10725 --no-open` | Win32_Process 与 TCP 监听 |
| 原生窗口 | `<DSHL>\PCL-Deepseek-Harness-Launcher.exe`；标题 `0.1.7-rc.2 #1（原生） · DSHL` | 进程与窗口标题 |
| 窗口容器 | WebView2 DLL 与 DSHL 关联的 `msedgewebview2.exe` 进程存在 | 文件与进程 |
| 根路径访问 | `GET http://127.0.0.1:10725/` 返回 401 | 实际 HTTP 只读请求 |
| CDP 参数 | 所检查的 DSHL WebView2 进程命令行没有发现 `--remote-debugging-port` | 命令行检查；未证明所有调试连接均不可用 |
| 启动认证 URL | `<DSHL>\DSHL\Log1.txt` 最近 250 行检测到带 token 的 URL | 仅记录存在性，未输出令牌或执行认证 |
| Node.js | 本机版本 `v24.19.0` | 实际 CLI 输出 |

PID、端口和窗口标题仅代表当前快照，实现不能固定使用它们。

## 2. 静态代码来源

检查直接位于 pnpm 虚拟存储的实际包目录，跳过 ReparsePoint 包链接。存储根目录：

```text
C:\Users\<user>\.dsh-win\versions\0.1.7-rc.2\node_modules\.pnpm
```

以下为相对于该目录的包路径。各包下读取 `node_modules\@deepseek-ai\<包名>` 中的文件。

| 包名 | 存储目录 | 主要检查文件 |
| --- | --- | --- |
| dsh-client-connection | `@deepseek-ai+dsh-client-con_c0432de70aac058fd9f8a3d507a754cd` | `lib/index.js`、`lib/types/rpc.d.ts`、`lib/types/browser-auth.d.ts` |
| dsh-api-gateway | `@deepseek-ai+dsh-api-gatewa_8ab07567a38bb1cd283dba66a82bb3bf` | `lib/index.js` |
| dsh-api-session-controller | `@deepseek-ai+dsh-api-sessio_e5c0f6da6326b7693844174d7a3260a9` | `lib/typert.remote-client.d.ts`、`lib/types` 中请求与流式契约 |
| dsh-api-settings-controller | `@deepseek-ai+dsh-api-settin_6a7ab329d69dce1d8019a637fd1dcc48` | `lib/typert.remote-client.d.ts` |
| dsh-settings | `@deepseek-ai+dsh-settings@0_472d17484922885f7b1bef5b8d769719` | `lib/types/index.d.ts` |
| dsh-subagent | `@deepseek-ai+dsh-subagent@0_c19a7a086c6d879bbe06a2d92e942db8` | `lib/typert.remote-client.d.ts`、`lib/types/control-types.d.ts` |
| dsh-host-plugin-inventory | `@deepseek-ai+dsh-host-plugi_bb935c9610b785f7791911583f222982` | `lib/typert.remote-client.d.ts`、`lib/types/types.d.ts` |
| dsh-plugin-manager | `@deepseek-ai+dsh-plugin-man_f5890305ef7375f67ab3e9906df20804` | `lib/typert.remote-client.d.ts`、`lib/types/types.d.ts` |
| dsh-sdk-protocol | `@deepseek-ai+dsh-sdk-protoc_da79e8669b03e1e442660b11b067fe5f` | `lib/types/types.d.ts` |

Profile 清单 `C:\Users\<user>\.dsh\profiles\0.1.7-rc.2\package.json` 同时包含 DSH 基础、Web 应用及其他依赖。当前 Profile 的挂载状态还需要通过认证后的运行检查确认。

## 3. Web RPC 信封

`dsh-client-connection` 定义单次调用的请求与响应：

```json
{
  "type": "client-request",
  "rpcId": "controller-generated-id",
  "method": "session/list",
  "payload": { "args": { "_request": {} } }
}
```

这是根据 Connection 信封、Gateway 参数规则和 Remote 声明整理的拟用请求。尚未在认证后的现有实例中执行。

响应类型为 `server-response`，具有同一个 `rpcId` 和 `result`；`result` 为 `{ "ok": true, "value": ... }` 或 `{ "ok": false, "error": { "code": ..., "message": ..., "details": ... } }`。

Gateway 的 `remoteRequest` 检查 payload 只包含普通对象 `args`，并按声明严格检查参数名。方法签名中的 `_request`、`request`、`ns` 等不能随意换名。HTTP 路径与信封 method 也需一致。

流式路径为 `/api/remote.mux`。其 open 消息包含 `type`、`streamId`、`endpoint`、`payload`；该通道是 DSH 自有协议，不是 MCP。

## 4. 业务接口映射

| 需求 | 已找到的 Remote 接口 | 注意事项 |
| --- | --- | --- |
| 会话列表与搜索 | `session/list`、`session/search` | 准确参数名来自 Remote 声明 |
| 创建、分叉、改名 | `session/create`、`session/fork`、`session/rename` | 身份和历史保留由 DSH 管理 |
| 发消息与队列 | `session/prompt`、`session/updateQueue` | prompt 需要 requestId、sessionId、mode、content |
| 取消当前执行 | `session/cancel` | 返回 accepted，不代表停止已完成 |
| 历史和状态 | `session/page`、`session/projections`、`session/follow`、`session/control` | follow 是流；page 有 throughSeq/beforeSeq |
| 模型 | `session/modelCatalog`、`session/selectModel` | 区分会话模型和持久默认设置 |
| 配置 | `settings/describe`、`settings/update`、`settings/mutate`、`settings/replace` | 更新接口包含 expectedRevision |
| 凭据 | `credentials/describe`、`credentials/set`、`credentials/unset` | 架构默认不向 Codex 返回密钥原文 |
| 插件清单 | `pluginInventory/list`、`pluginManager/listBundles`、`pluginManager/listPlugins` | 安装、配置和实际运行状态不同 |
| 插件修改 | `pluginManager/installBundle`、`removeBundle`、`setBundleEnabled`、`setPluginEnabled` | 需保留 application/stage/warnings |
| 插件安装任务 | `pluginManager/waitForInstall`、`pluginManager/cancelInstall` | 不能简单按 RPC 返回时间判断完成 |
| 持续型子代理 | `subagents/prompt`、`subagents/interruptByParent` | 父子身份与模式必须正确 |

`SessionPromptRequest` 的 `mode` 为 `queue` 或 `steer`，`requestId` 会关联到被接收的用户消息。`SessionPromptValue` 和 `SessionCancelValue` 均只提供 `accepted: true`。

`SessionFollowRequest` 包含 address、maxMessages、turnWindow 和可选 assistantStream。已检查声明中没有通用的 `since` 字段；恢复设计必须遵循实际 opening snapshot、事件 seq 及 page 契约。

插件 `ChangeResult.application` 为 `applied`、`restart-required`、`overridden`、`failed` 或 `cancelled`，并独立提供 `changed`。持久修改和运行生效需要分别报告。

SDK stdio 的 `HarnessSdkRequestMap` 只声明 `initialize`、`session/prompt`、`shutdown`。SDK notification 包括 session.event、session.status 和子代理启动/完成，因此适合独立运行链路，但不是完整的现有 Web 实例管理接口。

## 5. 本次尚未完成的验证

- 未执行带认证的业务 RPC 或 WebSocket 握手。
- 未证明安装目录里的接口全部被当前 Profile 启用。
- 未读取原生窗口的 UI Automation 控件树或操作控件。
- 未建立 CDP 连接，也未验证 DSHL 如何启用调试端口。
- 未证明 DSH prompt 的 requestId 有服务端完整去重语义。
- 未核查 DSHL 重启入口、窗口关闭与后端生命周期关系。

这些验证进入架构 P0/P1；不得把本次静态核查称为功能实现或 GUI 验收。
