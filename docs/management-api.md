# 管理 HTTP 接口

当前实现入口是[桌面服务装配](../src/hosts/desktop/service.ts)和[Worker 服务装配](../src/hosts/worker/service.ts)，共用 [Hono 管理路由](../src/transport/http/index.ts)、[Fetch DAV](../src/transport/dav/index.ts)与[管理页面](architecture/web-ui.md)。正式宿主、后台插件变更和桌面挂载已接线；真实云部署与目标系统挂载的状态见[台账](verification.md)。

浏览器管理请求使用 HttpOnly 会话 Cookie；脚本继续使用 `Authorization: Bearer <管理 token>`。通用与桌面管理路由复用同一认证中间件；DAV 使用独立 Basic 读取凭据。管理登录、播放器读取和来源插件授权各有职责，见[管理访问架构](architecture/management-access.md)。

| 方法与路径 | 输入与结果 |
|---|---|
| `GET /api/access` | 当前 `authenticated/passwordConfigured/username?`；未登录也可查询可用入口 |
| `POST /api/access/login` | `{username,password,rememberMe}`，账号密码换取管理会话 |
| `POST /api/access/bootstrap` | `{token}`，部署/本机管理凭据换取浏览器会话 |
| `PUT /api/access/account` | 已认证后设置 `{username,password}`；首次设置不影响已有设备，改密码撤销旧会话并重签当前 |
| `POST /api/access/ticket` | 已认证后签发 `{ticket,expiresAt}`，一次使用、3 分钟有效 |
| `POST /api/access/exchange` | `{ticket}` 换取新的独立浏览器会话 |
| `POST /api/access/logout` | 删除当前服务端会话及 Cookie |
| `GET /api/status` | 宿主和应用版本 |
| `GET /api/connection` | 受管理认证保护的 DAV 地址路径、用户名及读取密码；宿主未提供时返回 404 |
| `GET /api/plugins` | 安装清单、版本与 active/missing 状态 |
| `POST /api/plugins/inspect` | 正文为预构建ZIP；只读返回插件manifest/revision及当前API/宿主兼容结果，不安装或加载模块 |
| `POST /api/plugins/inspect-url` | `{url}`，按相同下载限制检查发布包，返回相同兼容预览 |
| `POST /api/plugins` | 正文为预构建ZIP；桌面首次安装/同结构更新返回201，结构升级返回202持久变更；Worker均返回202 |
| `POST /api/plugins/from-url` | `{url}`，下载有大小/超时限制的 HTTP(S) 发布包并安装 |
| `DELETE /api/plugins/:id` | 桌面完成返回 204；Worker 返回 202 持久变更操作；完成后停止该插件的新调用，保留实例与布局引用 |
| `GET /api/plugin-changes/:operationId` | 双宿主查询持久变更进度；未结束操作继续安排后台步骤，不存在返回404 |
| `GET /api/plugins/:id/configuration` | JSON Schema/UI 提示、认证及`metadataRefresh`能力，供通用界面使用 |
| `GET /api/instances` | 实例身份、名称和配置；不包含 privateState |
| `POST /api/instances` | `{pluginId,name,config}`，由插件校验后创建 |
| `PUT /api/instances/:id/config` | `{config}`，校验并条件更新；插件声明的纯保留策略变化保留内容代际，其余变化使旧内容失效 |
| `DELETE /api/instances/:id` | 删除实例配置/私有状态及快照，保留其他实例 |
| `DELETE /api/instances/:id/session` | 退出该实例授权，保留配置/布局并使旧调用失效；返回204 |
| `GET /api/instances/:id/authentication` | 当前公开认证 `{operationId,step,error?}`，没有操作时为 null；不返回私有状态或内部来源戳 |
| `POST /api/instances/:id/authentication` | start；poll/submit 带 operationId 与 challengeId，submit 另带 input；cancel 只带 operationId。成功返回公开结果，过期操作/挑战返回 409 |
| `GET /api/instances/:id/roots` | 完整分页后的内容源；使用当前有效快照 |
| `GET /api/instances/:id/directory?directoryRef=...` | 按来源引用浏览 `{entries,status}`；省略引用列出入口，目录项带 `directoryRef`，文件项只有名称与修改时间。共用快照与命名投影，不依赖导出布局，不读取音频属性 |
| `GET /api/instances/:id/directory-status?directoryRef=...` | 当前有效目录最近成功的 `{completedAt,statistics,error}`；error为最近失败代码或null，未读取或代际已失效时为null；只读快照，不请求来源 |
| `GET /api/library/directory?path=...` | 已发布路径的 `{entries,status}`，status为同一目录的DirectoryStatus，虚拟分组/实例容器为null；供目录浏览器显示保留的旧内容，不暴露来源引用 |
| `POST /api/instances/:id/refresh` | `{scope:"instance"}` 刷新实例；`{directoryRef}` 刷新指定目录；`{scope:"file-info",directoryRef}` 准备文件属性；`{scope:"metadata",directoryRef}` 显式重新取得当前目录的音乐资料（须插件声明支持）；兼容 `{}` 仅刷新内容入口。返回202 + RefreshView，替换旧活动操作 |
| `GET /api/instances/:id/refresh-policy?directoryRef=...` | 指定目录的周期策略；省略directoryRef为实例内容入口 |
| `PUT /api/instances/:id/refresh-policy?directoryRef=...` | `{intervalMinutes}`：0为手动，否则至少15分钟；只安排到期任务，复用原刷新/旧快照 |
| `GET /api/update-rules`、`POST /api/update-rules` | 查询规则或保存`{instanceId,target,timing,enabled,label?}`；target和timing见[合同](../src/contracts/refresh-policy.ts) |
| `PUT /api/update-rules/:id`、`DELETE /api/update-rules/:id` | 编辑/暂停或移除规则；同一实例和范围共用一条规则 |
| `POST /api/update-rules/:id/run` | 立即将此范围交给原持久刷新；返回202，已有覆盖工作可复用，无关活动工作返回409 |
| `GET /api/instances/:id/file-naming?directoryRef=...` | 查询当前设置、修订、有效策略、继承状态及可用字段；省略目录为实例默认 |
| `PUT /api/instances/:id/file-naming?directoryRef=...` | `{revision,policy}`；null恢复继承/实例原名，相同设置不写入，旧修订返回409 |
| `POST /api/instances/:id/file-naming/preview?directoryRef=...` | `{policy}`；只使用已发布目录，省略目录时抽取一个继承实例设置的已加载文件目录；数量仅对应预览目录 |
| `GET /api/instances/:id/refresh` | 当前/最近一次 RefreshView，无记录时为 null；只查询，不推进 |
| `GET /api/refreshes/:operationId` | 查询同一操作的公开进度，不存在返回 404；不推进 |
| `POST /api/refreshes/:operationId/step` | 至多执行一页插件读取并保存检查点，返回 200 + RefreshView；其他请求持租约时只返回已有进度 |
| `DELETE /api/refreshes/:operationId` | 先持久取消，返回 RefreshView，不存在为 404；迟到页不能覆盖取消 |
| `GET /api/layout` | `{revision,nodes}`；nodes 为 null 表示按实例默认布局 |
| `GET /api/layout/default` | 当前自动布局的 `LayoutNode[]` 编辑副本；沿用导出路径名称，只读取来源入口，不保存布局 |
| `PUT /api/layout` | `{expectedRevision,nodes}`；冲突返回 409，节点合同见 library 类型 |
| `GET /api/library?path=...` | 导出视图中的有序浅目录；文件元数据在实际 stat/读取时准备 |
| `GET /api/mounts` | 正式桌面启动器装配的本机挂载状态；开发服务和 Worker 不提供 |
| `POST /api/mounts` | `{name?,mountPoint,source,autoMount?,directoryCacheSeconds?,fileCacheMaxMiB?,fileCacheMaxAgeHours?}`；source 为本机或带url/username/password的远程输入，autoMount默认true。须查看结果state，错误状态不表示挂载成功 |
| `POST /api/mounts/:id/mount` | 按保存的私有输入重新挂载，返回MountView |
| `POST /api/mounts/:id/unmount` | 正常卸载，保留定义与已读片段，返回MountView |
| `DELETE /api/mounts/:id` | 正常卸载后移除定义及其缓存命名空间；占用失败保留可操作状态，成功204 |
| `PUT /api/mounts/:id/name` | `{name}`，保存管理名称与原生卷标，已挂载时正常重挂；忙时保留旧名称与挂载 |
| `PUT /api/mounts/:id/auto-mount` | `{enabled}`，只修改下次启动的恢复设置，不立即重挂或卸载 |
| `GET /api/mounts/:id/cache` | 实际VFS模式、原生路径、文件数/占用及采样时间；统计可滞后，未运行不启动原生进程 |
| `PUT /api/mounts/:id/cache` | `{directoryCacheSeconds,fileCacheMaxMiB?,fileCacheMaxAgeHours?}`，保存并正常重挂；占用失败保留旧设置 |
| `POST /api/mounts/:id/cache/refresh` | 仅失效该挂载的目录清单，204；不刷新平台或删除音频片段 |
| `DELETE /api/mounts/:id/cache` | 正常卸载、清除所选挂载片段及索引、按原设置重挂；失败不清理 |
| `GET /api/desktop/read-cache` | 直接DAV共享缓存的settings、actualMode、state、路径、原生采样与说明 |
| `PUT /api/desktop/read-cache` | `{maxMiB,maxAgeHours}`，共享读取空闲时保存；容量0关闭新缓存，期限0关闭时间淘汰，保留旧片段 |
| `DELETE /api/desktop/read-cache` | 空闲时停止所属共享VFS并清理其片段/索引，返回状态；下次读取懒启动，不影响标签计划或挂载缓存 |
| `GET /api/desktop/network` | 期望配置、实际管理/WebDAV 端口及各自的 `managementUrls/davUrls`；桌面播放器使用 `davUrls`，不将相对 `davPath` 拼接到管理端口 |
| `PATCH /api/desktop/network`、`PUT /api/desktop/network` | 保存 `managementAccess/managementPort/davAccess/davPort`；PATCH仅修改提交字段，PUT保存全部字段。独立切换监听并保留在途响应，返回实际生效地址 |
| `GET /api/desktop/preferences`、`PUT /api/desktop/preferences` | 查询或保存`launchAtLogin/openOnLaunch/openOnLogin/autoMount/retryAutoMount`，另返回系统集成状态 |
| `GET /api/desktop/mount-prerequisites` | 检测本机挂载组件及安装状态 |
| `POST /api/desktop/mount-prerequisites/install` | Windows运行随包WinFsp安装器并核对结果，必要时请求系统权限 |
| `GET /api/desktop/https` | 本机HTTPS与Windows连接设置状态 |
| `POST /api/desktop/https/enable` | 启用专用回环HTTPS DAV，保留证书和端口供重启复用 |
| `POST /api/desktop/https/trust` | 按需应用Windows信任、WebClient及原生文件上限；保存原值，必要时提权/重连 |
| `DELETE /api/desktop/https/file-size-limit` | 显式恢复本App改动前的文件上限；保留HTTPS与来源授权 |
| `DELETE /api/desktop/https` | 停用本机HTTPS，不自动恢复全局文件上限 |
| `POST /api/desktop/quit` | 退出准备拒绝新增直接读取，正常卸载后返回202 `{stopping:true}`，随后关服务与后台；占用返回409并恢复可操作状态 |

