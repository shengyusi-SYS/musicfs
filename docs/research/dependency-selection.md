# 方案精简与依赖替代建议

日期：2026-10-21（原调查 2026-10-18）  
范围：保留已确认功能，减少通用基础设施与手写实现。本文保留原选型调查及候选依据，不是未完成任务清单；当前实际采用以package.json、ADR及[验收台账](../verification.md)为准。

插件 Q1—Q11 已确认：数据源插件是必要产品能力，网易云与 QQ 是完整示例插件；支持多实例，来源配置及音质规则归插件。核心提供通用合同、实例与目录管理，Worker 插件变更允许后台自动部署，优先验证普通免费路线。本文已按此修订，技术证据仍以原调查和后续 P0 为界。[澄清记录](../planning/requirements-decisions.md)

本文维护通用依赖选择；领域职责、源码层级和 Interface 见 [架构设计](../architecture/README.md)，新增表单/校验、插件包、部署 SDK 与导入图的证据见 [2026-10-20 核查](architecture-dependencies.md)。表中优先采用仍须在实际版本与两个宿主中验证，未安装的候选不写为已集成。

桌面宿主已按本轮讨论更新为 Bun 建议路线，具体收益与发行边界见 [Bun 桌面评估](bun-desktop.md)。当前已有编译发行物及Linux/WSL运行证据，其他目标系统仍按台账验收。

前端保留 React + Vite，Bun 只负责桌面宿主及发行打包。精简以减少整体实现和维护成本为准，保留成熟前端工具与复杂交互所需依赖。

## 1 判断

**功能范围可以保留，工程组织与实现方式可以明显精简。** 当前文档把账号、刷新、布局、快照、音频和宿主逐项列出，适合说明职责；若机械地拆成独立包、服务和框架，就会超过当前项目需要。

建议核心按一个普通应用落地：一个代码仓库、一个共用 WebUI、两个宿主入口和少数业务模块，来源适配作为可独立交付的插件。API 与 DAV 由同一部署提供，插件包沿公开合同接入。第三方处理成熟机制，自有代码集中在必要插件管理与音乐目录的领域规则。

此前工作量估算已经假设复用平台 API 和部分 UI 组件，不能把本轮明确的复用收益重复扣除。能进一步减少的是不必要的分层和通用机制，不是取消实际平台与三端验证。

## 2 应合并或收窄的部分

| 之前可能形成的实现 | 精简方式 |
|---|---|
| 账号服务、目录服务、音频服务、刷新服务分别成包 | 核心保持少量插件/实例管理、library 和 DAV 接线；来源专属能力在插件内 |
| 为音乐目录建立完整通用文件系统 | 对 DAV 暴露列目录、元数据、打开内容；核心解释布局，插件解释来源与音质 |
| 每项刷新都建立持久化任务、调度器和状态机 | 先用普通异步函数、限并发、缓存和按需刷新；大歌单确需恢复进度时只保存必要游标 |
| 把成功列表设计成长期历史快照产品 | 保存最近成功结果与版本，刷新成功再替换；不提供历史版本管理 |
| 多层存储抽象、ORM 上再套通用 Repository | 围绕安装记录、实例状态、布局与缓存暴露少量操作；插件取得隔离存储，保留 SQLite/D1 差异 |
| 手写 UI 树、表单、轮询缓存和状态订阅 | 用同一组件库与查询库，本地编辑草稿使用 React 状态 |
| 自建桌面音频磁盘缓存 | 继续交给 rclone VFS |
| 为可点击启动引入原生窗口或另一套打包体系 | 使用 Bun 内置 compile、薄宿主入口和系统浏览器；依实际发行需要处理各系统入口 |

实例退出、条件更新、完整分页、HTTP 范围与真正挂载就绪仍需保留；插件更新恢复与移除后保留实例也是已确认责任。精简的是承载形式，不删除这些合同。

## 3 建议采用的基础依赖

