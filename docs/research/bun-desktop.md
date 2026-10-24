# 桌面 Bun 方案评估与精简建议

日期：2026-10-18。依据：Bun、Hono 官方文档与发行源码核查。原调查时未安装 Bun，未编译或运行本项目；以下是推荐设计与待验证范围。2026-10-20 的当前环境检查已发现 Bun 1.4.3，仍无本项目编译或运行通过证据，执行安排见 [实施与交付计划](../planning/implementation.md)。

2026-10-20 设计更新：来源能力改为可安装插件，网易云与 QQ 是完整示例；音质配置和规则由插件定义并按实例保存。Bun 仍只负责桌面宿主与核心发行，编译产物必须验证外置插件加载；Worker 已接受后台自动部署的插件安装路线。此更新不增加运行通过证据。[统一方案](../requirements.md)

## 1 结论

**建议把桌面宿主改为 Bun，用其内置能力减少桌面运行与发行依赖；前端保留 React + Vite。** 当前“本地后台 + 浏览器 WebUI + rclone”的形态很适合这一选择，不需要为可执行程序另引入桌面窗口框架。

共用业务核心、公开插件合同、WebDAV 与 WebUI 保留，来源专属 API 进入可安装插件；桌面由 Bun 承载，Worker 使用 Cloudflare 运行时。首版不再同时维护另一套 Node 桌面发行。

本轮修订按用户要求保留成熟前端工具链。目录拖拽、异步内容、设置联动和状态反馈的交互复杂度需要正常处理，不能因页面属于管理 SPA 就推断前端构建工具可以省略。技术选择以减少整体实现与维护成本为准，不以使用更多 Bun 内置功能为目标。

这项调整主要改善桌面交付与基础设施代码。平台适配、音质和目录规则、WebDAV 正确性、rclone 挂载行为仍是主要工作。

## 2 可以直接收拢的部分

| 原方案或可能新增的依赖 | Bun 方案 | 本项目仍需负责 |
|---|---|---|
| 随包 Node、后端 JS、单独静态资源定位 | `bun build --compile` 打包运行时与后端，收录 Vite 生成的静态资源 | 各目标产物、完整静态资源收录、外部可写目录与系统发行入口 |
| Hono 的 `@hono/node-server` | `Bun.serve` 调用共用 Hono 的 Fetch 处理入口 | API、DAV 与页面路由分流，音频流超时与取消 |
| 额外 SQLite 原生绑定 | `bun:sqlite` 打开真实文件 | 少量 SQL、迁移，以及 D1 的必要适配 |
| Node 子进程代码或额外包装库 | 直接 `Bun.spawn` | rclone 配置、挂载就绪、卸载、退出与重复启动 |
| 独立后端打包工具 | Bun 承担后端编译与可执行程序构建；Vite 继续承担前端构建 | 两类产物的打包接线，不重复编译前端源码 |
| 后端独立单元测试运行器 | `bun:test` 可用于后端与共享逻辑 | 前端测试按组件与交互需要选择，真实 Worker 和三端验收保留 |