挂载与桌面路由仅在相应正式桌面能力装配后提供，Worker不提供。缓存查询只取原生状态，不启动未用服务；配置容量不等于实际占用。0的含义随字段而异：目录期限0为手动失效、文件容量0为关闭新缓存、文件期限0为不按时间淘汰。默认值与所有权见[缓存策略](architecture/cache-policy.md)，JSON类型以[mounts](../src/contracts/mounts.ts)、[read-cache](../src/contracts/read-cache.ts)及[desktop](../src/contracts/desktop.ts)为准。

新建更新规则或修改其范围时，若目标已有另一条规则，返回409 `{error:"update_rule_exists",message,ruleId}`；两条原规则均保留。它是可直接编辑已有规则的业务结果，与来源代际变化或设置修订冲突分别处理。

`PluginInspection`包含manifest、revision和compatibility（host、apiVersion、apiCompatible、hostCompatible）。结构有效但API或宿主不兼容也返回200，以便安装前说明；坏包仍返回422。检查只读、不执行插件代码，不代表运行已通过；安装继续使用同一规则重新校验。发布地址安装会重新下载，不持有检查缓存或临时上传任务。

`PluginChange`包含 `operationId/kind/pluginId/status/createdAt/updatedAt` 和可选安装结果/错误；status为queued、preparing、uploading、deploying、verifying、migrating、completed或failed。202仅表示受理，页面持续查询到终态，重新打开插件页可用保存的operationId恢复。结构升级只有全部实例候选与安装整体切换才completed，失败保留旧安装和全部活动数据；不返回候选配置或私有状态。未结束变更返回409，Worker发布凭据缺失返回503。恢复边界见[迁移验证](verification/p2-plugin-migration.md)及[Worker指南](worker.md)。

