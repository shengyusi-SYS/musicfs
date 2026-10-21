# 挂载名称与启动检查

2026-10-22。范围是桌面启动是否等待自动挂载，以及资源管理器卷标与自定义名称；不请求音乐平台。

## 启动核对

使用现成 dev.14 Linux 正式程序、一个隔离挂载定义与 WSL 回环 WebDAV。刻意保持来源 PROPFIND 不返回，在原生挂载请求等待期间检查启动器退出、管理状态、ticket 与挂载列表。实测启动器约265ms返回，管理检查约20ms，挂载显示 starting；释放后正常退出并清理。

该样本证明现有自动挂载不等待完成才开放管理入口，未发现需要另加后台调度的问题；不是 Windows 整机启动或自然登录计时。后台恢复的重试与手动操作接管复用原有定向回归。

## 名称行为

原请求没有设置 rclone VolumeName，原生系统默认使用内部 remote 标识。现复用挂载名称，默认 MusicFS，并增加重命名入口。定向回归覆盖默认/自定义卷标、重命名保留 ID 与缓存命名空间、持久恢复、忙卸载保留原名、停止项改名不启动原生挂载。Windows 上游 32 字节裁切用中文样本核对完整 UTF-8 前缀；不增加无实际来源的边界矩阵。

名称是显示属性，盘符、来源、凭据和缓存身份保持原职责。rclone 1.75.2 的原生字段由本机 options/get 和[固定版本定义](https://github.com/rclone/rclone/blob/v1.75.2/cmd/mountlib/mount.go)共同核对；[卷标处理](https://github.com/rclone/rclone/blob/v1.75.2/cmd/mountlib/utils.go)及[Windows接线](https://github.com/rclone/rclone/blob/v1.75.2/cmd/cmount/mount.go)由依赖实现。

## 集成结果

Windows 新名称和管理页入口的必要核对待集中构建后补记；不重复 dev.14 托盘、登录和自动恢复验收。
