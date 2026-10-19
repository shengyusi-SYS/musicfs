# MusicFS 文档索引

建议按需求 → 术语 → 架构与插件合同 → 实施计划阅读。`outputs/` 保留原有路径，避免破坏已分享的链接；当前架构集中在 `docs/architecture/`，有取舍的决定集中在 `docs/adr/`。不复制整份需求到其他文档。

## 当前设计与执行依据

| 文档 | 保存的内容 | 不用于证明 |
|---|---|---|
| [Codex 主线目标](codex-goal.md) | 持续执行范围、依据与全部完成判定 | 产品已经交付 |
| [实现与验收台账](verification.md) | FR01—FR25、目标环境与交付物的实现/验证状态及证据 | 尚未覆盖环境已通过 |
| [开发与验证入口](development.md) | 工程命令、实现入口和探针运行方法 | 完整用户版应用 |
| [P0 插件基础验证](verification/p0-plugin-foundation.md) | 实际依赖、双宿主本地结果、状态及归档边界 | 真实云部署、音乐账号与全部目标系统 |
| [P0 目录/DAV/管理验证](verification/p0-library-dav.md) | 快照、布局、HTTP 字节、workerd 与真实 rclone | 平台实播、系统挂载和全量交付 |
| [共用 WebUI 首轮验证](verification/p1-webui.md) | 浏览器安装、双实例、配置、目录发布/拖动及进程重启 | 真实来源认证、所有页面流程或 Worker/跨系统验收 |
| [通用认证首轮验证](verification/p1-authentication.md) | SQLite/D1 挑战、并发/过期/取消保护，浏览器二维码/输入/恢复 | 真实网易云/QQ 登录、续期、云部署与全平台验收 |
| [QQ 真实来源首轮验证](verification/p1-qq-source.md) | 手机 QQ 扫码、会话恢复、每日推荐、DAV/rclone 字节和本地 workerd | 完整双示例、续期、真实云部署或播放器验收 |
| [QQ 原始分类与分页](verification/p2-qq-catalog.md) | SDK 原始角色、有限推荐、完整歌单、微信扫码与非空喜欢/自建 | 非空收藏、全部音质或云端资源验收 |
| [QQ 音质与目录统计](verification/p2-qq-quality.md) | 实例策略、实际版本、批量、通用计数、真实 MP3/M4A 与双会话 workerd | 全部真实档位、网易云、云端或播放器验收 |
| [实例刷新](verification/p1-instance-refresh.md) | 实例/单目录范围、可达缓存遍历、失败保留、SQLite/D1 与浏览器结果 | 全树预读、后台进度或真实云端大集合验收 |
| [共用界面设计](architecture/web-ui.md) | 已确认视觉基线、页面责任、前后端合同与令牌边界 | 产品全部管理能力已完成 |
| [管理 HTTP 接口](management-api.md) | WebUI 可调用的实际路由与凭据合同 | 尚未实现的认证/部署/挂载入口 |
| [统一需求](../outputs/musicfs-requirements-and-technical-design.md) | 产品范围、用户结果、FR01—FR25 与发布验收 | 已实现或兼容通过 |
| [术语](../outputs/GLOSSARY.md) | 项目领域概念 | 接口、SQL 和实现算法 |
| [架构设计](architecture/README.md) | Module、Interface、依赖方向、状态所有者与实现约束 | 具体运行时方案已通过 |
| [插件合同](architecture/plugin-interface.md) | 插件作者与核心共同遵守的数据、调用和错误合同草案 | 公共版本已发布或冻结 |
| [架构与流程图](architecture/diagrams.md) | 结构、关系、关键时序；每张图注明范围 | 真实部署连接或验收结果 |
| [实施计划](../outputs/musicfs-implementation-plan.md) | 执行顺序、首条可用链路、阶段完成条件 | 工期承诺 |
| [依赖选择](../outputs/musicfs-simplification-and-dependencies.md) | 优先依赖、责任分工和采用条件 | 依赖已安装或双宿主可运行 |

## 决策与澄清

- [ADR 0001 来源插件与领域职责](adr/0001-installable-source-plugins.md)
- [ADR 0002 Worker 插件变更允许后台部署](adr/0002-worker-plugin-installation-by-deployment.md)
- [ADR 0003 插件合同独立于核心和依赖对象](adr/0003-independent-plugin-interface.md)
- [ADR 0004 共用 Fetch 只读 DAV](adr/0004-shared-fetch-readonly-dav.md)
- [ADR 0005 QQ 固定 SDK 的原始读取适配](adr/0005-pinned-qq-sdk-read-adapter.md)
- [需求澄清记录](../outputs/musicfs-design-review.md)：保留产品问题、回答和历史修正，不作为另一份独立实现方案。

## 技术证据与候选调查

| 主题 | 资料 |
|---|---|
| 新增通用机制依赖 | [表单、校验、归档、版本、部署 SDK、导入图检查](../outputs/research-architecture-dependencies.md) |
| DAV 服务端 | [服务端库复用与最新适配条件](../outputs/research-webdav-server-reuse.md) |
| Worker 插件安装 | [免费路线候选与证据边界](../outputs/research-worker-free-plugin-loading.md) |
| Bun 宿主与发行 | [Bun 评估](../outputs/musicfs-bun-desktop-evaluation.md)、[编译资源与持久化](../outputs/research-bun-executable-packaging.md) |
| 网易云及通用平台调查 | [平台 API](../outputs/platform-api-integration-research.md) |
| QQ 示例插件 | [QQ API](../outputs/qq-api-integration-research.md) |
| WebUI 依赖 | [前端与宿主复用](../outputs/research-webui-dependency-reuse.md) |
| OpenList | [接入调查](../outputs/openlist-music-drivers-followup.md) |

调查报告中标为固定提交的证据与浮动在线文档分别对待。旧调查保留其核查日期；有新证据时在原报告补充，并更新受影响的设计。尚未执行的 PoC 和验收不能写成通过。

## 历史评估

- [相似项目](../outputs/cloud-music-filesystem-research.md)、[直接可复用项目](../outputs/research-direct-projects.md)：借鉴线索，旧固定平台假设已被插件需求替代。
- [WebUI 方向变更](../outputs/musicfs-webui-design-evaluation.md)：CLI 转向 WebUI 的历史依据。
- [工作量与 ROI](../outputs/musicfs-effort-risk-roi-assessment.md)：原固定平台范围估算，未计插件化增量，待 P0 后更新。

## 文档与图表维护

需求变化更新统一需求，领域词更新术语，Module 或 Interface 变化更新架构与合同，影响时序时更新对应图。计划只记录执行，ADR 只记录值得保留的取舍，调查只记录证据与范围。Mermaid 源码保存在图表文档中，不另维护相同内容的图片副本；实现后将验证命令与结果关联到具体版本。