结构错误与坏 JSON 返回 400；配置/认证语义错误返回 422 及插件字段错误。来源失败保留结构化 `sourceError`，包括需认证、限流或临时错误。配置及认证的公开结果过滤 `nextPrivateState`，管理响应统一 `Cache-Control: no-store`。认证绑定、取消/过期和恢复语义见[验证记录](verification/p1-authentication.md)。真实来源的支持范围查[台账](verification.md)，尚未交付的部署和挂载不返回伪成功。

`RefreshView` 的公开合同见 [`refreshes.ts`](../src/contracts/refreshes.ts)：包含 operationId、instanceId、scope、status、当前目录页数/暂存条目/临时计数、refreshedDirectories、failures、可选 error 和创建/更新时间；不暴露游标、租约或来源私有状态。状态为 queued、running、completed、failed、superseded、cancelled。202 仅表示受理，必须检查终态及失败明细；GET 恢复状态，POST step 推进，界面关闭不删除操作。

实例刷新先更新内容入口，再处理全部可达子目录，包括新发现的目录；递归目录范围同样包含未访问后代。普通目录及旧入口请求保持浅层，日常浏览仍按需加载。成功目录数不含入口列表，每目录完整分页后分别发布；部分目录失败仍可得到 completed，但 failures 非空，保留这些目录的旧内容。根入口失败、取消、来源变化或超出目录预算会停止操作；已经发布的目录不回滚。默认目录预算 1000，单目录默认 1000 页/100,000 条目。范围、调度及展示策略见[现行设计](architecture/updates-and-naming.md)，原分页提交见[持久分页](verification/p2-durable-refresh.md)。

