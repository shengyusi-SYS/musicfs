# MusicFS

通过可安装的数据源插件，把音乐服务或音频来源呈现为只读音乐目录，以 WebDAV 接入播放器和 OpenList，并由桌面内置 rclone 挂载。Windows、Linux、macOS 桌面与 Cloudflare Worker 共用核心和 WebUI，独立部署。

目前为开发 alpha，已有插件/实例、目录快照/布局、管理 HTTP、共用只读 DAV 和 WebUI；QQ 与网易云真实扫码、目录及 DAV/rclone 音频读取已有证据。正式桌面启动/挂载管理与 Worker 后台插件发布已接线，本地验证通过；真实云部署、四个目标系统挂载及完整发行仍待验。来源认证、分类和音质规则归插件，核心管理插件、实例、布局和文件访问。

| 阅读目的 | 入口 |
|---|---|
| 接续 Codex 主线与判断全部完成 | [执行目标](docs/codex-goal.md) |
| 查看实现、验收证据与剩余缺口 | [验收台账](docs/verification.md) |
| 理解产品范围与验收 | [统一需求](outputs/musicfs-requirements-and-technical-design.md) |
| 理解领域、模块和依赖方向 | [架构设计](docs/architecture/README.md) |
| 理解插件公开 Interface | [插件合同草案](docs/architecture/plugin-interface.md) |
| 查看架构与流程图 | [图表](docs/architecture/diagrams.md) |
| 了解当前和后续工作 | [实施计划](outputs/musicfs-implementation-plan.md) |
| 查找决策、调研与历史资料 | [文档索引](docs/README.md) |
| 运行开发检查与 P0 探针 | [开发说明](docs/development.md) |

开发入口和当前证据见[开发说明](docs/development.md)、[P0 目录/DAV 记录](docs/verification/p0-library-dav.md)、[WebUI 首轮记录](docs/verification/p1-webui.md)与[通用认证记录](docs/verification/p1-authentication.md)。尚未覆盖的真实平台、完整管理流程、云部署、目标系统和客户端能力保留在验收台账中。

QQ 开发预览已接入手机 QQ/微信扫码、会话恢复、原始歌单分类、实例单/多音质与缺失策略；真实 MP3/M4A、正式 DAV/rclone 范围读取和双会话本地 workerd 已有[限定证据](docs/verification/p2-qq-quality.md)。完整双宿主示例仍欠续期、其余真实档位和云端验收，详见[插件说明](plugins/qq/README.md)。

网易云已完成真实授权、每日推荐、4,158 曲喜欢列表的完整刷新和 MP3 读取，详见[真实来源记录](docs/verification/p2-netease-source.md)。桌面和 Worker 的构建、运行及未验边界分别见[桌面说明](docs/desktop.md)与[Worker 说明](docs/worker.md)。
