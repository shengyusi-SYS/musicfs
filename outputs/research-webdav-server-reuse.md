# WebDAV 服务端复用核查

## 实施后的状态（2026-10-20）

后续已安装并运行 Nephele alpha.67/只读插件、Bun 与本地 workerd 探针，得到比下文只读调查更强的证据。当前已按原备选采用共用 Fetch 只读映射、xmldom 和 range-parser；Nephele 的 Worker 完整取流失败保留为调查，不作为第二套产品路径。决定见 [ADR 0004](../docs/adr/0004-shared-fetch-readonly-dav.md)，已通过与尚缺范围见[P0 记录](../docs/verification/p0-library-dav.md)。下文保留调查时的证据边界，不代表最新采用状态。

## 2026-10-20 补充：采用边界与本轮证据

**决策保持为「优先验证 Nephele + 自定义只读 Adapter + 宿主官方 HTTP 桥接」；未升级为「已采用」或「Bun / Worker 已兼容」。** 本轮成功读取 Cloudflare 官方 HTTP 兼容文档；Nephele 固定提交 GitHub 页面读取失败，随后一次备用 raw 源码读取也失败，没有继续重试、下载整仓库或提高权限。下文 2026-10-18 的固定提交源码核查保留为历史证据；本轮没有重新取得 Resource、Adapter、Properties、GET 或只读插件的源码，不能声明其当前主分支接口未变化。

### 1. 已确认的 Worker 桥接与限制

Cloudflare 当前官方文档提供 `node:http.createServer`、`cloudflare:node.httpServerHandler` 与 `handleAsNodeRequest`。前者能将 Node HTTP 服务接入 Worker，后者允许先由 Fetch 入口分流再转入 Node 服务；`listen()` 的端口是内部路由标识，不是额外部署一台服务器。因此，「Nephele 使用 Express / Node HTTP」本身不构成排除理由。该文档同时说明，HTTP 服务端需要相应兼容能力，具体开关随 compatibility date 改变；PoC 应锁定日期和 Wrangler 配置，不能只记录“开启 Node 兼容”。[官方 HTTP 兼容文档](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)