| 用途 | 建议 | 替代的手写工作 | 仍需负责的内容 |
|---|---|---|---|
| 共用 HTTP | Hono；桌面使用 `Bun.serve` | 路由、中间件、Fetch 接入、静态资源响应 | 音乐与目录路由的业务处理 |
| WebUI | React + Vite + Ant Design；Pragmatic drag and drop | 构建、弹窗、树、分栏及原生拖拽 | 插件/实例管理、布局语义和落点规则 |
| 声明式插件配置 | `@rjsf/antd`、`@rjsf/core`、`@rjsf/validator-ajv8` | JSON Schema 表单和前端结构校验 | 可序列化提示、实例草稿与保存、认证步骤，核对 peerDependencies |
| 插件后台结构校验 | 官方工具链优先作者构建时 Ajv standalone ESM，随插件发布 | 标准 Schema 校验代码生成与执行 | Schema 与结果一致、来源语义校验；第三方内部可选其他实现，Worker 不动态 compile |
| 页面请求状态 | `@tanstack/react-query` | 认证轮询、部署进度、保存后失效、取消 | 生命周期与哪些操作影响目录 |
| 运行时数据验证 | Zod | 插件包、设置与布局输入检查和类型推导 | 核心校验通用合同与树，插件校验来源配置 |
| 来源冷准备并发 | 已采用`p-limit 7.3.3`，网易云/QQ各自使用 | 排队与并发计数 | 来源预算、接受顺序、失败收拢与检查点 |
| CDN多范围正文 | 网易云采用`@remix-run/multipart-parser 0.16.5` | MIME boundary、二进制part与结束边界解析 | SDK/原文件身份、各区段范围及大小、已观察到的外层类型适配；不引入Remix应用框架 |
| 发布目录视图缓存 | 已采用`lru-cache 11.5.3` | 有界容量、淘汰及本地快照加载合并 | 来源/快照身份核对、估算权重、宿主运行对象生命周期 |
| 有效配置是否变化 | 已采用`fast-deep-equal 3.1.3` | JSON对象键序无关的深相等 | 比较规范化配置与最终私态，实际变化才走原条件提交 |
| 打开系统浏览器 | `open`，仅桌面 | Windows/macOS/Linux 默认浏览器调用差异 | 等服务就绪再打开，失败时显示地址 |
| 子进程 | `Bun.spawn` | 进程、流、退出状态与终止接口 | rclone 配置、就绪、卸载、后台存活与重复启动 |
| 本地数据库与发行 | `bun:sqlite`、`bun build --compile`，`env-paths` 按需 | SQLite、核心合包、资源内嵌、三端目录 | 外部数据库、迁移、编译产物的外置插件加载、rclone 随包或释放 |
| 示例插件协议 | 网易云必要模块、QQ 的 `/serverless` 子入口 | 扫码、签名与会话机制 | 插件内部的宿主适配、来源归一化、音质规则和回归 |
| 插件归档 | 已采用`zip.js`；`fflate`仅开发期独立编码互操作 | ZIP/DEFLATE、库已有的流与归档检查 | 包清单、剩余路径/实际大小检查、暂存与激活 |
| 版本范围 | npm `semver` | 合法版本与范围、预发行语义 | 插件合同/宿主/状态兼容的业务决定 |
| Worker 发布 | 官方 `cloudflare` TypeScript SDK | API 类型、上传编码、错误、超时和低层重试 | 发布计划、资源绑定保留、结果核对及恢复 |
| 导入图 | `dependency-cruiser`，仅开发依赖 | 循环、跨层和间接越界检查 | Module 依赖规则、两宿主真实构建与插件打包验证 |
| 文件挂载与缓存 | rclone | FUSE/WinFsp 等挂载实现、文件访问与 VFS 缓存 | 系统依赖检测和应用生命周期 |

