Windows x64 便携 MCP 服务：下载 **DSHcontroller-win-x64.zip** 并完整解压，再双击 `setup.cmd` 生成本机 MCP 配置。

- 内含 Node.js 24、生产依赖和自带 .NET 8 运行时的 UI 桥接，无需 npm install 或重新构建。
- 双击 `check.cmd` 检查原生桥接、MCP 初始化、28 个工具与实例发现。
- 仍需本机已启动 DSH 0.1.7-rc.2 / DSHL。不会替你安装 DSH 或配置模型账户。
- 移动解压目录后重新运行 setup 并更新 MCP 配置；更新前用 `dshcontroller.cmd shutdown` 关闭旧 Controller。
- `DSHcontroller-source.zip` 提供对应源码，便携 ZIP 中也附有一份。`SHA256SUMS.txt` 提供 ZIP 校验值。

详细使用、已验证功能与限制见 [README](https://github.com/jgbrzzh/DSHcontroller#readme)。项目采用 GPL-3.0-only；随附第三方运行时和依赖保留各自许可。
