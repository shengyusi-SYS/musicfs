# 管理 HTTP 接口

当前实现入口是[桌面服务装配](../src/hosts/desktop/service.ts)和[Worker 服务装配](../src/hosts/worker/service.ts)，共用 [Hono 管理路由](../src/transport/http/index.ts)、[Fetch DAV](../src/transport/dav/index.ts)与[管理页面](architecture/web-ui.md)。正式宿主、后台插件变更和桌面挂载已接线；真实云部署与目标系统挂载的状态见[台账](verification.md)。

管理请求使用 `Authorization: Bearer <管理 token>`；DAV 使用独立 Basic 读取凭据。两者由装配传入，平台私有状态不通过管理列表或 DAV 暴露。错误的认证方案由 Hono 返回 challenge，DAV 凭据不能调用任何管理操作。

| 方法与路径 | 输入与结果 |
|---|---|
| `GET /api/status` | 宿主和应用版本 |
| `GET /api/connection` | 受管理认证保护的 DAV 地址路径、用户名及读取密码；宿主未提供时返回 404 |
| `GET /api/plugins` | 安装清单、版本与 active/missing 状态 |
| `POST /api/plugins/inspect` | 正文为预构建ZIP；只读返回插件manifest/revision及当前API/宿主兼容结果，不安装或加载模块 |
| `POST /api/plugins/inspect-url` | `{url}`，按相同下载限制检查发布包，返回相同兼容预览 |
| `POST /api/plugins` | 正文为预构建ZIP；桌面首次安装/同结构更新返回201，结构升级返回202持久变更；Worker均返回202 |
| `POST /api/plugins/from-url` | `{url}`，下载有大小/超时限制的 HTTP(S) 发布包并安装 |
| `DELETE /api/plugins/:id` | 桌面完成返回 204；Worker 返回 202 持久变更操作；完成后停止该插件的新调用，保留实例与布局引用 |
| `GET /api/plugin-changes/:operationId` | 双宿主查询持久变更进度；未结束操作继续安排后台步骤，不存在返回404 |
| `GET /api/plugins/:id/configuration` | JSON Schema/UI 提示与是否声明认证，供通用界面使用 |
| `GET /api/instances` | 实例身份、名称和配置；不包含 privateState |
| `POST /api/instances` | `{pluginId,name,config}`，由插件校验后创建 |
| `PUT /api/instances/:id/config` | `{config}`，校验并条件更新，旧调用失效 |
| `DELETE /api/instances/:id` | 删除实例配置/私有状态及快照，保留其他实例 |
| `GET /api/instances/:id/authentication` | 当前公开认证 `{operationId,step,error?}`，没有操作时为 null；不返回私有状态或内部来源戳 |
| `POST /api/instances/:id/authentication` | start；poll/submit 带 operationId 与 challengeId，submit 另带 input；cancel 只带 operationId。成功返回公开结果，过期操作/挑战返回 409 |
| `GET /api/instances/:id/roots` | 完整分页后的内容源；使用当前有效快照 |
| `GET /api/instances/:id/directory-status?directoryRef=...` | 当前有效目录最近成功的 `{completedAt,statistics}`，未读取或代际已失效时为 null；只读快照，不请求来源 |
| `POST /api/instances/:id/refresh` | `{scope:"instance"}` 刷新实例内容；`{directoryRef}` 刷新指定目录；兼容 `{}` 仅刷新内容入口。返回 202 + RefreshView，替换旧活动操作 |
| `GET /api/instances/:id/refresh` | 当前/最近一次 RefreshView，无记录时为 null；只查询，不推进 |
| `GET /api/refreshes/:operationId` | 查询同一操作的公开进度，不存在返回 404；不推进 |
| `POST /api/refreshes/:operationId/step` | 至多执行一页插件读取并保存检查点，返回 200 + RefreshView；其他请求持租约时只返回已有进度 |
| `DELETE /api/refreshes/:operationId` | 先持久取消，返回 RefreshView，不存在为 404；迟到页不能覆盖取消 |
| `GET /api/layout` | `{revision,nodes}`；nodes 为 null 表示按实例默认布局 |
| `PUT /api/layout` | `{expectedRevision,nodes}`；冲突返回 409，节点合同见 library 类型 |
| `GET /api/library?path=...` | 导出视图中的有序浅目录；文件元数据在实际 stat/读取时准备 |
| `GET /api/mounts` | 正式桌面启动器装配的本机挂载状态；开发服务和 Worker 不提供 |
| `POST /api/mounts` | `{name?,mountPoint,source}`；source 为 `{kind:"local"}` 或 `{kind:"remote",url,username,password}`。结果必须查看 state，错误状态不表示挂载成功 |
| `DELETE /api/mounts/:id` | 正常卸载指定挂载；占用失败保留可操作状态 |
| `POST /api/desktop/quit` | 仅正式桌面后台，正常卸载后返回 202 `{stopping:true}`，随后结束在途读取并退出；挂载占用返回 409 并继续运行 |

