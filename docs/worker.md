# Worker 构建与部署

日期：2026-10-20。状态：正式入口与后台插件变更已接线；[真实云端](verification/p4-worker-cloud.md)的WebUI/API/DAV、最小插件自行发布/更新失败保留/移除重装及D1/Secrets/ASSETS保留通过。真实示例来源和免费计划额度继续待验。架构取舍见 [ADR 0006](adr/0006-worker-code-publication.md)。

正式入口是 [`src/worker.ts`](../src/worker.ts)，由 [`createWorkerService`](../src/hosts/worker/service.ts) 接线 D1、插件注册表、来源实例、目录快照、管理 API、只读 DAV 和静态 WebUI。它与桌面使用同一业务模块和协议实现；发布器通过安装/移除用例接入管理 API，安装不在运行时执行 `eval` 或动态导入未知源码。

## 发布物结构

先构建 WebUI，再从已有插件 ZIP 组装 Worker：

```bash
bun run build:web
bun run build:worker
# 或预装可执行模块；这里只读取已经构建的 ZIP，不重新编译插件。
bun scripts/build-worker.ts dist/plugins/org.musicfs.sample.zip
```

输出位于 `dist/worker/`：

| 文件 | 职责 |
|---|---|
| `worker.mjs` | 薄入口，静态导入核心工厂和当前注册表 |
| `core.mjs` | 固定核心与正式 Fetch 工厂，不导入注册表 |
| `registry.mjs` | 当前发布物中的插件模块导入和精确修订注册表 |
| `plugins/<ZIP摘要>/…` | 预构建插件包原文件，ESM 模块独立保存 |
| `bundle.json` | 模块名、类型、相对文件路径，以及插件 manifest 和修订清单 |
| `web/` | 已构建的共用 WebUI，由 `ASSETS` 提供 |
| `migrations/` | 当前 D1 schema 迁移 |
| `wrangler.jsonc` | 普通 Worker 模块部署模板 |

`bundle.json` 的模块类型为 `esm`、`text` 或 `data`。注册表从核心导入已有的插件合同检查，并在模块初始化时验证插件导出，避免把坏模块激活为可用安装。发布用例可替换注册表并增减插件模块后上传新版本，核心模块无需重新编译；普通使用者通过 WebUI 上传 ZIP 或发布地址完成插件操作。作者构建工具仍负责预构建插件及其宿主入口。

**代码可用与安装激活是两个状态。** 注册表只声明该发布版本能执行哪些模块，绝不自动把其中所有插件激活到 D1。首次正式部署推荐空插件集，通过安装发布用例完成激活；开发探针显式插入测试安装记录。移除后已有的 `missing` 记录也不会因重启而复活。

## 首次部署

在构建物目录中使用 Cloudflare 官方 Wrangler CLI：

1. 创建 D1 数据库，将实际 database ID 填入 `wrangler.jsonc`；设置 `CF_ACCOUNT_ID`，并使 `CF_WORKER_NAME` 与模板的 `name` 相同。
2. 执行 D1 migrations。迁移必须先于新入口请求，服务不会在每次请求中自动修改 schema。
3. 配置 `ADMIN_TOKEN`、`DAV_USERNAME`、`DAV_PASSWORD` 和发布用例使用的 `CF_API_TOKEN` Secrets。
4. 部署模板；WebUI 在根路径、管理 API 在 `/api/`、DAV 在 `/dav`。

```bash
cd dist/worker
bunx wrangler d1 create musicfs
# 编辑 wrangler.jsonc 中的 D1 ID 和账号信息。
bunx wrangler d1 migrations apply musicfs --remote
bunx wrangler secret put ADMIN_TOKEN
bunx wrangler secret put DAV_USERNAME
bunx wrangler secret put DAV_PASSWORD
bunx wrangler secret put CF_API_TOKEN
bunx wrangler deploy
```

运行时配置按职责分别设置：

