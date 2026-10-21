# MusicFS 架构设计

MusicFS 是插件式只读音乐文件服务，桌面与 Worker 独立部署、共用核心和 WebUI。网易云与 QQ 是示例插件，来源专属能力不进入核心。用户结果以[统一需求](../../outputs/musicfs-requirements-and-technical-design.md)为准，名词见[术语](../../outputs/GLOSSARY.md)，结构与时序见[图表](diagrams.md)。本页描述现行职责，实际版本和通过范围查[发行页](../release.md)及[验收台账](../verification.md)。

## 领域划分与所有权

| 所有者 | 拥有的事实与行为 | 对外接口 |
|---|---|---|
| `extensions` | 插件身份、包合同、兼容性、安装记录与代际 | 包检查、安装/移除策略；不修改实例配置 |
| `sources` | 实例配置、认证、私有状态修订、调用代际与受约束插件调用 | 创建/配置/认证/退出/删除、迁移候选、`current` 与来源调用 |
| `library` | 内容源、完整快照、路径/命名、布局、刷新与周期策略 | `list/stat/statMany/open`、目录浏览、持久分页与发布 |
| 数据源插件 | 来源协议、分类、音质/权益、音乐资料、最终文件表示与定位 | 独立公开插件合同；可透传或自行补标签 |
| 桌面 `mounts` | 本地/远程挂载定义、就绪、卸载、移除、每挂载缓存 | 挂载管理接口；具体文件系统交给 rclone |
| 管理认证 | 单管理员账号、浏览器会话和桌面/扫码入口 | 共用管理 API 中间件；独立于来源授权与 DAV 读取凭据 |
| 桌面 `read-cache` | 直接 DAV 已读字节的共享缓存、设置与清理 | 包装 `FileView.open`，保持原文件描述与 DAV 合同 |
| 桌面装配 / Worker 装配 | 原生进程/监听器或云端模块、后台续步、存储 Adapter | 组合真实能力并管理生命周期 |

音乐平台账号是来源的内部概念，管理账号归管理认证边界。安装插件后由用户添加来源；移除插件保留实例和布局，删除实例保留其他实例共用的插件。曲目出现位置、实际媒体与导出表示分别存在，各实例拥有自己的凭据和私有状态。

## 模块组织

| 层级 | 位置与职责 |
|---|---|
| 交互与协议 | `web`、`transport/http`、`transport/dav`：输入、管理 DTO、HTTP/DAV 响应 |
| 跨领域用例 | `application/change-plugin.ts`：冻结输入、候选迁移和整体激活 |
| 领域 | `core/extensions`、`core/sources`、`core/library`：各自状态和行为 |
| 公开合同 | `packages/plugin-api`：可序列化数据、配置/认证/目录/读取及错误语义 |
| 可选格式工具 | `packages/audio-tags`：插件选用的标签编码与区段读取，核心不依赖 |
| 基础设施与宿主 | `infrastructure`、`hosts/desktop`、`hosts/worker`：存储、加载/发布、系统适配 |
| 装配入口 | `desktop.ts`、`worker.ts`：选择 Adapter，不解释来源业务 |

领域单向依赖 `library → sources → extensions`，均可依赖公开合同。存储和执行接口由使用方声明，Adapter 从外侧实现并经工厂注入；跨领域安装由上层用例协调。其他单模块用例直接调用，不为同一组参数添加多层 Service/Manager/Repository。

前端只依赖管理合同与 HTTP 客户端。核心不导入来源 SDK、React、Hono 或音频工具；公开合同不导入核心/宿主；插件不导入核心私有模块；Worker 不间接导入桌面数据库、挂载或磁盘缓存。`dependency-cruiser`检查这些方向，实际构建另验运行时兼容。

## 文件接口与表示

`library` 向协议层提供 `list/stat/statMany/open`。已发布视图按来源戳和快照身份复用命名/路径索引；列出的条目可在当前进程关联解析目标，序列化后回退路径解析。完整 `Entry.info` 对应准确最终大小、内容身份和类型，单项与批量描述共用，不把未知大小伪装成零。

`open` 接受期望内容身份和范围，返回相同表示的实际范围与 Web Stream。核心核对身份、长度和来源代际；协议层处理条件、Range 与响应，不能把上游完整响应伪装为部分响应。流保留背压和取消，不缓冲整曲。

插件可声明 `deferredInfo`，在批量准确属性请求时复用 `file-info` 持久任务；旧插件省略信息则保留实时 stat。网易云预留表示直接发布准确大小，目录/HEAD 不补标签，GET 才准备单文件；QQ 保持分页准备。预留预算、格式与超预算行为见[可选补标签](audio-tags.md)，来源请求及粒度见[刷新性能设计](refresh-performance.md)。

## 状态与持久提交

安装代际、实例代际、私有状态 CAS、刷新身份与快照身份分别承担不同责任。换号、配置语义变化或删除使旧调用失效；普通凭据续期不应被当作换号。插件只返回候选私有状态，不取得裸数据库句柄。