能力依据：[可执行程序](https://bun.com/docs/bundler/executables)、[HTTP 服务](https://bun.com/docs/runtime/http/server)、[Hono Bun 接入](https://hono.dev/docs/getting-started/bun)、[SQLite](https://bun.com/docs/runtime/sqlite)、[子进程](https://bun.com/docs/runtime/child-process)、[HTML 构建](https://bun.com/docs/bundler/html-static)、[测试](https://bun.com/docs/test)。

前端基线为 React + Vite + Ant Design Tree/Form + TanStack Query。Vite 负责开发服务器、热更新、插件与生产构建；Bun 的 HTML/TSX 构建属于已核查能力，本项目不因此替换 Vite。前端产物交给桌面与 Worker 两种宿主使用，不要求另起 Vite 生产服务。[Vite 静态部署](https://vite.dev/guide/static-deploy.html)

交互实现优先使用组件库现有能力；对实际出现的缺口，再评估合适的交互依赖，不为了限制依赖数量而改为大量手写。草稿、保存、异步状态与树结构变更由页面正常建模，不为配合 Bun 发行重写这些逻辑。

类型检查仍是独立检查项。当前官方文档已有 `bun check` 及 `bun build --check`，可以在支持它的锁定版本上采用；不把普通编译成功当成类型检查通过。旧版本可使用 `tsc --noEmit`。编辑器类型版本与 Worker、桌面各自的类型环境仍需配置。[Bun 类型检查](https://bun.com/docs/runtime/check)

## 3 保留的依赖与边界

- **Hono 保留。** 桌面和 Worker 共用路由及中间件，Bun 只承担桌面监听。把业务路由全部改写为 Bun 专用 routes，会增加两套实现的维护。
- **React、Vite、Ant Design Tree/Form、TanStack Query 保留。** 前端依赖按交互需要选择，Bun 的使用范围不限制前端开发与测试生态。
- **Zod、p-limit 和按实际需要采用的元数据缓存保留。** Bun 不自动实现输入规则、平台请求预算或缓存有效期。
- **DAV 复用验证与 XML/Range 小依赖保留。** HTTP 服务器不等于 WebDAV 服务端。当前 Bun 虽有 `Bun.XML`，但它是运行时专用 API；共用 DAV 采用一个可在双端运行的 XML 库更简单，无需为省一个包新增两种 XML 适配。[Bun XML](https://bun.com/docs/runtime/xml)
- **`open` 继续用于打开系统浏览器，`env-paths` 可用于应用数据目录。** 不为采用 Bun 而重写三端路径与浏览器调用。`Bun.openInEditor` 的作用是打开编辑器；当前实验性 `Bun.WebView` 面向无头浏览器自动化，不能直接作为本项目的可见桌面窗口方案。[Bun 工具](https://bun.com/docs/runtime/utils)、[WebView](https://bun.com/docs/runtime/webview)
- **rclone 与所选系统挂载设施保留。** Bun 负责启动和管理进程，不提供 FUSE、WinFsp 或挂载实现。

示例插件在自己的产物中收录必要上游模块，显式使用实例上下文；核心不静态固定所有平台实现。桌面宿主从真实应用目录安装并加载兼容插件，不要求用户重新编译核心。Bun 的 Node 兼容能力有助于接入，但编译产物的外置模块加载、资源、加密和网络接口仍需实测；`--compile` 不自动证明兼容。[Node 兼容性](https://bun.com/docs/runtime/nodejs-compat)

## 4 双宿主最小结构

源码层级、领域 Module 和 Adapter 的唯一目录设计见 [架构设计](../architecture/README.md#模块组织)。本评估只保存 Bun 运行与发行方面的依据，不另维护平行目录树。

业务层使用标准 Request、Response、fetch、Web Streams 和 AbortSignal。`Bun.*` 与 `bun:sqlite` 留在桌面入口和本地数据实现；Worker 导入图不能触达这些代码。

同一份 WebUI 源码统一由 Vite 构建为普通静态文件。桌面打包阶段将其收录进可执行程序或发行包，由本地后台提供；Worker 使用 Static Assets，初始发布可用 Wrangler，插件变更优先验证后台组装预构建模块并自动部署。新增插件复用声明式配置与认证界面，不为安装插件重新构建 WebUI。

资源收录需覆盖 HTML、JS 分块、CSS 和引用资产，保留 Vite 生成的路径关系；其具体接线在 P0 验证。Worker 部署的是标准静态资源与 Worker 脚本，不是 Bun 可执行程序；Wrangler、D1 和真实 Cloudflare 验证继续保留。

桌面与 Worker 均优先匹配 API/DAV，再处理页面与 SPA 回退，避免 PROPFIND 或错误路径收到 HTML。

## 5 可执行程序与 rclone

Bun 提供 Windows、Linux、macOS 的多种架构目标和交叉编译。每种目标分别生成可执行文件；交叉编译不替代目标系统验证。Windows 可使用隐藏控制台选项，macOS 根据发行方式做薄 `.app` 包装。详细证据见 [发行边界核查](bun-executable-packaging.md)。

建议区分“用户下载的发行物”和“运行时文件”：

| 发行偏好 | 推荐方式 |
|---|---|
| 最少运行时代码 | 应用可执行文件内嵌 WebUI，rclone 与其随包提供；用户仍无需另装或配置 rclone |
| 一个可执行文件下载 | rclone 作为二进制资产内嵌，首次使用写到应用数据目录的版本化 `bin/` 路径，再从真实路径启动 |

官方保证可读取内嵌文件，未明确保证能直接 spawn 内部虚拟资源路径。“先释放再执行”是推荐的实现方式，目前未经过本项目实测，不作所有系统都绝对无法直接执行的断言。

账号、设置、布局和音频缓存使用用户目录中的真实文件。`bun:sqlite` 打开外部 `state.db`；内嵌数据库只能作为初始资源使用，其修改不会跨进程退出保存。音频磁盘缓存继续交给 rclone VFS。

`Bun.spawn` 提供进程、流、退出与终止基础能力，但不判断音乐盘是否已可读。`unref()` 也不应直接当成三端可靠后台服务方案。当前只需验证点击启动后的后台存活、重复启动复用、关闭网页后挂载继续和正常退出，不新增自动启动、托盘或更新系统。

## 6 工作量、风险与 ROI

**推荐采用，ROI 高，收益主要集中在桌面运行和发行。** 最直接减少的是运行时目录拼装、静态资源查找、HTTP 适配和 SQLite 绑定的维护。前端继续使用 Vite，不将替换成熟前端工具计为收益，也不为减少工具数量增加兼容代码。

它不会显著改变平台接口、CF 出口、音频 Range 与三端挂载的工作量。原来的整体预算不因此统一打折；先将 Bun 编译、组件构建、平台模块与 rclone 的验证并入已有 P0，再根据结果调整桌面发行项。编译后包体与启动表现也以实测为准，不承诺固定提升比例。

实施前的最小验证集合：

1. 固定 Bun 版本，编译一个包含共用路由、WebUI 和外部 SQLite 的程序；确认退出重启后设置保留。
2. 验证 Vite 静态产物完整收录、资源路径和页面交互正常；编译后的桌面核心可安装/加载外置最小插件并更新、移除、重装，Worker 构建不导入 Bun 专用 API。
3. 用已知音频验证 HEAD、首中尾 Range、流取消和超时；再用 OpenList、rclone 实际访问。
4. 在支持的三端发行目标验证 rclone 随包/释放、启动、挂载就绪、卸载与后台退出。
5. 验证示例插件只经公开合同提供登录、内容和音频；同一插件的多个实例及配置互相隔离。Worker 自动部署与免费限额另按统一方案 P0 核查。

这些验证沿用现有验收范围，不是新增产品功能。当前结论是设计适配性高，尚不是完成三端验证的兼容承诺。

关联：[统一方案](../requirements.md)、[依赖精简](dependency-selection.md)、[工作量与 ROI](../planning/implementation.md)。