| 配置 | 方式 | 用途 |
|---|---|---|
| `DB` | D1 binding | 实例、布局、快照、分页刷新、插件变更及续期租约；需要包含 `0007.sql` 的全部迁移 |
| `ASSETS` | 静态资源 binding | 根页面和 `/assets/*`，与管理 API/DAV 共用一个 Worker |
| `CF_ACCOUNT_ID`、`CF_WORKER_NAME` | 模板 vars | 定位当前部署；Worker 名称必须与实际目标一致 |
| `CF_API_TOKEN` | Secret | 后台读取当前代码集合、发布替换代码；仅宿主使用 |
| `ADMIN_TOKEN` | Secret | 用户访问受保护管理 API，WebUI 使用用户输入的该令牌 |
| `DAV_USERNAME`、`DAV_PASSWORD` | Secrets | DAV 读取凭据；受保护的连接信息 API 会向管理用户提供连接信息 |

发布 Token 需要有权读取目标 Worker 的当前模块及写入代码。官方 Content API 列出接受的写权限，账号与资源范围应按真实部署校验。[Cloudflare Content API 权限与合同](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/update/)

插件变更只发送代码模块和主模块名，使用不修改配置的Content API。真实云端sample生命周期已直接对比平台设置，并通过后续发布/管理/DAV及静态JS摘要验证D1、Secrets、ASSETS和设置保留；其他在途切换及失败恢复范围仍见[限定证据](verification/p4-worker-cloud.md)。发布Token不下发WebUI，也不写入插件包或模块源码。

模板开启 `nodejs_compat` 供控制面依赖使用；QQ 预构建插件已有独立的无此开关探测。这一开关既不是插件公共合同，也不证明免费计划的 CPU、包体或请求额度足够。

## 目录准备与跨请求续步

目录刷新使用[持久分页接口](management-api.md)。一次 POST step 最多执行一页插件读取，D1 保存暂存条目和下一游标，末页后才切换完整快照。操作 ID 可跨页面重载、Worker isolate 重建和进程重启恢复；GET 只查询。已有成功目录在刷新期间继续可读，冷读取返回带 Retry-After 的 503，由页面或客户端重试。

开始刷新及冷读取响应可以经 `waitUntil` 安排一页；它不会在同一次调用中循环。WebUI后续逐次POST step；模板另配置每分钟Cron，scheduled优先推进一次插件变更，否则推进一页目录刷新，供页面关闭后的慢速续跑。Cron不保证精确完成时间，大集合应在页面中推进；平台配置保留的真实验收也应覆盖此触发器。

单页预算与完整集合预算仍需分开测量。分页化不证明加密CPU、插件内部请求、CDN出口或逐文件DAV元数据满足免费额度；付费账号的首次部署现已成功，后续按必要的有限链路推进，不扩展压测或对照矩阵。云端分页和免费额度仍待验。设计与已测边界见 [ADR 0007](adr/0007-durable-paged-refresh.md)和[分页记录](verification/p2-durable-refresh.md)。

读取侧已有[本地CPU定位与重复工作减法](verification/p2-read-cpu.md)：属性投影、命名快返、快照头只返回一次，以及可选的正式workerd V8 profile入口。逐文件ETag和整份XML仍有成本；这不等于真实免费Worker的CPU已通过，也不增加额外定时器或存储服务。

## 按需会话续期

来源会话续期使用独立的按需入口：插件本地判断必要性，D1短租约协调同一实例并发调用并保存结果。普通目录/音频读取在续期完成后继续，不由Cron定时登录。QQ的下一检查时间留在插件私有状态；网易云二维码Cookie不支持SDK的login/refresh，不新增无效定时调用。详见[会话记录](verification/p2-session-lifecycle.md)。

## 在后台安装与移除插件

WebUI 上传已构建 ZIP 或填写发布地址后，Worker 把变更及候选模块暂存在 D1，再通过 `waitUntil` 执行发布与核对。普通使用者无需重新编译核心或手工操作 Wrangler。首次搭建宿主、发布核心新版本及数据库迁移仍属于部署工作。

