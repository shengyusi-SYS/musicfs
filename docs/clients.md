# 连接 OpenList 与播放器

MusicFS 以只读 WebDAV 提供文件。启动桌面服务或部署 Worker 后，在共用页面的“服务连接”复制实际 DAV 地址、读取用户名和读取密码；管理令牌只用于管理页面。

## 先准备目录

1. 安装来源插件、创建实例并完成授权；确认使用的是有音乐内容的账号。QQ 与微信登录可能对应不同账号。
2. 在“数据源 → 内容源”对需要的入口点击“刷新目录”，等待显示完成。在“目录布局”添加并发布内容源；新歌单等子目录可以在已发布目录预览中打开并准备。
3. 大目录首次准备时保持管理页面打开；准备失败可在页面查看原因并重试，原有成功目录保留。

首次直接从客户端进入未准备目录，可能得到503。OpenList可能只显示 `PROPFIND … 503`；这时回到 MusicFS 管理页面准备相应目录，完成后重试。读取客户端不会替你执行管理任务。

## OpenList

在 OpenList 的“管理 → 存储 → 添加”中选择 **WebDAV** 驱动：

| 字段 | 设置 |
|---|---|
| 挂载路径 | OpenList 内自选的路径，例如 `/音乐` |
| 地址 | MusicFS“服务连接”显示的完整 DAV 地址 |
| 用户名、密码 | MusicFS 的读取凭据 |
| 根文件夹路径 | `/`，或需要导出的子目录 |
| 供应商 | 其他 |
| 网页代理 | 保持开启 |
| WebDAV 策略 | 保持本机代理 |

MusicFS 直接返回带认证的音频字节，OpenList 应代理读取。关闭网页代理会让 OpenList 尝试寻找无需认证的重定向地址，无法用于这条路径。[OpenList 官方 WebDAV 说明](https://doc.oplist.org/guide/drivers/webdav)

保存后进入挂载目录，点击音频即可用 OpenList 内置播放器播放、暂停和拖动进度条。已验证的版本及范围见[客户端实测](verification/p2-clients.md)。

OpenList 自己也缓存目录。本次版本默认存储缓存为30分钟；MusicFS 刷新或修改布局后，如果 OpenList 仍显示旧内容，使用 OpenList 页面右下工具栏的**刷新**。普通浏览器重载可能继续读 OpenList 缓存。通常先刷新 MusicFS 来源内容，再刷新客户端目录；不需要重新扫码。

OpenList 必须能访问填写的地址。另一台机器或容器中的 `127.0.0.1` 指向它自己，应填写该环境可访问的 MusicFS 服务地址。

## Windows 盘符与资源管理器

Windows 桌面程序的“本机挂载”使用随包 rclone 和系统 WinFsp，支持 HTTP/HTTPS DAV；挂载发生在运行该后台的电脑。通过 Windows 浏览器打开 WSL 管理页，不会把 WSL 的挂载变成 Windows 盘符。

资源管理器“映射网络驱动器”使用另一套 Windows WebDAV 客户端。它需要现有 WebClient 服务运行；Windows 默认 `BasicAuthLevel=1` 仅允许 HTTPS 的 Basic 认证，因此不能把本机 HTTP DAV 直接映射视为默认可用。本机 HTTP 优先使用上述桌面挂载；原生映射使用可达且证书受信任的 HTTPS DAV、读取凭据和已准备目录。测试 VM 已在保持默认认证策略时成功映射现有 HTTPS Worker 的 sample 子目录、列出文件并正常断开；本机 rclone/WinFsp 的实际读取与卸载也通过，见[Windows记录](verification/p2-windows-mount.md)。原生映射后的播放仍未验。[Microsoft 原生客户端说明](https://learn.microsoft.com/en-us/iis/publish/using-webdav/using-the-webdav-redirector)

## 其他播放器

支持 WebDAV 的播放器可使用同一读取连接。也可以打开某个已准备音频文件的 DAV URL，并使用播放器提供的 HTTP 认证或自定义请求头功能。通过 OpenList 打开时，使用它生成的代理下载链接，由 OpenList 保存读取凭据。

某些播放器会缓冲整首短音频，拖动时不一定再向服务器发请求；这不等于服务器不支持 Range。客户端选择与已验证格式以[实测记录](verification/p2-clients.md)为准。音频按客户端请求流式读取。