HTTP 桥接仍经 Fetch 执行。Node 请求和响应采用可读／可写流，但底层 socket 能力有限，连接管理及响应语义存在差异。官方特别指出：存在 body 时，`Content-Length` 按 Fetch 规则处理，手工设置的值会被忽略。**这不是“长度一定丢失”的结论，也不能假定 Nephele 设置的值一定原样通过；必须观测真实 HEAD、完整 GET、206 的响应头、实际字节数及结束行为。**[官方 Node HTTP 差异说明](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/#other-differences-between-nodejs-and-workers-implementation-of-nodehttp)

### 2. Nephele 接口：沿用固定提交证据，避免误当领域接口

2026-10-18 的已有核查以提交 `8a952bcd2613433b229b770f91ee5b7888aaff96` 为准：`Resource.getStream(range?: { start, end })` 接受字节范围，并要求范围对应的流；资源接口还涉及长度、ETag、MIME、名称、子项、属性、锁和修改操作，Adapter 是资源定位等能力的接入点。因此它支持把读取范围下推，但**不是只写 `list/stat/open` 三个函数即可满足的库接口**。只读部署仍需满足库的类型合同，拒绝修改的实现不得变成一套新的可写领域模型。[固定提交 Resource](https://github.com/sciactive/nephele/blob/8a952bcd2613433b229b770f91ee5b7888aaff96/packages/nephele/src/Interfaces/Resource.ts)、[固定提交 Adapter](https://github.com/sciactive/nephele/blob/8a952bcd2613433b229b770f91ee5b7888aaff96/packages/nephele/src/Interfaces/Adapter.ts)

已有核查记录了官方 `@nephele/plugin-read-only`。PoC 优先复用其修改拦截，再核验实际允许的方法、资源拒绝行为及响应状态；本轮没有取得其源码，不能断言它取消了 Adapter 的所有修改／锁／属性方法要求。[Nephele 官方仓库及插件目录](https://github.com/sciactive/nephele)

`Resource`、Node `Readable`、Express 的请求对象都应停留在 DAV 基础设施适配模块内。数据源插件继续只提供项目公开的目录／文件／读取合同，不导入 Nephele，也不实现 DAV。宿主专用的 Node / Web Stream 转换只在这个适配边界进行，优先使用运行时现成转换能力；是否完整支持仍由 Bun 和 Worker 各自构建与运行证明。

### 3. 哪些工作由依赖承担，哪些属于 MusicFS

| 职责 | 所有者与采用边界 |
|---|---|
| DAV 方法路由、PROPFIND XML、标准属性响应、HTTP Range 的协议处理 | 优先交给 Nephele；逐项用实际客户端证明，不复制一份协议实现作为平行路径 |
| DAV 修改禁用 | 优先官方只读插件；MusicFS 的只读文件视图本身也不提供上游修改能力 |
| 插件认证、音质策略、来源分页、上游媒体定位 | 数据源插件；核心与 DAV 库都不解释“无损”“喜欢”或“推荐” |
| 实例身份与配置版本、布局引用、内容快照、稳定文件身份 | MusicFS 的应用与领域模块；DAV Adapter 只映射已确定的视图 |
| 文件长度、实际表示版本、MIME 与 ETag 的真实含义 | 来自插件读取结果和文件视图；库可以输出这些字段，不能推断音乐来源的事实 |
| 精确范围读取、上游忽略 Range、授权 URL 过期、错误分类 | 插件／读取服务执行项目合同；库收到一个流不等于上游已经正确读取该范围 |
| 取消、背压、流销毁和上下游错误传递 | DAV Adapter 与读取服务的接线责任；复用运行时流机制，不自己维护全量缓冲或通用流框架 |
| Node HTTP 与 Fetch 入口桥接 | Bun / Cloudflare 宿主及其官方兼容能力；不得散落在核心或每个数据源插件里 |

具体地，不能将上游对 Range 请求返回的 `200` 完整文件，直接标为 `206`。要么由已有、可验证的读取能力产出精确范围，要么拒绝／显式降级，并停止不必要的上游传输；不能默认从头下载再丢弃大量音频字节。上游 `206` 也要核验 `Content-Range`、表示长度与实际传输范围。取消发生在响应头前、读取中或多范围分支时，都需继续传递到实际媒体请求，而不是只销毁面向客户端的包装流。这些是项目读取合同，DAV 库无法替代来源事实和操作身份判断。

### 4. 薄 Adapter 的可接受标准与 PoC 退出条件

“薄”指仅进行接口映射、错误映射、元数据映射与流转换，并不以函数数量或文件行数定义。PoC 至少应记录：

1. 对一个固定字节文件和一个中文／特殊字符目录，在 Bun 与真实 Worker 各运行同一文件视图，证实打包、属性、HEAD、完整 GET、单范围／后缀／越界／多范围行为；未支持的方法要如实拒绝。
2. 记录实际上游收到的范围和取消事件；主动注入上游忽略 Range、过期媒体 URL、截断流、读取中断，确认错误不会伪装成正常音频或“无播放权限”。
3. 同一文件读取中保持实例、快照与文件表示一致；刷新或插件更新不得在一条响应里拼接新旧字节。列表、HEAD 与后续 GET 的变化采用明确的验证器／快照规则，而非要求整个应用永远冻结。
4. 用 rclone、OpenList 和至少一个目标播放器验证列表、打开、拖动与断开；同时记录包体、启动与运行开销，避免仅以 curl 成功判断免费 Worker 可采用。

如果只需要公开接口和官方宿主桥接即可通过，采用 Nephele，并保持插件合同独立。若必须改库内部 GET/Range、长期维护 fork 或增加第二套领域缓存才能达到目标，先记录具体失败证据，比较上游修复、另一成熟库和现有依赖组合的总成本，形成新的依赖决策；**首次构建失败不自动授权切换成手写完整 DAV**。下文的“薄只读 DAV”保留为有证据后的备选，而非默认并行实现。

本补充是依赖边界和验收设计；本轮没有运行 Nephele、Bun 兼容测试、Worker 部署或客户端兼容测试。其余候选的版本和维护状态仍只代表下方 2026-10-18 的查询结果。

---

核查日期：2026-10-18。只读源码、官方文档和 npm 官方元数据；没有安装依赖、运行候选服务器、登录音乐账号或部署 Worker。本文讨论如何减少实现量，不改变音乐平台、WebUI、目录布局、音质、OpenList 和 rclone 的已定需求。

## 结论

**应优先复用，但目前没有核实到可以直接推荐为“成熟、Fetch 原生、自定义只读文件系统、Node 与 Worker 均已验证”的完整 npm 服务端。** 不应据此直接决定重写完整 WebDAV，也不能把 `webdav` 客户端当服务端。

建议先对 **Nephele + Cloudflare 官方 Node HTTP 桥接**做范围有限的验证：它有真正的自定义资源接口，而且能把字节范围交给上游读取实现。若桥接、打包或适配成本高于只读协议层，则采用 **共用的薄只读 DAV + 一个成熟 XML 依赖 + 一个 Range 解析依赖**。无需引入上传、锁、死属性数据库、NFS 服务或第二套存储系统。

`webdav-server` 可以用于普通 Node 虚拟文件系统，但其默认 Range 读取方式对远端音频不理想；不能仅因为流行就认定它能省掉本项目的流读取适配。

## 候选对照

| 候选 | 真实定位与扩展点 | Node / Worker | 适合程度 |
|---|---|---|---|
| [`webdav-server`](https://github.com/OpenMarshal/npm-WebDAV-Server) | 通用服务端；继承 `FileSystem` 实现 `_readDir`、`_type`、`_size`、`_openReadStream` 等 | Node HTTP/Stream；Worker 可研究官方桥接，尚未验证 | 目录接口可用，但默认 GET 从完整流截取 Range，音频代理需要覆盖 |
| [`nephele`](https://github.com/sciactive/nephele) | Express 服务端；自定义 `Adapter` / `Resource` / `Properties`；`getStream(range)` | 官方面向 Node/Express；Worker 桥接需 PoC | 完整库中最值得先验证；接口比本项目所需更宽 |
| [`@viren070/fsmux`](https://github.com/Viren070/fsmux) | Node WebDAV 与 NFSv4；6 个文件系统方法、可选 `openStream(file, range, signal)` | Node HTTP/Stream；没有核实 Worker 支持 | 只读形态接近，项目新、兼容覆盖有限，不能称成熟成品 |
| [`webdav`](https://github.com/perry-mitchell/webdav-client) | WebDAV **客户端**，向已有 DAV 服务发请求 | Node/浏览器客户端 | 可用于联调；不能提供我们的 DAV 服务 |
| [`tsdav`](https://github.com/natelindev/tsdav) | WebDAV/CalDAV/CardDAV **客户端** | 支持多 JS 环境的客户端 | 同上，不是服务端替代 |
| [`wedbav`](https://github.com/YieldRay/wedbav) | Hono 服务端，允许自定义 `FsSubset`，附带数据库、REST、浏览器文件界面 | README 列 Node/Deno/Bun，未核实 Worker | 比所需范围大；检查到读流接口没有 Range 参数，不优先 |
| [`@filebox/webdav-server`](https://www.npmjs.com/package/@filebox/webdav-server) | FileBox 驱动适配包；`stat/list/download` 等 | 返回自定义响应对象；源码有 Node 请求、代理和文件依赖 | `request` 名称不等于标准 Fetch handler；适配及维护收益不明 |
| [`@activefs/mount`](https://github.com/ankitparasher/activefs/tree/HEAD/packages/mount) | ActiveFS 的 Node DAV 与 rclone 生命周期工具 | Node，包入口连同进程和文件管理导入 | 与目标相似，可参考；引入 ActiveFS 核心/配置模型成本高 |

### 维护和许可

以下版本和日期来自查询当时的 npm 官方 registry，属于时间敏感事实；使用前锁定版本并再检查。

| 包 | 最新发布版本 | 发布时间 | 许可 |
|---|---|---|---|
| `webdav-server` | 2.6.3 | 2026-08-04 | Unlicense |
| `nephele` | 1.0.0-alpha.67 | 2025-11-29 | Apache-2.0 |
| `@viren070/fsmux` | 0.3.0 | 2026-09-02 | MIT |
| `webdav` | 5.11.0 | 2026-09-19 | MIT |
| `@filebox/webdav-server` | 1.0.1 | 2026-06-30 | MIT |
| `@activefs/mount` | 0.1.1 | 2026-07-28 | Apache-2.0 |

元数据：[webdav-server](https://registry.npmjs.org/webdav-server)、[nephele](https://registry.npmjs.org/nephele)、[fsmux](https://registry.npmjs.org/%40viren070%2Ffsmux)、[webdav](https://registry.npmjs.org/webdav)、[FileBox](https://registry.npmjs.org/%40filebox%2Fwebdav-server)、[ActiveFS](https://registry.npmjs.org/%40activefs%2Fmount)。版本号、最近发布和 README 的成熟度声明不能单独证明客户端兼容性；例如 Nephele 仍标 alpha，fsmux 则是新项目。

## 已经由源码确认的差异

### 1. `webdav-server` 的主要问题是远端 Range 行为

已检查 npm 2.6.3 的 `FileSystem.d.ts`、`ContextInfo.d.ts`、`commands/Get.js` 和 `webDAVServer/StartStop.js`。目录与文件元数据可以按请求动态查询，继承文件系统的工作并不需要把全部音乐内容放入内存文件树。

但默认 GET 先调用 `openReadStream`，随后把完整流接入 `RangedStream`，在本地丢弃范围前面的字节；`OpenReadStreamInfo` 公开字段没有起止偏移。对于本地磁盘不一定显著，对于云音乐代理意味着拖动到后段可能先读取大量前面的音频。要准确下推平台/CDN Range，需要覆盖 GET 或另写流路由。

因此，**它可代替 DAV 方法处理的一部分，不能直接省去本项目最重要的 Range 读取逻辑**。这比“它用了 Node API 所以不能用于 Worker”更准确。[GET 源码](https://github.com/OpenMarshal/npm-WebDAV-Server/blob/b78147971a2ab22ada903c370dda45c793429587/src/server/v2/commands/Get.ts)、[文件系统源码](https://github.com/OpenMarshal/npm-WebDAV-Server/blob/b78147971a2ab22ada903c370dda45c793429587/src/manager/v2/fileSystem/FileSystem.ts)

### 2. Nephele 可以下推范围，但不是只补三个函数

`Resource.getStream(range?: {start, end})` 明确要求返回对应范围的流，客户端提前断开时会销毁流，适合映射为平台 URL 的 Range 请求。它同时要求资源长度、ETag、MIME、名称、子项、属性、锁和修改操作的接口；只读插件可以拒绝修改，但自定义适配器仍有一些接口工作。

npm 包的入口经 Express 建立中间件，`createServer.ts` 读取自身 `package.json`。这些均需在实际 Worker 打包中处理，不能把“官方提供 Node 桥接”推导成“该包已兼容”。已有 `@nephele/plugin-read-only`，无需自己写一套写入权限拦截插件。[Resource](https://github.com/sciactive/nephele/blob/8a952bcd2613433b229b770f91ee5b7888aaff96/packages/nephele/src/Interfaces/Resource.ts)、[Adapter](https://github.com/sciactive/nephele/blob/8a952bcd2613433b229b770f91ee5b7888aaff96/packages/nephele/src/Interfaces/Adapter.ts)、[官方仓库](https://github.com/sciactive/nephele)

### 3. Worker 的 Node HTTP 兼容已提供复用路径

当前 Cloudflare 文档明确支持 `createServer`、`httpServerHandler`、`handleAsNodeRequest`。所以 Node HTTP 服务端有桥接可能；不能仅凭 `node:http`、Node Stream 或 Express 导入排除。桥接仍受 Worker 请求、流、文件和响应头语义约束，尤其要实测 `Content-Length` 和流结束行为。[官方 HTTP 兼容文档](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)

### 4. fsmux 适合参考小接口，暂不作为成熟首选

已检查 0.3.0 npm 包：`SharedFilesystem` 支持动态 `resolve/lookup/readdir/open/remove`，`openStream` 可以接收 Range 和 AbortSignal。Node `Readable` 可以由 Fetch Web Stream 转换；这保留了桥接可能。

不足也由源码直接可见：PROPFIND 忽略请求中的属性列表、总是输出固定属性；HEAD 进入 `openStream` 后销毁；根导出同时包含 NFS 模块，没有单独公开的 DAV 子路径。协议范围接近需求，但采用它仍需验证行为并可能补丁，不能把这部分计为零工作量。[官方 README 和源码](https://github.com/Viren070/fsmux/tree/main/packages/fsmux)

### 5. Fetch/Hono 应用不等于可直接安装的 DAV 库

- [`OpenList-Worker`](https://github.com/OpenListTeam/OpenList-Worker)：已读本地检出源码的 `src/backend/server/webdav.ts`、`internal/webdav/webdav.ts`。Hono 路由直接调用应用的用户、权限、目录元数据、存储操作和下载路由。可参考只读行为和编码回归用例；抽取需要换掉这些依赖。项目采用 AGPL，复制实现应按其许可处理，不能当作 MIT 小依赖。
- [`CloudPaste`](https://github.com/ling-drag0n/CloudPaste/blob/main/backend/src/webdav/index.js)：入口以 Hono 上下文调用各方法，携带用户、类型、`c.env.DB`，认证直接创建项目自己的 `WebDAVAuth`。同样属于应用代码，并非 `list/stat/open` 插槽库。本次没有展开全部方法或作许可结论。
- [`r2-webdav`](https://github.com/abersheeran/r2-webdav/blob/6ce5bfe/src/index.ts)：有标准 Request/Response 处理，方法参数直接使用 `R2Bucket`；替换成音乐内容源需要抽取协议与 R2 实现。Apache-2.0，可作协议参考，不应为了复用它新增 R2 音频存储。
- [`workers-dav`](https://github.com/NaviaX/workers-dav)：MIT，接口中已有类似读取元数据的操作，但 handler 直接创建 GoogleDrive，GET 直接调用该类的 `fetchFile`，包为 private 应用。不是现成通用库。
- [`webdav_deno`](https://github.com/nestarz/webdav_deno)：标准 Request/Response 形态，但旧实现带 Deno 文件接口，本次 GitHub 元数据没有识别到许可证，不能作为直接复制采用的推荐。

## 如果采用薄只读 DAV，手写范围应到哪里为止

只有协议到音乐文件系统之间的接线需要自己维护，不扩展为完整通用 DAV 产品：

1. `OPTIONS` 输出真实允许的方法。
2. `PROPFIND` 的 Depth 0/1、`allprop/propname/prop`、207 和每个属性的状态。路径逐段 URL 编码，XML 由依赖解析和生成。
3. `GET/HEAD` 接到统一的音频读取函数；范围解析交给依赖，上游请求必须真正带上范围，正确返回 200/206/416 与长度。
4. 不支持的写方法返回明确拒绝；无需实现锁表、上传、移动、死属性存储。
5. 既定 DAV 认证复用 Web 框架中间件，不另建用户权限框架。

适合复用的小依赖：

| 能力 | 建议 | 使用边界 |
|---|---|---|
| XML DOM、命名空间与序列化 | [`@xmldom/xmldom`](https://github.com/xmldom/xmldom)，MIT | 解析小型 PROPFIND 请求，按 `namespaceURI`/`localName` 识别 DAV 属性，序列化响应并转义；无需浏览器自带 DOM |
| XML 对象解析/生成替代选项 | [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser)，MIT | 只选一种 XML 方案即可；不要简单删除前缀后混淆不同命名空间 |
| HTTP Range 解析 | [`range-parser`](https://github.com/jshttp/range-parser)，MIT | 只解析头，不会帮忙请求平台或生成完整响应；锁定通过边界用例的版本 |

源码检查确认 xmldom 的核心导入为包内 JS 模块，提供命名空间处理；range-parser 本身没有 Node I/O。**这只是共享打包的依据，仍应通过 Worker 构建验证。** 另检查到 range-parser 1.3.0 对大于文件长度的 suffix range 存在需要核实的处理分支，不能因为成熟就省略边界用例。选择与版本要以标准范围测试为准。[xmldom registry](https://registry.npmjs.org/%40xmldom%2Fxmldom)、[range-parser registry](https://registry.npmjs.org/range-parser)

## 最小验证与采用标准

先用固定大小的 HTTP 音频样本和内存目录适配器，不需要音乐账号：

- Node 和 Worker 同一份适配器分别列目录、HEAD、读取首段/中段/末段、取消请求；核对实际上游收到的 Range，确认没有从头吞掉前段。
- 用 rclone 和 OpenList 各走一次列表、打开、拖动；中文、`&`、`#`、空格和子路径正常。
- Nephele 若只需薄适配、配置和官方桥接，则采用；若必须改很多内部逻辑，停止移植，落到薄只读 DAV。不要为了省一层 DAV 处理而增加另一台服务或第二套领域模型。

这里的“通过”均是下一步 PoC 的标准，不是本次研究已经完成的运行结果。
