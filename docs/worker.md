# Worker 构建与部署

日期：2026-10-21。状态：[真实云端](verification/p4-worker-cloud.md)的WebUI/API/DAV、后台插件生命周期、绑定保留、核心升级、双示例有限内容/音质、代表客户端、一次切换观察及退出后重新扫码已有证据。现有部署已升级 API 0.1.6、schema 8 与带元数据的两示例版本，见[本次升级](verification/p4-worker-cloud.md#音乐资料功能原地升级)。本次开发预览按用户决定跳过QQ真实续期、免费计划和大目录资源验证，保留未验证状态。架构取舍见[ADR 0006](adr/0006-worker-code-publication.md)。本页也随Worker包保存为`WORKER.md`；代码/验收等相对链接对应项目源码包中的文档位置。

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
| `README.md` / `WORKER.md` | 共用使用说明 / 本页部署与升级操作 |

`bundle.json` 的模块类型为 `esm`、`text` 或 `data`。注册表从核心导入已有的插件合同检查，并在模块初始化时验证插件导出，避免把坏模块激活为可用安装。发布用例可替换注册表并增减插件模块后上传新版本，核心模块无需重新编译；普通使用者通过 WebUI 上传 ZIP 或发布地址完成插件操作。作者构建工具仍负责预构建插件及其宿主入口。

**代码可用与安装激活是两个状态。** 注册表只声明该发布版本能执行哪些模块，绝不自动把其中所有插件激活到 D1。首次正式部署推荐空插件集，通过安装发布用例完成激活；开发探针显式插入测试安装记录。移除后已有的 `missing` 记录也不会因重启而复活。

## 首次部署

在构建物目录中使用 Cloudflare 官方 Wrangler CLI：

1. 创建 D1 数据库，将实际 database ID 填入 `wrangler.jsonc`；设置 `CF_ACCOUNT_ID`，并使 `CF_WORKER_NAME` 与模板的 `name` 相同。
2. 执行 D1 migrations。迁移必须先于新入口请求，服务不会在每次请求中自动修改 schema。
3. 在本机准备一个私有JSON文件，包含`ADMIN_TOKEN`、`DAV_USERNAME`、`DAV_PASSWORD`和`CF_API_TOKEN`四项，文件放在发行目录之外。CF_API_TOKEN用于云端自行发布插件，只需首次配置；Wrangler登录用于本机部署，不会自动成为Worker的运行凭据。
4. 用`--secrets-file`一次设置这些Secrets并部署，无需逐项secret put或多次发布。WebUI在根路径、管理API在`/api/`、DAV在`/dav`。

```bash
cd dist/worker
bunx wrangler d1 create musicfs
# 编辑 wrangler.jsonc 中的 D1 ID 和账号信息。
bunx wrangler d1 migrations apply musicfs --remote
# 本机私有JSON文件的键为上述四项，值使用自己的凭据。
bunx wrangler deploy --secrets-file /absolute/path/to/musicfs-secrets.json
```

运行时配置按职责分别设置：

| 配置 | 方式 | 用途 |
|---|---|---|
| `DB` | D1 binding | 实例、布局、快照、后台操作、管理认证及自定义 DAV 凭据；需要按顺序应用至 `0012.sql` 的全部迁移 |
| `ASSETS` | 静态资源 binding | 根页面和 `/assets/*`，与管理 API/DAV 共用一个 Worker |
| `CF_ACCOUNT_ID`、`CF_WORKER_NAME` | 模板 vars | 定位当前部署；Worker 名称必须与实际目标一致 |
| `CF_API_TOKEN` | Secret | 后台读取当前代码集合、发布替换代码；仅宿主使用 |
| `ADMIN_TOKEN` | Secret | 用户访问受保护管理 API，WebUI 使用用户输入的该令牌 |
| `DAV_USERNAME`、`DAV_PASSWORD` | Secrets | 初始 DAV 读取凭据；管理页保存自定义账号密码后，以 D1 中的设置为准 |

发布Token需要有权读取目标Worker的当前模块及写入代码，可使用目标账号的Workers Scripts Edit权限；不是每次安装插件都重新申请。此配置方式已由本轮真实部署和后台发布验证。官方Content API列出接受的写权限。[Cloudflare Content API 权限与合同](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/update/)

插件变更只发送代码模块和主模块名，使用不修改配置的Content API。真实云端已验证D1、Secrets、ASSETS与设置保留；一次实际切换中页面保持200，更新来源的合成音频两次503/Retry-After:2后恢复200，详见[限定证据](verification/p4-worker-cloud.md)。发布Token不下发WebUI，也不写入插件包或模块源码。

模板开启 `nodejs_compat` 供控制面依赖及当前示例选用的标签库使用；当前 QQ alpha.11、网易云 alpha.9 的构建包采用这一环境。此前旧 QQ 包不使用此开关的实验不代表新包。该开关不是插件公共合同，也不证明免费计划的 CPU、包体或请求额度足够。

## 升级核心与 WebUI，保留云端插件

已有 Worker 通过后台安装过插件后，云端注册表与最初的本机构建物可能不同。不要直接把重新构建的空插件发布物部署到原 Worker，也不要用本地同名 ZIP 近似替换云端的精确修订。

组装工具位于同版本项目源码包。先按其中`SOURCE.md`/开发说明准备锁定依赖，再从项目根目录执行以下命令；不是在仅含模块的Worker解压目录执行。先等待已有插件安装、更新或移除操作结束，从组装到部署完成期间停止并行插件变更。构建新页面后，使用现有目标的`wrangler.jsonc`和一个独立输出目录：

```bash
bun run build:web
# CF_API_TOKEN 或 CLOUDFLARE_API_TOKEN 使用已有发布 Token，通过环境提供，不写入配置或命令参数。
bun scripts/build-worker-upgrade.ts \
  --config /absolute/path/to/existing/wrangler.jsonc \
  --out /absolute/path/to/musicfs-upgrade
bunx wrangler@4.119.0 deploy \
  --config /absolute/path/to/musicfs-upgrade/wrangler.jsonc \
  --keep-vars --autoconfig=false
```

组装工具仅支持本项目的 `worker.mjs`、`core.mjs`、`registry.mjs` 和 `plugins/<修订>/…` 模块布局。它调用官方 SDK 读取一次当前云端模块，构建新入口、核心和已准备的 WebUI，原样保留注册表及其余模块的名称、类型和字节；它不执行插件，也不自行部署或迁移数据库。模块类型沿用本项目构建/发布的命名规则：`js`/`mjs` 为 ESM，`json`/`txt`/`md` 为文本，其余为二进制；不提供任意 Worker 的克隆能力。`bundle.json` 和发布身份列出保留的全部插件 manifest 与修订，包括平台注册表中仍保留的旧修订；这份代码清单不代表 D1 中全部处于激活状态。

输出配置保留输入中的实际 Worker、D1、其他绑定、变量、兼容设置、触发器、限额及观测设置，ASSETS 改为新目录的 `web/`，模块规则由真实 `esm`、`text`、`data` 清单生成。升级目录必须与输入配置目录分离。若新版本有 D1 迁移，仍由操作者在部署前按首次部署说明对原数据库执行；没有新增迁移的版本无需重复执行。

Wrangler 负责上传静态资源并部署组合后的模块。显式 `--keep-vars` 保留现有变量与 Secrets，无需再次提供私有 Secrets 文件；固定 Wrangler 4.119.0 的普通 `deploy` 路径在设置此参数后保留 `plain_text`、`json`、`secret_text` 和 `secret_key`。实例、授权及布局仍位于原 D1，升级工具不会修改它们。部署后核对新页面、插件精确修订与已有实例/布局，并用一个已缓存 DAV 文件检查读取即可，无需重新扫码或刷新平台目录。

## 目录准备与跨请求续步

目录刷新使用[持久分页接口](management-api.md)。一次 POST step 最多执行一页插件读取，D1 保存暂存条目和下一游标，末页后才切换完整快照。操作 ID 可跨页面重载、Worker isolate 重建和进程重启恢复；GET 只查询。已有成功目录在刷新期间继续可读，冷读取返回带 Retry-After 的 503，由页面或客户端重试。

开始刷新及冷读取响应可以经`waitUntil`安排一页；它不会在同一次调用中循环。WebUI后续逐次POST step；模板默认每分钟Cron，scheduled优先推进一次插件变更，否则推进一页目录刷新，供页面关闭后的慢速续跑。Cron不保证精确完成时间，大集合应在页面中推进。无需关页续跑时可把`triggers.crons`设为`[]`，已安排的一页结束后由重新打开的页面继续原操作。当前付费云端验收使用关闭Cron的配置，核心升级保留其原设置。

单页预算与完整集合预算仍需分开测量。分页化不证明加密CPU、插件内部请求、CDN出口或逐文件DAV元数据满足免费额度；付费账号的部署及双示例有限每日集合已成功，不扩展压测或对照矩阵。真实云端大集合跨页及免费额度仍待验。设计与已测边界见 [ADR 0007](adr/0007-durable-paged-refresh.md)和[分页记录](verification/p2-durable-refresh.md)。

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

结构升级先冻结全部实例输入，核对代码后由含精确候选模块的新调用接棒。每次最多转换/验证一个实例，全部就绪后另一步在同一D1 batch中切换安装、所有实例及completed。阶段可见`preparing`/`migrating`；任一转换失败或实例在准备期间变化均保留旧安装和全部活动数据。启用Cron时可在关页后继续，关闭时重新打开页面继续原操作；临时进度不是部分实例已生效。见[合同](architecture/plugin-interface.md#配置与私有状态迁移)及[本地证据](verification/p2-plugin-migration.md)。

上传已被平台接受但响应丢失时，操作保留为 `verifying`，下一次查询安排重新读取注册表；内容已匹配即可完成 D1 激活，**不会盲目再上传一次**。明确的 4xx 拒绝（408 除外）立即标记失败。结果仍不明确且自尝试已超过两分钟时，后续核对执行会将操作标记为 `deployment_unconfirmed`；这是查询触发的恢复边界，不是一个保证准时触发的独立定时器。

移除完成后安装标记为`missing`，实例配置、状态及布局引用继续保留。候选代码在D1确认前保留旧的active修订；历史模块物理回收不作为移除功能的门禁。代码发布和D1更新之间没有跨系统事务；已有代表性切换观察不保证任意在途播放流均不中断。

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
| [真实云端验收](verification/p4-worker-cloud.md) | 付费账号单Worker/D1；发布/失败保留/移除重装、绑定保留、核心升级、双示例内容/音质、代表音频/客户端、实际切换观察及退出重登 | 免费/大目录资源、QQ真实续期及其他OS，本次跳过；响应丢失恢复沿用正式D1+SDK证据 |