Hono 同时支持 [Bun](https://hono.dev/docs/getting-started/bun) 与 [Worker](https://hono.dev/docs/getting-started/cloudflare-workers)，桌面无需 Node adapter。其路由可以承载自定义方法，但不因此自动实现 WebDAV。[路由文档](https://hono.dev/docs/api/routing)

目录树展示继续使用 Ant Design Tree，尺寸调整使用已有 Splitter。来源跨栏添加和布局内部移动已统一为 Pragmatic drag and drop，替换 Tree 内建拖拽；两者共用目标高亮、边缘排序及预览。领域仍只维护一份草稿，不增加另一套树或拖拽引擎。现行呈现与取舍见[共用管理界面](../architecture/web-ui.md)。

组件库是否足够，以实际交互为准；缺口明显时采用合适依赖，不为了减少包数量而大量手写。Vite 统一生成前端静态产物，桌面收录这些文件，Worker 使用 Static Assets；不维护另一套 Bun 前端构建。

TanStack Query 的 [useQuery](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery) 和 [查询失效](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation)可覆盖页面服务状态。它不替代后台平台缓存，也不会自动取消平台扫码会话。

[Zod](https://zod.dev/) 与 [p-limit](https://github.com/sindresorhus/p-limit)提供各自的基础能力。[lru-cache](https://isaacs.github.io/node-lru-cache/) 提供缓存与异步加载功能，但不是 Worker 的跨 isolate 协调或持久化工具。Worker 只缓存可复用的已完成元数据，不共享可消费一次的音频流；加载合并按实际请求上下文验证。版本必须经过双端构建核查后锁定。

这是一组有具体职责的建议，不要求一开始全部安装。缓存或子进程若用少量标准代码已经足够，就不再为相同职责叠加其他包装库。仅在 SDK 自带重试不足时再评估 `p-retry`，不能让多层重试相乘。

本轮三个小依赖各替代一种具体机制，未叠加通用缓存服务。相等比较先试过`node:util.isDeepStrictEqual`，实际Worker浏览器构建不可用，不能为它放宽核心导入边界；JSON序列化会受键顺序影响，因此选择纯JS深相等。LRU比为32视图/8MiB估算容量自行维护淘汰、容量和异步加载状态更合适；Worker的持久正确性与跨isolate恢复仍来自D1。来源TTL、字节身份和刷新重试继续归各自领域，不能交给缓存库或多层自动重试推断。

## 4 WebDAV：复用验证后收敛为共用 Fetch 只读映射

已实际执行 Nephele 的固定版本与官方 Worker Node 桥接探针，Bun 基础行为可运行，本地 Worker 完整音频流仍失败；公开适配没有使其通过，因此采用已规划的 Fetch 备选。当前产品只维护这一条 DAV 路径，取舍和结果见 [ADR 0004](../adr/0004-shared-fetch-readonly-dav.md)及[P0 记录](../verification/p0-library-dav.md)。下表保留候选比较背景。

| 候选 | 评估结果 |
|---|---|
| `webdav`、`tsdav` | 是客户端，不能用来提供本项目服务 |
| `webdav-server` | 可挂自定义文件系统；默认 GET 从完整流截取范围，不能直接认定适合远端音频随机读取 |
| Nephele | 有公开自定义资源与只读插件；已执行 alpha.67 探针，Bun 基础可用，本地 Worker 完整取流失败，已退出当前开发依赖，保留历史取舍 |
| OpenList-Worker、CloudPaste、r2-webdav | 属于完整应用实现，耦合各自用户与存储；可参考或在处理许可后局部复用，不当作开箱即用的小库 |

Worker 官方现在支持 [Node HTTP 桥接](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)，不能仅凭 Node/Express 导入就认定 Nephele 无法运行。

当前薄映射复用 `@xmldom/xmldom` 的 DOM/命名空间和序列化、`range-parser` 的范围解析、Hono 的认证及 Fetch 接线。只承载已确认的只读方法、属性和音乐文件事实，不扩展完整可写 DAV。Bun、本地 Worker 和真实 rclone 的已知字节路径已验证；OpenList/播放器的本地代表性格式及真实Worker主链路已有证据，具体范围见台账。

`range-parser` 的超长 suffix 边界经集中输入规范化后覆盖；Worker 音频流用官方 FixedLengthStream。大小、实际范围、取消和截断继续由来源合同/library 核对。XML 库不等于 DAV，Range 解析库也不等于远端流代理。

候选依据：[Nephele Resource](https://github.com/sciactive/nephele/blob/8a952bcd2613433b229b770f91ee5b7888aaff96/packages/nephele/src/Interfaces/Resource.ts)、[webdav-server GET](https://github.com/OpenMarshal/npm-WebDAV-Server/blob/b78147971a2ab22ada903c370dda45c793429587/src/server/v2/commands/Get.ts)、[xmldom](https://github.com/xmldom/xmldom)、[range-parser](https://github.com/jshttp/range-parser)。采用状态以 ADR 与实际验证记录为准。

## 5 存储：少量标准 SQL 优先，不再造框架

当前核心持久状态是插件安装记录、实例配置/认证、应用设置/布局与最近成功缓存。宿主提供隔离存储，插件解释来源状态。本地使用 `bun:sqlite` 打开真实文件，Worker 使用 D1，采用原生接口及少量参数化 SQL，不建立通用多数据库驱动系统。用户状态不放进内嵌数据库。[Bun SQLite](https://bun.com/docs/runtime/sqlite)

如果表和查询明显增多，再评估 Drizzle 共用 SQLite schema、查询和迁移生成的收益。D1 的 [接入说明](https://orm.drizzle.team/docs/connect-cloudflare-d1)可作参考，Bun SQLite 与 D1 的具体驱动、版本和事务语义需一起验证，不能把候选组合写成已经集成。

目前没有必要为少量 SQL 同时引入 ORM、通用 Repository、Unstorage 和另一套数据库封装。Drizzle 是按实际查询量引入的候选，不是先装上才能开始。

## 6 最小源码组织

源码层级和各 Module 的公开 Interface 统一见 [架构设计](../architecture/README.md#模块组织)，不另维护一份目录树。

核心保持一个应用工程，不为每个职责发布包或创建服务；来源插件则提供可独立安装的构建产物。Bun 与 Worker 使用不同后端入口，隔离本机能力。两端共用 Vite 静态资源，新插件不要求重编译前端；Worker 插件变更允许组装预构建模块并后台部署，普通路线发布已有真实证据，免费计划额度结论仍待验。

核心负责插件/实例管理、目录布局和 DAV 接线；来源插件负责认证、内容和音质等专属规则。目录调用者只需理解列目录、元数据和打开内容，不接触来源协议；插件也不需要实现整套 WebDAV。

## 7 可以明确不再叠加的东西

- Hono 之外的第二套通用 HTTP 框架，除非 DAV 候选经 PoC 证明整体更省事。
- 当前管理页面用不到的 SSR/BFF。
- 同一交互已被 Ant Tree 覆盖时，再叠加 Arborist、dnd-kit；存在实际缺口时正常评估。Query 已覆盖的轮询与查询状态，也不再重复造同等机制。
- 没有实际需求的独立工作流或队列；插件仅建立满足已确认合同的管理与注册，不扩展为全应用插件市场。
- 完整 POSIX 文件系统、额外音频缓存、自研 FUSE。
- 为现有可点击启动目标引入 Electron/Tauri，或在 Bun 内置编译之外再叠加一套可执行程序打包工具。

这些是避免新增复杂度的实现约束，不声称上一版已经要求了所有这些依赖。账号并发更新、正确 Range 与三端验证仍是实际工作。

## 8 还必须自己实现的部分

第三方可以处理机制，当前产品特有的规则仍需实现：

1. 核心插件合同、包兼容、安装/更新/移除、多个实例及隔离状态。
2. 核心用户布局、动态内容源映射、快照和合法路径。
3. 示例插件的认证、分类与分页、单/多音质、回退和实际文件去重。
4. 插件提供真实元数据、临时地址处理和上游范围取流，核心保证协议与取消接线。
5. 桌面编译产物的外置插件加载，Worker 预构建模块组装/自动部署及失败恢复。
6. WebDAV 接线、桌面挂载就绪、卸载、重复启动与后台存活。

目标是把代码集中在这些规则上，减少为它们另造一层基础设施。平台接口在真实 Worker 中能否使用，以及所有系统能否正确挂载，依然需要运行验证。

关联证据：[WebUI 与宿主依赖核查](webui-dependency-reuse.md)、[WebDAV 服务端核查](webdav-server-reuse.md)、[统一方案](../requirements.md)、[工作量与 ROI](../planning/implementation.md)。
