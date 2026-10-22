# Windows 托盘双击与浏览器入口

2026-10-22，dev.16。仅处理托盘单击误打开和打开管理页时短暂命令行窗口，不访问音乐平台或部署云端。

## 原因与修正

原生回调原先处理左键 Click/Up，故单击就打开，双击还可能经过多次抬起。现直接处理 tray-icon 0.26.1 的 Windows 左键 DoubleClick，其余点击不发 open；右键菜单不变，其他系统使用各自激活协议，不增加手写双击定时器。

open 11.0.4 的 Windows 路径通过 PowerShell Start-Process 打开 URL，未设置 windowsHide。修正为现有 GUI 辅助程序经 windows-sys 0.61.2 调用 [ShellExecuteW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecutew)。后台仍拥有 URL、ticket 和页面选择，系统调用仅负责打开默认浏览器；启动器、托盘菜单和手机入口统一复用。地址通过 stdin 交给辅助程序，没有 PowerShell/cmd 中间进程。

## 定向核对

实际原生事件策略回归在旧行为下因单击仍触发而失败，修正后通过；覆盖 Windows 双击前后的点击序列只打开一次，以及其他托盘后端的激活。Bun 桥接 fixture 核对 URL 的查询和片段完整传递到辅助程序，保留启动参数与关闭协议。

构建及现有 Windows VM 的本轮必要结果待收口后补记，不重复挂载、平台授权或全库读取验收。
