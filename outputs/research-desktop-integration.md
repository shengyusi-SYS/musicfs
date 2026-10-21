# 桌面系统集成：选型结论

2026-10-22。针对 MusicFS 既有 Bun 后台与浏览器管理页，已采用随包分发的薄 Rust 辅助程序。无需安装完整桌面框架或要求用户安装 Rust；原生源代码与构建方式见[helper](../native/desktop/README.md)。

## 采用的组合

| 能力 | 实际依赖与边界 | 原因 |
|---|---|---|
| 托盘 | tray-icon 0.26.1；Windows/macOS 使用 tao 0.37.1 事件循环，Linux 使用 KSNI | 三端成熟接口；Linux 无 GTK；保留现有后台和浏览器。 |
| Linux 登录自启 | auto-launch 0.6.0，XDG 用户入口；应用补齐 Exec 参数编码 | 复用文件位置和注册机制，处理普通的空格、中文与特殊字符路径。 |
| Windows 登录自启 | windows-registry，当前用户 HKCU Run 中的 MusicFS 值 | 精确控制用户范围及 Windows 命令行参数编码。 |
| macOS 登录自启 | plist 序列化、dirs 用户目录、LaunchAgent ProgramArguments 数组 | 复用标准格式，避免自行拼接 XML。 |
| 打开浏览器、二维码 | 原有 open、Ant Design QRCode | 已满足用途，不增加重复依赖。 |

最初优先比较 tray-icon + auto-launch 全平台组合。固定版本源码检查发现 auto-launch 的 Windows/Linux 命令使用未经编码的拼接，Windows disable 也检查 HKLM，macOS XML 未转义路径。因此仅在 Linux 复用其注册位置和写入流程，并补参数编码；其他平台改用各自成熟的类型化依赖。依赖公开的参数数组不等于最终系统命令已正确序列化。

托盘只输出 ready 与 open/phone/quit 动作；Bun 后台持有状态并执行退出检查。父进程关闭标准输入后 helper 移除图标退出。自启注册命令通过另一子命令输入，不在托盘进程复制音乐、挂载、认证或 HTTP 逻辑。升级后启动器刷新注册的当前路径。

## 比较过的替代

| 路线 | 取舍 |
|---|---|
| Fyne systray | 可行的三端托盘备选，自启仍需组合；没有足够收益再引入 Go 工具链。 |
| Node 原生封装 | 仍需目标原生文件、事件循环及 Bun 编译接线；额外封装没有消除实际分发工作。 |
| 完整 Electron/Tauri | 窗口与桌面框架能力超过本轮三个菜单所需，迁移收益不足。 |
| 新的纯 Go 跨平台实现 | 交叉构建便利，但不为减少构建步骤就替换成熟的平台实现。 |

## 运行与构建事实

Linux musl 静态 helper 与 Windows x64 GUI 子系统 helper 已在 WSL 构建。Linux 在 D-Bus fixture 验证就绪及父输入关闭后的退出；参数编码有定向检查。Windows 正式包已补齐[必要 VM 证据](../docs/verification/desktop-access.md#windows-vm-续验)，菜单实际点击由用户协助确认；macOS ARM64 只有 cargo check，发行仍需 Apple SDK。Linux 需要桌面会话及 SNI/AppIndicator 宿主，重复启动器始终保留为进入管理页的方式。

构建只收集已下载依赖缓存、当前工具链和 MinGW 中的许可文件，附依赖与运行时索引，不为收集说明再次下载完整源码仓库。具体边界记录在索引中。

## 第一方参考

- [tray-icon 0.26.1](https://docs.rs/tray-icon/0.26.1/tray_icon/)、[tao](https://github.com/tauri-apps/tao)、[auto-launch 0.6.0](https://docs.rs/auto-launch/0.6.0/auto_launch/)。实际依赖由 Cargo.lock 固定。
- [Windows Run](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)、[XDG Autostart](https://specifications.freedesktop.org/autostart/latest/)、[GNOME AppIndicator 扩展](https://extensions.gnome.org/extension/615/appindicator-support/)。
- [Fyne systray](https://github.com/fyne-io/systray/tree/v1.12.2)、[Bun Node-API](https://bun.sh/docs/runtime/node-api)、[Electron Tray](https://www.electronjs.org/docs/latest/api/tray)、[Tauri 自启插件](https://v2.tauri.app/plugin/autostart/)。