网络等待在事务外，SQLite 事务与 D1 batch 使用共同条件 SQL 提交：输入版本、租约和有效操作仍匹配时才接受结果。进程锁或并发库不能替代跨请求条件提交。查询按领域操作设计，不建立通用数据库插件或仓储框架。

目录页暂存，末页完整成功才切换该目录发布指针；失败保留旧成功内容与失败标记。任务终态、目录失败和布局分别保存，另一目录成功不能清除原目录失败。刷新不写用户布局。

每实例一个活动刷新。缓存缺失合并到原操作，显式刷新可替换；先入口再处理仍可达的已浏览目录，不递归预抓全树。桌面后台持续续步并适度让步，Worker 每次独立后台调用推进一页，Cron 提供后续唤醒。周期更新复用同一队列，不另建每曲定时器。[刷新取舍](../adr/0007-durable-paged-refresh.md)、[缓存与更新策略](cache-policy.md)

## 配置、认证与安装

管理页采用 Better Auth 的单管理员会话：账号密码、桌面启动和手机 ticket 兑换汇入同一管理中间件，SQLite 与 D1 分别适配；DAV 读取和音乐平台授权各有独立凭据与生命周期。详见[管理访问](management-access.md)。

插件实例配置通过 JSON Schema 和有限 UI 数据声明；前端 RJSF/Ant Design 生成表单，TanStack Query 管请求与失效。Zod 检查核心管理输入，官方插件工具在构建时用 Ajv standalone 生成结构校验；来源可达性与账号能力仍由插件判断。插件不传 React 组件、验证器对象或任意前端代码。

`sources` 持久化交互操作、挑战与版本，取消先提交终态，再尝试来源清理。两个示例在凭据就绪时完成授权，补充账号资料按内容需要取得。按需续期由插件判断渠道和期限，核心只用短租约/CAS 协调同实例，不把普通读取都串行化。[会话证据](../verification/p2-session-lifecycle.md)

安装检查与运行分开。桌面准备不可变外置代码，Worker 发布并核对精确模块集合；结构升级冻结完整实例输入、逐个准备候选，再原子切换安装和全部实例。Cloudflare 与 SQL 没有全局事务，响应不明时原操作核对结果；不能盲目重传或只回退代码而忽略已变更状态。详见[插件变更图](diagrams.md#插件变更)、[Worker 发布](../worker.md)和[迁移证据](../verification/p2-plugin-migration.md)。

## 桌面资源与共享读取

对外 DAV 始终沿用共用协议。桌面 `read-cache` 仅接入字节读取，通过不可变最终身份的内部路径复用 rclone 服务端 VFS；App 本机挂载走内部原文件视图，使用自身 VFS，避免同一次读取重复落盘。Worker 保持原来源流。

rclone RC 进程由桌面装配统一拥有，挂载和共享读取模块各管理自己的 VFS。退出先停止新增直接读取、正常卸载，再关闭共享服务和原生进程；失败恢复接收与可操作状态。未用功能的查询/关闭不启动原生服务。缓存详见[共享读取](shared-read-cache.md)，系统驱动、HTTPS 与原生映射详见[桌面挂载](desktop-mounts.md)。

## 第三方机制与自有代码

| 机制 | 现行复用 | MusicFS 负责 |
|---|---|---|
| HTTP / 页面 / 请求状态 | Hono、React/Vite、Ant Design、TanStack Query | 用例、交互和失效关系 |
| 表单 / 校验 | RJSF AntD、Zod、Ajv standalone | 声明合同、来源语义与错误映射 |
| ZIP / 版本 | zip.js、npm semver；fflate 仅开发期独立编码互操作 | 包合同、兼容与安装切换 |
| 标签与 MIME | node-taglib-sharp、multipart-parser，由选用的插件打包 | 最终表示计划、区段适配与来源请求 |
| 发布 / 持久化 | Cloudflare 官方 SDK、bun:sqlite、D1 | 发布核对、领域 SQL 和条件提交 |
| 管理登录 | Better Auth | 单管理员范围、一次访问 ticket、产品入口与凭据职责 |
| 托盘 / 自启 | tray-icon、tao、auto-launch、系统 registry/plist 库 | 原生小辅助程序、后台事件与启动设置 |
| 系统 / 缓存 | rclone、Bun.spawn、proper-lockfile、env-paths、open、selfsigned、lru-cache | 资源生命周期、缓存身份及必要宿主适配 |
| DAV / 依赖方向 | Fetch 原生映射、xmldom、range-parser；dependency-cruiser | 只读协议接线、允许的依赖边界 |

采用现成机制不等于把领域责任交给库。缺失的协议或运行时合同须明确比较修正 Adapter 与替代成本；不为“用了依赖”额外造一层框架。历史 DAV 候选取舍见[ADR 0004](../adr/0004-shared-fetch-readonly-dav.md)，依赖解释与比较见[选型说明](../../outputs/musicfs-simplification-and-dependencies.md)。