`PluginInspection`包含manifest、revision和compatibility（host、apiVersion、apiCompatible、hostCompatible）。结构有效但API或宿主不兼容也返回200，以便安装前说明；坏包仍返回422。检查只读、不执行插件代码，不代表运行已通过；安装继续使用同一规则重新校验。发布地址安装会重新下载，不持有检查缓存或临时上传任务。

`PluginChange`包含 `operationId/kind/pluginId/status/createdAt/updatedAt` 和可选安装结果/错误；status为queued、preparing、uploading、deploying、verifying、migrating、completed或failed。202仅表示受理，页面持续查询到终态，重新打开插件页可用保存的operationId恢复。结构升级只有全部实例候选与安装整体切换才completed，失败保留旧安装和全部活动数据；不返回候选配置或私有状态。未结束变更返回409，Worker发布凭据缺失返回503。恢复边界见[迁移验证](verification/p2-plugin-migration.md)及[Worker指南](worker.md)。

结构错误与坏 JSON 返回 400；配置/认证语义错误返回 422 及插件字段错误。来源失败保留结构化 `sourceError`，包括需认证、限流或临时错误。配置及认证的公开结果过滤 `nextPrivateState`，管理响应统一 `Cache-Control: no-store`。认证绑定、取消/过期和恢复语义见[验证记录](verification/p1-authentication.md)。真实来源的支持范围查[台账](verification.md)，尚未交付的部署和挂载不返回伪成功。

`RefreshView` 的公开合同见 [`refreshes.ts`](../src/contracts/refreshes.ts)：包含 operationId、instanceId、scope、status、当前目录页数/暂存条目/临时计数、refreshedDirectories、failures、可选 error 和创建/更新时间；不暴露游标、租约或来源私有状态。状态为 queued、running、completed、failed、superseded、cancelled。202 仅表示受理，必须检查终态及失败明细；GET 恢复状态，POST step 推进，界面关闭不删除操作。

实例刷新先更新内容入口，再处理各入口及仍可达的已浏览子目录。新子目录首次打开时加载，不遍历已移除引用或预读全部推荐歌单。成功目录数不含入口列表，每目录完整分页后分别发布；部分目录失败仍可得到 completed，但 failures 非空，保留这些目录的旧内容。根入口失败、取消、来源变化或超出目录预算会停止操作；已经发布的目录不回滚。默认目录预算 1000，单目录默认 1000 页/100,000 条目。详见[刷新范围](verification/p1-instance-refresh.md)与[持久分页](verification/p2-durable-refresh.md)。

正式宿主的 roots、library 或 DAV 冷读取若尚无当前有效快照，会返回 `503 refresh_pending`、`Retry-After: 2` 和 `X-MusicFS-Refresh: <operationId>`。管理 JSON 还包含 operationId；重试复用同一有效活动操作，不反复替换任务。已有成功快照时直接读取它，后台刷新失败不抹空目录。共用页面可根据原操作 ID 恢复并推进；普通 DAV 客户端可以等待后台准备后重试，不获得管理权限。桌面后台持续续步；Worker 每个后台 HTTP/定时调用仅推进一页，见[Worker 指南](worker.md)。

配置声明响应可带插件的可选 `statistics` 标签映射。目录状态只返回当前来源戳下的最近成功时间与计数，不暴露来源戳、私有状态或文件引用。旧快照没有计数时 statistics 为 null；失败刷新继续保留原计数。界面更新配置、安装/移除插件及刷新后使相关查询失效；计数的每页语义见[插件合同](architecture/plugin-interface.md#稳定身份分页与目录)。

`/dav` 和 `/dav/*` 统一提供 OPTIONS、Depth 0/1 PROPFIND、GET/HEAD；单范围、条件验证器及不支持范围的行为见 [ADR 0004](adr/0004-shared-fetch-readonly-dav.md)。实际用户旅程验证见[P0 记录](verification/p0-library-dav.md)。