| 管理请求 | Worker 返回 | 含义 |
|---|---|---|
| `POST /api/plugins`，正文为 ZIP | `202` + `PluginChange` | 已接收安装/更新变更 |
| `POST /api/plugins/from-url`，JSON `{ "url": "…" }` | `202` + `PluginChange` | 下载并校验包后接收变更 |
| `DELETE /api/plugins/:id` | `202` + `PluginChange` | 已接收移除变更 |
| `GET /api/plugin-changes/:operationId` | `200` + `PluginChange` | 查询持久进度；未结束的操作会继续安排核对 |

`202` 表示操作已受理，完成以 `status: "completed"` 为准；`failed` 带有可显示的错误码与说明。返回的 `operationId` 用于后续查询，控制器重建后也能读取同一记录。管理请求仍使用 Bearer 认证；未配置发布账号/Token 的安装和移除返回 `503 host_not_configured`，其他读取、页面和 DAV 可继续使用。另有变更尚未结束时返回 `409 change_in_progress`，不存在的操作返回 `404`。

安装过程先读取平台当前模块，保留固定核心和仍在使用的修订，生成带操作身份的候选 `registry.mjs`。平台模块初始化时会调用核心已有的 `assertPluginModule`；随后发布器重新读取实际注册表，与 D1 中保存的候选内容核对，匹配后才条件激活插件安装。加载代码不会自动激活安装，数据库确认也不能由一次上传响应替代。

结构升级先冻结全部实例输入，核对代码后由含精确候选模块的新调用接棒。每次最多转换/验证一个实例，全部就绪后另一步在同一D1 batch中切换安装、所有实例及completed。阶段可见 `preparing` / `migrating`；任一转换失败或实例在准备期间变化均保留旧安装和全部活动数据。没有界面时Cron继续原操作；临时进度不是部分实例已生效。见[合同](architecture/plugin-interface.md#配置与私有状态迁移)及[本地证据](verification/p2-plugin-migration.md)。

上传已被平台接受但响应丢失时，操作保留为 `verifying`，下一次查询安排重新读取注册表；内容已匹配即可完成 D1 激活，**不会盲目再上传一次**。明确的 4xx 拒绝（408 除外）立即标记失败。结果仍不明确且自尝试已超过两分钟时，后续核对执行会将操作标记为 `deployment_unconfirmed`；这是查询触发的恢复边界，不是一个保证准时触发的独立定时器。

移除完成后安装标记为 `missing`，实例配置、状态及布局引用继续保留。候选代码在 D1 确认前保留旧的 active 修订；之后的变更会清理不再被当前安装使用的模块。代码发布和 D1 更新之间没有跨系统事务，真实切换对正在播放流的影响仍需云端验证。

## 本地正式入口验证

在已有 sample ZIP 和 WebUI 构建物后执行：

```bash
bun run probe:worker:service
bun test tests/worker-publishing.test.ts
```

探针将正式入口与独立注册表交给本地 workerd，覆盖空安装列表、共用管理 API、ASSETS 页面、显式测试激活后的实例创建、PROPFIND、HEAD、精确范围字节和 D1 重启保留；并验证未配置发布凭据时安装/移除返回可诊断的 503，其他读取仍可用，坏插件导出在初始化时被拒绝。它不会自动构建或改变 QQ/sample 插件版本，也不会部署云端 Worker。本地成功不替代真实账号、Cloudflare 部署及免费额度验证。

验证材料需要分开理解：

| 证据 | 已覆盖 | 尚未证明 |
|---|---|---|
| [正式入口探针](../scripts/probe-worker-service.ts) | 实际产品 core/薄入口/注册表在本地 workerd 的接线、页面、D1 与 DAV | Cloudflare 控制面接受实际上传及真实流量行为 |
| [6项发布集成测试](../tests/worker-publishing.test.ts) | 真实Miniflare D1 +官方SDK，仅平台Fetch受控；multipart、安装/移除、响应丢失、精确新调用迁移/原子激活、失败保留及暂存中断 | 真平台配置保留、权限、传播时序与资源额度 |
| 真实云端验收 | 当前尚无 | 普通 Worker 免费计划可用范围、Secrets/D1/ASSETS 保留、更新/失败恢复、在途播放影响及真实来源兼容 |
