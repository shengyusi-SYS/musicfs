# MusicFS

通过可安装的数据源插件，把音乐服务或音频来源呈现为只读音乐目录，以 WebDAV 接入播放器和 OpenList，并由桌面内置 rclone 挂载。Windows、Linux、macOS 桌面与 Cloudflare Worker 共用核心和 WebUI，独立部署。

当前交付为`0.1.0-dev.7`开发预览，包含 API 0.1.9、schema 9，以及网易云 MP3/FLAC/M4A 的按需补标签读取：刷新清单后即可挂载，读取时只准备所选歌曲。发行文件按版本放在`dist/releases/<版本号>/`；使用方式与已接受的格式、填充空间限制见[交付说明](docs/release.md)。来源认证、分类和音质归插件，核心管理插件、实例、布局和文件访问。

| 阅读目的 | 入口 |
|---|---|
| 选择当前归档、启动与部署 | [交付物与使用入口](docs/release.md) |
| 接续 Codex 主线与判断全部完成 | [执行目标](docs/codex-goal.md) |
| 查看实现、验收证据与剩余缺口 | [验收台账](docs/verification.md) |
| 理解产品范围与验收 | [统一需求](outputs/musicfs-requirements-and-technical-design.md) |
| 理解领域、模块和依赖方向 | [架构设计](docs/architecture/README.md) |
| 理解插件公开 Interface | [插件合同草案](docs/architecture/plugin-interface.md) |
| 查看架构与流程图 | [图表](docs/architecture/diagrams.md) |
| 了解当前和后续工作 | [实施计划](outputs/musicfs-implementation-plan.md) |
| 查找决策、调研与历史资料 | [文档索引](docs/README.md) |
| 连接 OpenList 与播放器 | [客户端说明](docs/clients.md) |
| 运行开发检查与 P0 探针 | [开发说明](docs/development.md) |

开发入口和当前证据见[开发说明](docs/development.md)、[P0 目录/DAV 记录](docs/verification/p0-library-dav.md)、[WebUI 首轮记录](docs/verification/p1-webui.md)与[通用认证记录](docs/verification/p1-authentication.md)。历史检查点与本次跳过的验证均保留在验收台账中。

QQ开发预览支持手机QQ/微信扫码、会话保存、分类、实例音质和缺失策略；[本地音质/字节](docs/verification/p2-qq-quality.md)与[真实云端](docs/verification/p4-worker-cloud.md)均有有限证据。[会话记录](docs/verification/p2-session-lifecycle.md)包含SQLite/D1续期回归及本地/真云真实退出重登；QQ正常窗口内的真实续期本次跳过，详见[插件说明](plugins/qq/README.md)。

网易云已完成真实授权、每日推荐、4,158 曲喜欢列表的完整刷新和 MP3 读取，详见[真实来源记录](docs/verification/p2-netease-source.md)。桌面和 Worker 的构建、运行及未验边界分别见[桌面说明](docs/desktop.md)与[Worker 说明](docs/worker.md)。

本项目自行编写的代码、公开插件接口、构建工具和示例插件采用 **GPL-3.0-only**，Copyright (c) 2026 MusicFS contributors，正文见[LICENSE](LICENSE)。第三方组件、引用或另行标注的文件保留原许可和署名；随包资料见[第三方说明](third-party/README.md)。发行时提供同版本项目源码归档与构建说明，公开API尚未发布到npm。
