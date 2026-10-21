# MusicFS 文档索引

先按阅读目的选择入口。现行说明、版本证据和工程经验分别维护；`outputs/` 中的需求与计划保留原路径，不复制成第二份规范。

## 使用与开发

| 目的 | 入口 |
|---|---|
| 选择实际版本、升级、启动和部署 | [交付物](release.md)、[用户指南](user-guide.md) |
| 桌面挂载、WinFsp、本机 HTTPS | [桌面说明](desktop.md) |
| 部署或升级 Worker 并保留插件 | [Worker 指南](worker.md) |
| 连接 OpenList、播放器和客户端缓存 | [客户端说明](clients.md) |
| 理解配置、认证、刷新与桌面路由 | [管理 API](management-api.md) |
| 开发命令、实现位置与探针 | [开发说明](development.md) |
| 开发独立数据源插件 | [作者指南](plugin-authoring.md)、[公开合同](architecture/plugin-interface.md) |

## 需求、设计与执行

| 内容 | 唯一主要入口 |
|---|---|
| 用户结果、产品范围和 FR01—FR25 | [统一需求](../outputs/musicfs-requirements-and-technical-design.md) |
| 领域词定义 | [术语表](../outputs/GLOSSARY.md) |
| 模块、层级、依赖和状态所有权 | [架构](architecture/README.md) |
| 跨模块关系与关键时序 | [图表索引](architecture/diagrams.md) |
| 标签、最终表示和格式限制 | [可选音频标签](architecture/audio-tags.md) |
| 刷新请求、SDK 批量及按需工作 | [刷新性能](architecture/refresh-performance.md) |
| 各类缓存和目录周期更新 | [缓存策略](architecture/cache-policy.md) |
| App 挂载和直接 DAV 的字节缓存 | [挂载设计](architecture/desktop-mounts.md)、[共享读取](architecture/shared-read-cache.md) |
| 共用页面责任和视觉基线 | [WebUI 设计](architecture/web-ui.md) |
| 使用流程、备选交互和取舍 | [UI / UX 决定](../outputs/musicfs-ui-ux-decisions.md) |
| 性能主线执行与完成标准 | [Codex 目标](codex-goal.md) |
| 当前进展、ROI 候选与重开条件 | [实施计划](../outputs/musicfs-implementation-plan.md)、[缓存决定](../outputs/musicfs-cache-optimization-plan.md) |
| 跨领域、实际场景的优化空间复评 | [六领域评估与主代理核查](../outputs/musicfs-performance-review.md) |
| 整体复盘与工作量口径 | [方案复盘](../outputs/musicfs-effort-risk-roi-assessment.md) |
| 可跨后续任务复用的结论 | [MusicFS 工程经验](engineering-lessons.md) |

## 证据与选型

[验收台账](verification.md)统一索引实现、实测范围和未验项。近期证据包括[按需挂载](verification/lazy-mount-feasibility.md)、[请求减法](verification/netease-cold-request-reduction.md)、[挂载消费与播放成本](verification/cache-consumption-2026-10-21.md)、[直接 DAV 共享读取](verification/shared-read-cache.md)。历史结果只证明当时版本和环境，不自动升级为当前全平台通过。

| 调查主题 | 资料 |
|---|---|
| RJSF、Ajv、ZIP、semver、导入图等依赖 | [选型解释](../outputs/musicfs-simplification-and-dependencies.md)、[主源调查](../outputs/research-architecture-dependencies.md) |
| HTTP/DAV 与读取缓存 | [DAV 候选](../outputs/research-webdav-server-reuse.md)、[共享缓存候选](research/shared-read-cache-options.md) |
| Bun 宿主与发行 | [Bun 评估](../outputs/musicfs-bun-desktop-evaluation.md)、[编译资源](../outputs/research-bun-executable-packaging.md) |
| 来源 SDK | [网易云](../outputs/research-netease-worker-sdk.md)、[QQ](../outputs/qq-api-integration-research.md)、[平台 API](../outputs/platform-api-integration-research.md) |
| Worker 代码安装 | [免费路线调查](../outputs/research-worker-free-plugin-loading.md) |
| 页面和客户端 | [WebUI 依赖](../outputs/research-webui-dependency-reuse.md)、[OpenList](../outputs/openlist-music-drivers-followup.md) |

## 决策与历史

- [ADR 0001 来源插件与领域职责](adr/0001-installable-source-plugins.md)
- [ADR 0002 Worker 插件变更允许后台部署](adr/0002-worker-plugin-installation-by-deployment.md)
- [ADR 0003 插件合同独立于核心和依赖对象](adr/0003-independent-plugin-interface.md)
- [ADR 0004 共用 Fetch 只读 DAV](adr/0004-shared-fetch-readonly-dav.md)
- [ADR 0005 QQ 固定 SDK 的原始读取适配](adr/0005-pinned-qq-sdk-read-adapter.md)
- [ADR 0006 普通 Worker 的代码发布与安装激活](adr/0006-worker-code-publication.md)
- [ADR 0007 目录刷新按持久页推进](adr/0007-durable-paged-refresh.md)

[需求澄清](../outputs/musicfs-design-review.md)、[相似项目](../outputs/cloud-music-filesystem-research.md)、[早期复用调查](../outputs/research-direct-projects.md)与[WebUI 方向评估](../outputs/musicfs-webui-design-evaluation.md)供追溯。被替代的固定平台假设、阶段工期和中间计划不再并列生效，必要时查 Git 历史。

## 维护规则

需求写结果，术语只写定义，设计写现行合同，计划只写决定与下一步，验证写版本证据，发行页写实际产物。改变事实时重写过时段落，避免不断追加“现已完成”来解释旧待办。

同一机制只保留一份图源，其他入口链接它；Mermaid 表示逻辑关系，不另维护同内容图片。历史实验保留其版本和未覆盖范围，经验总结不复制日期、提交、日志、计数或临时环境细节。仅记录 MusicFS 自身结论。
