# 插件操作报 root Include 错误

诊断日期：2026-10-02，DSH 0.1.7-rc.2。用户界面错误为 `dsh: profile reload requires the root Include entry`。

## 已确认的事实

- 当前 DSH PID 2584、启动时间与前次验收一致。
- 运行清单的 `entryId:include / cordis:include` 为 enabled:true、fiberPhase:active。
- Profile 的 cordis.yml 为发行版默认空数组，注释说明通过 Bundle 与 cordis.patch.yml 组合树；该格式本身正常。
- app-boot 的 `mountRootInclude` 把 root context → Include entry 存在模块级 `bootstrapIncludes = new WeakMap()` 中。
- `reconcileProfilePatches` 只读取这个 WeakMap；读不到就直接抛截图错误，未从实际 Loader 树中恢复。
- plugin-manager 的 `setPluginEnabled` / `setBundleEnabled` 在写入持久配置后调用 reload，reload 把 ownerContext.root 交给 reconcileProfilePatches。`change` 捕获异常、application:failed，且 changed 独立按磁盘变化计算。因此界面显示失败并不保证磁盘配置未改变。

## 隔离复现

```powershell
node scripts/probe-profile-reload.mjs
```

此脚本默认从当前用户的 DSHL 安装目录解析路径，可通过 DSH_VERSION_DIR、DSH_PNPM_STORE、DSH_HOME、DSH_PROFILE 环境变量覆盖，只读取实际 Profile 的 Bundle 元数据与解析规则。它在项目 .state/probe-profile 下启动一个空配置树，不启动模型、网络服务或用户 Profile 的插件，不改变运行中的 DSH。

结果：

1. 初始启动与插件管理器解析使用同一个 app-boot 模块，均可重载空树。
2. 在这个隔离进程中，按 dsh-hmr 使用的方式从模块缓存删除 app-boot，再导入同一文件。
3. 新导入的 reconcileProfilePatches 与旧函数不同，实际 Include 仍存在，但新模块的 WeakMap 为空，抛 `probe: profile reload requires the root Include entry`。

完整结果为 .state/profile-reload-probe.json。这证明当前发布代码的模块重载会破坏 Include 登记；未通过现有进程的模块缓存或日志证实它具体在哪一次重载中丢失。正常模块解析并未发现启动模块与插件管理器一开始就加载不同副本，所以不能把安装重复依赖当作已确认原因。

## 处理与验证边界

临时恢复方式是在用户任务结束后，通过 DSHL 完整停止并重新启动 DSH，再检查插件实际开关与配置状态。单纯刷新页面不会重新建立后端的 WeakMap。后续已在本机完整重启并确认 Agent Teams 三个运行行恢复 active，详见 [团队验收](AGENT-TEAMS.md)。这是该实例的恢复结果，不能证明所有热重载故障都由同一原因引起。Controller 不会自动重启 DSH。

代码修复应让根 Include 登记跨模块重载存活，例如保存在 root context 上，或在登记缺失时按严格身份条件从 ctx.loader.resolve('include') 恢复真实根项。必须同时覆盖 HMR 后重载、插件启停、失败后持久状态与运行状态分离的测试。当前未修改外部安装包。

不要为了消除这个报错在 cordis.yml 里重复插入 Include，现有根项已正常挂载。也不要将 pluginManager 的 application:failed 当作成功启用；先读取实际运行清单和持久配置。

代码依据为本机 dsh-app-boot/lib/index.js 中 bootstrapIncludes、mountRootInclude、reconcileProfilePatches；dsh-hmr/lib/index.js 的模块缓存清除；dsh-plugin-manager/lib/index.js 的 setPluginEnabled、setBundleEnabled、reload 和 change。
