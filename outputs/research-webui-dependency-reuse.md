# WebUI 与双端宿主的依赖复用核查

核查日期：2026-10-18。范围：当前 musicfs 方案中的共用 HTTP、WebUI、目录树、扫码轮询，以及桌面启动和 rclone 进程辅助。依据为官方文档和仓库源码；未安装依赖，未运行集成样例，未修改主方案。

## 结论

这部分可以显著减少手写通用代码。推荐使用 **Hono + React/Vite + Ant Design + TanStack Query**，桌面再加 **`@hono/node-server` 与 `open`**；rclone 子进程先用 Node 内置 `child_process.spawn`。Cloudflare 使用 Workers Static Assets。这是一套具体建议，不是全部必选依赖清单。

真正仍需实现的是：内容源与导出布局之间的映射、设置和布局保存、音质规则、平台登录流程的业务状态，以及实际挂载的生命周期。第三方 UI 和 HTTP 库不能替代这些音乐文件系统语义。

## 1. HTTP：一套 Hono 路由，两个薄入口

Hono 官方同时提供 [Workers 入口](https://hono.dev/docs/getting-started/cloudflare-workers)和 [Node adapter](https://hono.dev/docs/getting-started/nodejs)。推荐共用一个创建应用的函数；Worker 导出 Fetch handler，桌面通过 `@hono/node-server` 监听并提供静态文件。宿主存储和挂载能力作为少量依赖传入，无需两套 API 服务或两套控制器。

Hono 路由可以用 `.on()` 注册自定义 HTTP 方法，因此可以承载 `PROPFIND` 等 WebDAV 请求；**Hono 自身并不实现 WebDAV 协议**。[路由文档](https://hono.dev/docs/api/routing)

Node adapter 的 `serveStatic` 已提供本地文件响应，不用再加 Express、Fastify、静态文件服务器。发行时资源目录应从包的位置解析，避免依赖用户启动时的工作目录。adapter 返回的 HTTP server 仍须由应用关闭。[Node adapter 文档](https://hono.dev/docs/getting-started/nodejs)

Worker 可直接部署同一份 Vite 构建资源，使用 `ASSETS` 绑定和 SPA fallback。`/api/*`、`/dav/*` 应明确由 Worker 先处理，避免缺失的 API/DAV 路径落入 SPA 返回 HTML。这是部署路由配置，不用自建云端静态资源服务。[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)

兼容性：当前 Node adapter manifest 要求 Node >=20；Hono 文档列出的历史最低版本可能更宽，实施时以锁定版本的 manifest 为准。Node adapter 只能放桌面入口，不能因为共用 Hono 就把其 Node 导入带进 Worker。[adapter manifest](https://github.com/honojs/node-server/blob/main/package.json)

## 2. WebUI：React + Vite，选择一个组件体系

Vite 有官方 React/TS 模板；其生产产物可以是普通静态资源。这里没有 SSR、搜索引擎收录或服务端组件需求，使用 SPA 即可，无需 Next.js、SSR 层或额外 BFF。构建工具的 Node 版本要求属于开发/构建环境，不代表用户需要安装 Node。[Vite 入门](https://vite.dev/guide/)

建议采用 Ant Design 的普通组件完成设置表单、账号状态、对话框和目录树。它已有 Tree 拖拽能力，单纯为了相同的树交互再引入其他完整树库会重复。当前 Ant Design manifest 的 React 与 React DOM peer 依赖为 >=18；发行需锁定一个兼容组合。[Ant Design manifest](https://github.com/ant-design/ant-design/blob/master/package.json)

### 目录树候选对比

| 候选 | 已提供能力 | 本项目仍需做什么 | 建议 |
|---|---|---|---|
| Ant Design `Tree` | `treeData`、受控展开/选择、`draggable`、`onDrop`、`allowDrop`、异步加载、虚拟滚动 | 处理拖拽后布局数据、源引用、允许的目标位置、保存和预览 | 若整个 WebUI 用 Ant Design，优先选它 |
| `react-arborist` | 拖拽排序、重命名、虚拟化、键盘交互和受控树 | 接入 `onMove` 等回调、持久化及业务语义 | 想做高度定制的文件管理器外观时可替代 Ant Tree，首版无需同时装 |
| dnd-kit | 拖拽底层构件、传感器和排序工具 | 自己组合树展示、嵌套移动及树状态 | 当前成熟树组件已够用，暂不引入 |

依据：[Ant Tree API](https://ant.design/components/tree/)、[react-arborist 官方仓库](https://github.com/jameskerr/react-arborist)、[dnd-kit 官方站点](https://dndkit.com/)。react-arborist 当前 README 另列 `react-dnd` 和 `react-dnd-html5-backend` 为 peer 依赖；不能把它理解为零附加依赖。

Ant Tree 文档直接覆盖的是树中节点排序与移入另一父节点。**“从独立内容源面板拖入另一棵树”不能仅据此宣称开箱即用**；如果最终交互确实采用这种形式，需验证或写一小层事件胶水。当前需求可先采用“选择来源加入布局，再在一棵布局树内拖动”。不应为尚未确定的跨面板交互预装两套拖拽系统。

组件承担展示与交互。本项目保存的应是目录布局和内容源引用，不能保存一份 UI 树的歌曲快照后就把它当成动态文件系统。动态歌单刷新、节点引用和音质设置都仍由业务核心解释。

## 3. TanStack Query：适合现有服务状态，避免手写轮询框架

推荐使用 `@tanstack/react-query` 处理账号状态、扫码状态、后台状态和已保存设置的请求。`refetchInterval` 可以根据返回状态继续或停止，`enabled` 控制何时开始；可用该能力完成扫码轮询，无需为轮询引入 WebSocket/SSE 基础设施。[useQuery](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)

设置或目录保存成功后，用 mutation 配合按 key 的 `invalidateQueries` 刷新受影响查询，避免自己维护一套服务数据缓存与订阅事件总线。[Query Invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation)

业务仍须决定什么是扫码完成/失效、何时重新申请二维码、哪些操作刷新目录。查询的 `AbortSignal` 可传入原生 `fetch`，但前端取消请求并不自动等价于服务端取消平台登录会话。[Query Cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)

注意其默认窗口聚焦刷新、重试和后台轮询行为，按登录接口语义配置即可；不需要另外设计一套前端任务调度系统。尚未保存的目录编辑树和表单草稿，用 React 本地 state/reducer 或组件表单状态管理即可，首版不必再加 Redux、Zustand、XState。该判断是基于当前页面范围的工程建议，并非这些库无法使用。

## 4. 桌面启动与 rclone：标准 API 足够，保留实际宿主责任

| 工作 | 最小复用方案 | 仍需由应用实现 |
|---|---|---|
| 打开默认浏览器 | `open` | 等 HTTP 服务就绪后打开本机 URL，打开失败时给出可复制地址 |
| 启动 rclone | `node:child_process.spawn`，参数数组、直接执行随包二进制，读取 stderr/退出事件 | 配置生成、挂载状态确认、卸载、占用时反馈、后台存活与重复启动复用 |
| 构建 WebUI | Vite | 将静态产物复制到桌面包与 Worker assets |
| 编译桌面 TS | 先用 TypeScript 编译并携带生产依赖；需要合并产物时再选一种 bundler | Node、rclone、资源和平台启动入口的发行目录组装 |
| 构建/发布 Worker | Wrangler | 绑定与部署配置、真实 Worker 验证 |

`open` 官方提供 macOS、Windows、Linux 的系统默认应用处理；当前主包为 ESM、Node >=20。它只负责打开地址，不是后台守护或安装器。[官方仓库](https://github.com/sindresorhus/open)、[manifest](https://github.com/sindresorhus/open/blob/main/package.json)

Node 自带异步子进程、流、退出事件、`AbortSignal`、`windowsHide` 等能力。对只管理少量固定程序的本项目，先用这些标准 API 已足够；没有证据需要首版同时引入 execa、cross-spawn、tree-kill、PM2 或多套 daemon 库。[Node 子进程文档](https://nodejs.org/api/child_process.html)

`execa` 可以替代部分调用样板，但不会知道盘符是否出现、挂载是否成功、系统依赖是否就绪，也不会实现应用的重复启动协议。它当前是 ESM，manifest 要求 Node >=22。若后续子进程调用复杂到有明显收益，再以它替代薄封装，而非与多套同类库叠加。[官方仓库](https://github.com/sindresorhus/execa)、[manifest](https://github.com/sindresorhus/execa/blob/main/package.json)

**打包建议保持“自带运行时的目录式发行包”。** 当前没有单文件要求，不要为了一个图标可点击就强加 Electron、Tauri 或单可执行打包。Node 自身有 SEA 能力，但那是可选发行优化；rclone 与静态资源也仍需妥善安排，并不能消除三端验证。[Node SEA](https://nodejs.org/api/single-executable-applications.html)

各系统的薄启动入口仍须适配，尤其 Windows 无控制台启动、macOS 应用入口和 Linux 桌面入口。Node 后台与 rclone 的存活关系、真正就绪、卸载与退出，不能交给打开浏览器的库。rclone 的 Windows `--daemon` 会被忽略；Windows 需要 WinFsp，macOS 可验证 `nfsmount` 路线。这些是现有挂载目标直接带来的宿主工作，不是新增产品需求。[rclone mount](https://rclone.org/commands/rclone_mount/)、[nfsmount](https://rclone.org/commands/rclone_nfsmount/)

## 5. 推荐最小集合与许可

以下仅列本次范围；平台 API、WebDAV、数据存储依赖另行核查。

| 用途 | 推荐直接依赖/工具 | 许可或性质 |
|---|---|---|
| 共用 HTTP | `hono` | [MIT](https://github.com/honojs/hono/blob/main/LICENSE) |
| 桌面 HTTP/静态资源 | `@hono/node-server` | [MIT](https://github.com/honojs/node-server/blob/main/LICENSE) |
| 页面 | `react`、`react-dom` | [MIT](https://github.com/facebook/react/blob/main/LICENSE) |
| UI 与拖拽树 | `antd` | [MIT](https://github.com/ant-design/ant-design/blob/master/LICENSE) |
| 服务查询状态 | `@tanstack/react-query` | [MIT](https://github.com/TanStack/query/blob/main/LICENSE) |
| 桌面打开浏览器 | `open` | [主包 MIT](https://github.com/sindresorhus/open/blob/main/package.json) |
| 构建开发 | `typescript`、`vite`、React 对应 Vite 插件、`wrangler` | 构建工具，不随最终浏览器页面或 Worker 引入 Node 运行时；[Vite MIT](https://github.com/vitejs/vite/blob/main/LICENSE) |
| 子进程 | Node 内置 API | 不额外增加 npm 依赖 |
| 云端页面资源 | Workers Static Assets | Cloudflare 托管能力，不增加运行时 npm 库 |

备选 `react-arborist` 为 [MIT](https://github.com/jameskerr/react-arborist/blob/main/LICENSE)，经典 dnd-kit 仓库也为 [MIT](https://github.com/clauderic/dnd-kit/blob/master/LICENSE)，execa 为主包 MIT。MIT 结论针对所链接主包；正式发行仍沿锁文件保留所携依赖和二进制的实际第三方许可。

## 6. 目前不必引入与仍需验证的边界

不必引入：Next/SSR、Node 双 HTTP 框架、独立云端静态服务器、多个树或拖拽库、多个前端服务状态库、单独轮询调度器、全套进程守护框架、Electron/Tauri，以及为了单文件发行而新增的打包链路。若后续出现明确新需求，再局部评估，不能将这些假设算成当前工作量。

验证集中在以下实际集成点：

- Hono/Node adapter 对 WebDAV 自定义方法、HEAD 与流式响应的行为；这不能替代 WebDAV 协议本身的验证。
- Worker 静态路由与 `/api`、`/dav` 的优先级，以及同一前端构建产物在两种宿主中的路径。
- 受控树的移入、排序、保存和动态来源更新。若需要跨独立面板拖入，单独验证该交互；无需先堆库。
- 启动器打开浏览器前的就绪检查，以及三端挂载、卸载和后台退出。

这些依赖能减少页面、路由和通用调用样板，**不会解决网易云 Worker 适配、QQ 出口取流或音频 Range 的核心不确定性**。因此适合下调通用层手写范围，不适合仅凭依赖数量直接大幅压缩平台验证预算。