正式宿主的 roots、library 或 DAV 冷读取若尚无当前有效快照，会返回 `503 refresh_pending`、`Retry-After: 2` 和 `X-MusicFS-Refresh: <operationId>`。管理 JSON 还包含 operationId；重试复用同一有效活动操作，不反复替换任务。已有成功快照时直接读取它，后台刷新失败不抹空目录。共用页面可根据原操作 ID 恢复并推进；普通 DAV 客户端可以等待后台准备后重试，不获得管理权限。桌面后台持续续步；Worker 每个后台 HTTP/定时调用仅推进一页，见[Worker 指南](worker.md)。

配置声明响应可带插件的可选 `statistics` 标签映射。目录状态返回当前来源戳下的最近成功时间、计数与该目录最近失败代码，不暴露来源戳、私有状态或文件引用。旧快照没有计数时statistics为null；失败刷新保留原内容与计数，并持续显示失败标记，直到该目录成功刷新。其他目录成功或重开页面不清除此标记。界面更新配置、安装/移除插件及刷新后使相关查询失效；计数的每页语义见[插件合同](architecture/plugin-interface.md#稳定身份分页与目录)。

`/dav` 和 `/dav/*` 统一提供 OPTIONS、Depth 0/1 PROPFIND、GET/HEAD；单范围、条件验证器及不支持范围的行为见 [ADR 0004](adr/0004-shared-fetch-readonly-dav.md)。实际用户旅程验证见[P0 记录](verification/p0-library-dav.md)。
