# Windows 托盘双击与浏览器入口

2026-10-22，dev.16。仅处理托盘单击误打开和打开管理页时短暂命令行窗口，不访问音乐平台或部署云端。

## 原因与修正

原生回调原先处理左键 Click/Up，故单击就打开，双击还可能经过多次抬起。现直接处理 tray-icon 0.26.1 的 Windows 左键 DoubleClick，其余点击不发 open；右键菜单不变，其他系统使用各自激活协议，不增加手写双击定时器。

open 11.0.4 的 Windows 路径通过 PowerShell Start-Process 打开 URL，未设置 windowsHide。修正为现有 GUI 辅助程序经 windows-sys 0.61.2 调用 [ShellExecuteW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecutew)。后台仍拥有 URL、ticket 和页面选择，系统调用仅负责打开默认浏览器；启动器、托盘菜单和手机入口统一复用。地址通过 stdin 交给辅助程序，没有 PowerShell/cmd 中间进程。

## 定向核对

实际原生事件策略回归在旧行为下因单击仍触发而失败，修正后通过；覆盖 Windows 双击前后的点击序列只打开一次，以及其他托盘后端的激活。Bun 桥接 fixture 核对 URL 的查询和片段完整传递到辅助程序，保留启动参数与关闭协议。

Rust 两项定向回归、Bun 两项桥接及一项启动器回归通过；三套类型与模块边界通过。Windows x64 原生与正式程序从干净提交 `68e6318` 构建，辅助程序 PE 子系统为 GUI。dev.16 Windows、离线 Worker、源码和作者包归档及校验和均完成，未部署云端。

## Windows VM 冒烟

复用现有 VM，在 san 的用户桌面会话中运行正式 Windows 构建里的辅助程序；SHA-256 与 dev.16 ZIP 内文件一致。用户重新连接桌面后，仅向实际托盘窗口发送一次单击序列和一次双击序列，再运行一次系统浏览器入口。结果：

| 项目 | 结果 |
|---|---|
| 原生单击回调 | 未产生 open 动作 |
| 原生双击及其抬起回调 | 仅产生一次 open 动作 |
| GUI 辅助程序打开默认浏览器 | 浏览器成功请求回环 HTTP 测试页；查询参数正确 |
| 命令行窗口观察 | WinEventHook 监听创建/显示事件，未出现 ConsoleWindowClass |
| 生命周期 | 关闭 stdin 后托盘正常退出，无遗留测试辅助进程；回环监听、临时任务、包与脚本已清理 |

这是原生回调消息和系统浏览器的集成冒烟，不把它描述为自动鼠标双击或肉眼观察。初次桌面会话断开时无法取得有效托盘交互证据；重连后完成上述检查，没有因此改动产品。

没有调用 Windows 宿主、注册系统自启、操作挂载、请求音乐平台或重跑全库。原始回执留在本机忽略目录 `.musicfs/windows-dev16/`。本轮结果不改写其他系统托盘的历史验收范围。
