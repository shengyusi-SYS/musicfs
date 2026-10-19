# 管理 HTTP 接口

当前实现入口是[桌面服务装配](../src/hosts/desktop/service.ts)，共用 [Hono 管理路由](../src/transport/http/index.ts)和 [Fetch DAV](../src/transport/dav/index.ts)，已连接[共用管理页面](architecture/web-ui.md)。通用认证及 QQ 真实扫码已有实现；可点击启动器、完整示例来源、挂载与 Worker 自动发布尚未交付。

管理请求使用 `Authorization: Bearer <管理 token>`；DAV 使用独立 Basic 读取凭据。两者由装配传入，平台私有状态不通过管理列表或 DAV 暴露。错误的认证方案由 Hono 返回 challenge，DAV 凭据不能调用任何管理操作。

| 方法与路径 | 输入与结果 |
|---|---|
| `GET /api/status` | 宿主和应用版本 |
| `GET /api/connection` | 受管理认证保护的 DAV 地址路径、用户名及读取密码；宿主未提供时返回 404 |
| `GET /api/plugins` | 安装清单、版本与 active/missing 状态 |
| `POST /api/plugins` | 请求正文为预构建 ZIP，成功返回安装记录 |
| `POST /api/plugins/from-url` | `{url}`，下载有大小/超时限制的 HTTP(S) 发布包并安装 |
| `DELETE /api/plugins/:id` | 停止该插件的新调用，保留实例与布局引用 |
| `GET /api/plugins/:id/configuration` | JSON Schema/UI 提示与是否声明认证，供通用界面使用 |
| `GET /api/instances` | 实例身份、名称和配置；不包含 privateState |
| `POST /api/instances` | `{pluginId,name,config}`，由插件校验后创建 |
| `PUT /api/instances/:id/config` | `{config}`，校验并条件更新，旧调用失效 |
| `DELETE /api/instances/:id` | 删除实例配置/私有状态及快照，保留其他实例 |
| `GET /api/instances/:id/authentication` | 当前公开认证 `{operationId,step,error?}`，没有操作时为 null；不返回私有状态或内部来源戳 |
| `POST /api/instances/:id/authentication` | start；poll/submit 带 operationId 与 challengeId，submit 另带 input；cancel 只带 operationId。成功返回公开结果，过期操作/挑战返回 409 |
| `GET /api/instances/:id/roots` | 完整分页后的内容源；使用当前有效快照 |
| `GET /api/instances/:id/directory-status?directoryRef=...` | 当前有效目录最近成功的 `{completedAt,statistics}`，未读取或代际已失效时为 null；只读快照，不请求来源 |
| `POST /api/instances/:id/refresh` | `{scope:"instance"}` 刷新实例内容；`{directoryRef}` 刷新指定目录；兼容 `{}` 仅刷新内容入口列表 |
| `GET /api/layout` | `{revision,nodes}`；nodes 为 null 表示按实例默认布局 |
| `PUT /api/layout` | `{expectedRevision,nodes}`；冲突返回 409，节点合同见 library 类型 |
| `GET /api/library?path=...` | 导出视图中的有序浅目录；文件元数据在实际 stat/读取时准备 |

结构错误与坏 JSON 返回 400；配置/认证语义错误返回 422 及插件字段错误。来源失败保留结构化 `sourceError`，包括需认证、限流或临时错误。配置及认证的公开结果过滤 `nextPrivateState`，管理响应统一 `Cache-Control: no-store`。认证绑定、取消/过期和恢复语义见[验证记录](verification/p1-authentication.md)。真实来源的支持范围查[台账](verification.md)，尚未交付的部署和挂载不返回伪成功。

实例刷新先更新内容入口，再刷新各入口目录和仍可达的已浏览子目录。新子目录首次打开时加载；不遍历已移除的旧引用，不预读全部推荐歌单。结果为 `{refreshedDirectories,failures:[{directoryRef,error:{code,message,sourceFault?}}]}`，目录数不包含内容入口列表自身。每个目录完整分页成功后分别发布；部分失败仍返回 200 和失败明细，保留失败目录最近成功内容，不能只根据 HTTP 状态显示全部成功。根入口读取失败、取消、实例/插件变化或超出目录预算则整次请求失败，已经成功发布的目录不回滚。当前目录预算默认 1000；单目录的分页/条目预算独立保留。指定目录刷新和兼容空请求仍返回完整快照。详见[刷新验证](verification/p1-instance-refresh.md)。

配置声明响应可带插件的可选 `statistics` 标签映射。目录状态只返回当前来源戳下的最近成功时间与计数，不暴露来源戳、私有状态或文件引用。旧快照没有计数时 statistics 为 null；失败刷新继续保留原计数。界面更新配置、安装/移除插件及刷新后使相关查询失效；计数的每页语义见[插件合同](architecture/plugin-interface.md#稳定身份分页与目录)。

`/dav` 和 `/dav/*` 统一提供 OPTIONS、Depth 0/1 PROPFIND、GET/HEAD；单范围、条件验证器及不支持范围的行为见 [ADR 0004](adr/0004-shared-fetch-readonly-dav.md)。实际用户旅程验证见[P0 记录](verification/p0-library-dav.md)。
