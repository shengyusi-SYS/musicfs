# MusicFS 架构与流程图

## 已发布目录视图与单文件访问

2026-10-21源码实现。目录视图属于library，共用命名与路径查找；LRU只加速，SQLite/D1的已发布身份仍是事实源。Worker跨HTTP的runtime生命周期在宿主层单独接线，不能复用旧请求context。细节与受控计数见[性能设计](refresh-performance.md)。

```mermaid
flowchart LR
  Client[HEAD GET Range或目录浏览] --> Resolve[library路径解析]
  Resolve --> Header[SQLite或D1读取发布header及来源戳]
  Header --> Match{发布身份命中有界LRU?}
  Match -->|是| Index[复用可移植名称与路径Map]
  Match -->|否| Rows[读取一次完整已发布快照]
  Rows --> Build[命名与建立索引]
  Build --> Index
  Index --> File[定位所需单项]
  File --> Source[来源stat或open]
  Publish[完整刷新发布新snapshot.id] --> Header
```

## 音频读取与挂载缓存管理

目录、资料和标签计划的缓存与音频正文分属不同模块。App挂载复用rclone稀疏文件；直接DAV仍是来源流，不假定客户端都有磁盘缓存。缓存管理查询原生采样，不建第二套磁盘索引。证据与适用边界见[缓存消费](../verification/cache-consumption-2026-10-21.md)。

```mermaid
flowchart LR
  App[App挂载消费] --> VFS[rclone原生稀疏缓存]
  VFS -->|缺失范围| DAV[共用DAV与library]
  Direct[直接DAV播放器] --> DAV
  DAV --> Source[来源插件 资料及固定标签计划]
  Source -->|需要源音频| CDN[平台CDN]
  UI[缓存管理] --> Mounts[桌面mounts模块]
  Mounts -->|查询实际模式与占用采样| VFS
  Mounts --> Stop[正常卸载所选挂载]
  Stop --> Clear[删除该挂载片段及索引]
  Clear --> Remount[按原设置重挂]
```

## 核心与共用页面升级

核心/WebUI升级保留云端实际代码集合；插件安装仍沿既有后台发布流程。具体操作见[Worker升级说明](../worker.md#升级核心与-webui保留云端插件)。

```mermaid
flowchart LR
  Config[现有目标配置] --> Prepare[升级组装工具]
  Live[SDK读取实际registry及插件模块] --> Prepare
  Build[新core及共用WebUI] --> Prepare
  Prepare --> Output[独立目录及准确模块清单]
  Output --> Wrangler[Wrangler上传资源并部署 keep-vars]
  Wrangler --> Worker[同一Worker与实际插件修订]
  Wrangler --> State[原D1 Secrets与配置保留]
```

日期：2026-10-20。「当前链路」对应正式代码与本地验证；明确注明设计目标的流程仍含未实现部分，不表示已完成真实云端或目标系统验收。Mermaid 源码在本页维护；模块定义见 [架构设计](README.md)，调用与字节合同见 [插件 Interface](plugin-interface.md)。关系图描述逻辑身份，不等同于 SQL 表结构。

当前已有共用页面、认证、插件/实例、目录快照/布局、管理 HTTP 和 Fetch DAV；QQ 与[网易云](../verification/p2-netease-source.md)有真实来源证据。正式桌面启动/挂载和 Worker 后台发布已接线，完整范围见[台账](../verification.md)。

## 当前链路

描述正式代码与本地请求路径。Worker模块组装与持久发布在本地workerd/受控平台网络验证；rclone已有Linux真实FUSE读取、RC进程管理和活动挂载崩溃恢复证据，其他系统仍待验。

```mermaid
flowchart LR
  Web[React / Vite 共用 WebUI] --> DTO[独立管理 DTO / HTTP 客户端]
  DTO --> Manage[HTTP 管理调用]
  Manage --> Auth[Bearer 管理认证]
  Auth --> CH[宿主插件变更]
  CH --> E[extensions 包与安装策略]
  CH --> UC[共用迁移激活用例]
  UC --> S
  Auth --> S[sources 实例/配置/交互认证]
  Auth --> L[library 布局/刷新]
  CH --> Host[桌面外置加载 / Worker 发布后精确注册]
  L --> S
  S --> Host
  Host --> Plugin[独立最小插件 / QQ / 网易云]
  Client[rclone / 字节测试客户端] --> DAV[Basic 认证 / 共用 Fetch DAV]
  DAV --> L
  L --> Store[SQLite / D1 快照与布局]
  S --> Store
  E --> Store
  UC --> Store
```

## 当前 Worker 插件发布

发布及迁移已接线；SDK网络使用受控平台响应，D1为本地真实workerd，真实云端仍待验。宿主差异与共用激活见后文“插件变更”。

```mermaid
sequenceDiagram
  participant U as 共用 WebUI
  participant H as Worker changes
  participant D as D1
  participant C as Cloudflare Content API
  participant N as 含精确候选模块的新调用
  U->>H: 安装 ZIP / 移除
  H->>D: 保存操作与完整候选代码，标记暂存就绪
  H-->>U: 202 + operationId
  opt 配置或状态结构升级
    H->>D: 一次冻结完整实例集合及状态修订
  end
  H->>C: 读取当前 core / registry / modules
  H->>D: 保存候选registry及上传意图
  H->>C: 上传候选代码集合，保留旧 active 修订
  H->>C: 重读实际 registry
  alt 标记匹配
    H->>D: 代码就绪
    alt 结构升级
      Note over H,N: 旧调用没有候选模块，不能转换或激活
      loop 每个独立调用至多一个实例
        N->>D: 读取未准备实例，保存转换及验证后的候选
      end
      N->>D: 另一步条件切换安装、全部实例及completed
    else 首次安装、同结构更新或移除
      H->>D: 条件激活 / missing 与completed
    end
  else 响应丢失或暂时无法核对
    H->>D: verifying，保留旧安装
    U->>H: 查询原 operationId
    H->>C: 只重读核对，不盲目再上传
  else 明确拒绝
    H->>D: failed，保留旧安装
  end
  U->>H: 查询持久进度至终态
```

## 当前桌面生命周期

锁、后台、rclone RC及Linux本地/独立远程FUSE读取、忙时保留与退出已实测；其他目标系统挂载和平台弹窗仍待验。

```mermaid
flowchart LR
  Click[点击发行程序] --> Identity[验证已有后台身份]
  Identity -->|存在| Browser[open 打开共用页面]
  Identity -->|不存在| Spawn[分离后台，持有 proper-lockfile]
  Spawn --> Settings[读取桌面网络设置]
  Settings --> Local[私有凭据 / SQLite / HTTP 监听]
  Local --> Browser
  Browser --> Network[保存本机或局域网 / 端口]
  Network --> NextStart[正常退出后下次启动生效]
  NextStart --> Settings
  Local --> LAN[启用时提供局域网 DAV 地址]
  Browser --> Mounts[挂载管理 API]
  Mounts --> RC[随包 rclone 私有 RC]
  RC --> LocalDAV[本机 DAV]
  RC --> RemoteDAV[远程 HTTP 或 HTTPS DAV]
  Browser --> Quit[请求退出，先正常卸载]
  Quit -->|忙| Keep[保持后台，返回可重试错误]
  Quit -->|已卸载| Drain[202 接受，结束在途请求并退出]
```

## 当前目录属性读取

属性选择每请求按文件/目录编译一次；快照单查询只在首行携带头，唯一名称不进入冲突散列。请求内的日期/来源戳复用不跨请求缓存，范围见[CPU定位](../verification/p2-read-cpu.md)。

API0.1.9沿用文件条目的完整可信 `Entry.info` 和显式 `deferredInfo: true`；library 校验后暂存，目录完整成功才连同条目及待准备数发布。网易云alpha.14对MP3/FLAC/M4A预定准确N+1MiB，目录与HEAD直接复用已发布info，首GET才准备单曲，见下方标签流程。已列对象私下关联解析目标及已发布 info，不新增持久路径索引。旧的显式延迟条目仍通过持久 `file-info` 刷新准备批量属性，准备期间返回503及重试头；旧插件缺 info 时保留实时 stat。历史流程与证据见[两阶段验证](../verification/deferred-catalogue.md)，不代表所有播放器自动重试或免费 Worker 额度已验收。

```mermaid
sequenceDiagram
  participant C as DAV 客户端
  participant D as DAV 属性映射
  participant L as library
  participant S as sources
  participant P as 来源插件
  participant DB as SQLite / D1
  opt 目录刷新：每个独立 step 最多一页
    L->>S: list 当前游标
    S->>P: 当前实例的分页调用
    P-->>S: 有序 Entry，可含完整 info 或 deferredInfo
    S-->>L: 分页结果
    L->>L: 校验提供的 info 与页面合同
    alt 仍有下一页
      L->>DB: 条件追加暂存行与检查点
    else 当前目录末页成功
      L->>DB: 原子追加末页并切换完整快照发布指针
    end
  end
  C->>D: PROPFIND Depth 1
  D->>L: stat 父项、list 子项
  L->>DB: 读取已发布快照
  L-->>D: 名称/类型/日期，关联目标、info 或延迟标记
  alt propname 或仅名称/类型标记/日期
    D-->>C: 直接生成子项属性，不调用 statMany
  else allprop 或实际 etag/大小/媒体类型
    D->>L: 调用一次 statMany（已列对象）
    L->>S: 按不同来源戳做批量前检查
    S->>DB: 核对实例与安装代际
    S-->>L: 来源有效性
    alt 存在没有 info 的显式延迟条目
      L->>DB: 创建或复用此目录的 file-info 刷新
      L-->>D: PendingRefreshError（operationId）
      D-->>C: 503 + Retry-After + X-MusicFS-Refresh
      loop 后台或管理页推进，每步最多一页
        L->>S: list 当前游标，fileInfo: required
        S->>P: 准备该页准确文件信息
        P-->>L: 每个文件均有完整 info，或明确故障
        L->>DB: 检查点；末页成功原子发布新完整快照
      end
      Note over C,DB: 准备期间原清单可浏览；完成后客户端重试
    else 所需 info 已有，或未声明延迟能力
      L->>L: 使用快照 info 生成文件描述与 ETag
      loop 仅旧插件缺 info 的文件
        L->>S: 实时 stat
        S->>P: 获取当前文件描述
        P-->>S: 内容身份、大小和类型
        S-->>L: 受实例约束的结果
      end
      L->>S: 整批完成后按不同来源戳再核对
      S->>DB: 核对实例与安装代际
      S-->>L: 来源有效性
      L->>L: 变化的来源整组标记 Error
      L-->>D: 每项 Description 或 Error
      D-->>C: 属性与逐项结果
    end
  end
  opt 单文件 HEAD / GET
    C->>D: HEAD / GET 文件
    D->>L: stat 路径
    L->>S: 检查来源戳
    alt 已发布文件有完整 info
      L->>L: 复用描述与该精确表示的 ETag
    else 缺少 info（包括显式延迟条目）
      L->>S: 实时 stat
      S->>P: 按需准备或获取该文件描述
      P-->>S: 内容身份、大小和类型
      S-->>L: 当前文件描述
    end
    L->>S: 描述完成后再核对来源戳
    L-->>D: 文件描述
    Note over D,L: HEAD 返回描述；GET 继续 open 与字节核验
  end
```

## 当前交互认证

对应本地 SQLite/D1 与共用页面的已实现流程；通用步骤由测试插件验证，QQ 已另行验证真实手机扫码。开始、终态的代际变化与普通状态 CAS 分开处理，取消不会等待旧轮询完成才写入。

```mermaid
sequenceDiagram
  participant W as 共用 WebUI
  participant S as sources
  participant D as SQLite / D1
  participant P as 来源插件
  W->>S: start
  S->>D: 条件写入操作 ID，增加实例代际
  S->>P: start（当前配置和私有状态）
  P-->>S: waiting / input，候选私有状态
  S->>D: 核对操作修订、状态 CAS、实例与安装代际
  S-->>W: 公开步骤（无私有状态）
  alt 继续认证
    W->>S: poll / submit（操作 ID 与挑战 ID）
    S->>P: 仅传插件挑战与输入
    P-->>S: 下一步 / 凭据就绪即 complete / 错误
    S->>D: 条件接受步骤与私有状态；终态增加代际
    S-->>W: 公开结果
    Note over P: 账号资料由后续内容读取按需补齐
  else 取消
    W->>S: cancel（操作 ID）
    S->>D: 先写 cancelled 并增加代际
    S->>P: 尝试清理当前挑战
    Note over S,D: 旧轮询结果不能覆盖取消；清理失败不撤销取消
    S-->>W: cancelled
  else 退出已保存授权
    W->>S: DELETE 实例 session
    S->>D: 原子保留配置、清空私有状态与认证、增加代际
    Note over S,D: 旧认证/刷新不能写回；布局保留
    S-->>W: 204，后续按现有流程重新授权
  end
```

## 当前按需会话续期

插件判断到期和重试时间，sources只协调同一实例的必要续期；普通内容请求在租约之外。SQLite/D1使用同一条件SQL计划，详见[会话验证](../verification/p2-session-lifecycle.md)。

```mermaid
sequenceDiagram
  participant R as roots/list/stat/open
  participant S as sources
  participant P as 插件 renewal
  participant DB as SQLite / D1
  R->>S: 当前实例调用
  S->>P: needed（本地状态，无网络）
  alt 无需续期
    S->>P: 普通内容操作
  else 需要续期
    S->>DB: 条件取得短租约并预留状态修订
    alt 其他调用正在续期
      S->>DB: 可取消等待后读取新状态或短期失败
    else 本调用取得租约
      S->>P: renew（可取消，事务外）
      P-->>S: 可选新状态和成功/错误
      S->>DB: 条件保存结果并释放租约
    end
    S->>P: 成功后执行普通内容操作
  end
  P-->>R: 内容结果（后续失败不回滚已保存凭据）
```

## 当前 QQ 插件内部链路

描述 alpha.10 的已接线责任。自建/收藏、推荐、完整分页、实例音质/回退/去重已接入；SDK续期、凭据就绪即完成授权和认证底层取消已通过本地包验证，真实自然到期/失效重登继续待验。没有把 SDK 的整个路由服务暴露成 MusicFS API。

```mermaid
flowchart LR
  Core["sources 的公开插件调用"] --> Entry["QQ index：接口装配"]
  Entry --> Auth["authentication：扫码和会话交换"]
  Entry --> Catalog["catalog：内容分类 / 完整分页 / 有限推荐 / 出现位置"]
  Entry --> Config["configuration：实例默认值 / Schema / 音质策略"]
  Entry --> Media["media：字节描述 / stat / open"]
  Auth --> Client["client：实例私有状态 / 错误翻译"]
  Catalog --> Client
  Catalog --> Playback["playback：目标到实际版本 / 批量解析 / 去重 / 稳定引用"]
  Playback --> Config
  Playback --> Client
  Media --> Playback
  Media --> Client
  Client --> Ports["upstream：五个SDK登录操作 / QR与会话服务装配"]
  Ports --> Http["SDK AuthHttpClient / Cookie jar / Axios Fetch adapter"]
  Ports --> Driver["SDK QQ纯HTTP驱动"]
  Catalog --> Collections["collections：保留自建 / 收藏原始角色"]
  Collections --> Client
  Client --> RPC["固定 SDK 的 sealed resolver / session Musicu"]
  RPC --> QQ
  Build["作者构建：生成有限原始导出入口"] -.-> RPC
  Http --> HostFetch["ctx.fetch / AbortSignal / no-store"]
  Driver --> HostFetch
  HostFetch --> QQ["QQ HTTP / 扫码接口"]
  Media --> Fetch["ctx.fetch：媒体 Range / 取消 / 流"]
  Playback --> Select["SDK CDN selector：调用内选择 / 1 字节探测"]
  Select --> Fetch
  Fetch --> CDN["QQ CDN"]
  Client --> State["通过 nextPrivateState 提交候选状态"]
  State --> CAS["sources 条件保存到 SQLite / D1"]
```

SDK 的签名、加密和传输留在依赖中；生成导出的取舍见 [ADR 0005](../adr/0005-pinned-qq-sdk-read-adapter.md)。媒体的 URL 只在一次调用内使用。公开文件引用包含来源标识与实际文件名，核心不解析其中语义。插件按页报告计数并声明显示标签；library 汇总到完整快照，共用界面仅显示标签与计数。SDK 不进入核心或页面导入图。

## 产品结构

箭头表示运行时调用或内容访问。桌面与 Worker 是独立部署选择，来源兼容性按插件声明决定。

```mermaid
flowchart LR
  UI[共用 WebUI] --> API[管理入口]
  API --> Core[插件和实例管理 / 音乐目录]
  Core --> Runtime[当前宿主的插件执行]
  Runtime --> N[网易云示例插件]
  Runtime --> Q[QQ 示例插件]
  Runtime --> X[其他来源插件]
  N --> NS[网易云来源]
  Q --> QS[QQ 来源]
  X --> XS[音乐服务或文件来源]
  DAV[只读 WebDAV] --> Core
  Player[播放器 / OpenList] --> DAV
  Rclone[桌面随包 rclone] --> DAV
  Rclone --> Mount[本机目录或盘符]
  Core --> Store[当前部署的持久存储]
```

## 模块依赖

箭头表示允许的源码依赖，不表示数据流。实线所示 Module 内仍可拆私有文件；宿主 Adapter 实现领域定义的 Interface，通过装配入口注入。`mounts` 不进入 Worker 导入图。

```mermaid
flowchart TD
  Entry[desktop.ts / worker.ts 装配] --> HTTP[HTTP 管理协议]
  Entry --> DAV[DAV Adapter]
  Entry --> Infra[SQLite/D1 与宿主 Adapter]
  Entry --> Mounts[仅桌面的 mounts]
  Infra --> UC[共用迁移激活用例]
  HTTP --> L[library]
  HTTP --> S[sources]
  HTTP --> E[extensions]
  HTTP --> Archive[归档 Adapter：只读包检查]
  Archive --> E
  DAV --> L
  UC --> E
  UC --> S
  L --> S
  S --> E
  E --> API[公开 plugin-api]
  S --> API
  L --> API
  P[示例 / 第三方插件] --> API
  Infra --> Ports[领域 Module 声明的存储和执行 Interface]
  Infra --> ChangeStore[变更用例声明的条件提交 Interface]
  UC --> ChangeStore
  E --> Ports
  S --> Ports
  L --> Ports
```

`Ports` 是图中对本地 Interface 的合称，不另建一个无所有者的通用 ports 包。前端只依赖管理数据合同与 HTTP 客户端，不导入上述后台实现。

## 领域关系

Worker的复用边界与桌面保持同一领域算法：

```mermaid
flowchart LR
  Binding[D1 binding] --> Runtime[无请求上下文的 runtime]
  Runtime --> Core[sources / library]
  Core --> Views[有界已发布目录索引]
  Request[每次 HTTP] --> Service[本次 Hono 与宿主接线]
  Service --> Runtime
  Request --> Context[本次凭据 / assets / waitUntil / signal]
  Context --> Service
  Views --> Header[D1 header 核对发布身份]
```

runtime不保存音频Response、stream或HTTP执行上下文。Worker isolate消失只损失暖索引；持久检查点与发布快照仍从D1恢复。短暂失败与限流都沿现有任务retryAt续接，重试本身不形成另一套队列。

插件、安装修订与实例分别存在；一个实际音频可对应多个目录出现位置。目录布局引用内容源，不接管来源内部对象或平台歌单。

```mermaid
erDiagram
  PLUGIN ||--o{ INSTALLATION_REVISION : has
  PLUGIN ||--o{ SOURCE_INSTANCE : configures
  SOURCE_INSTANCE ||--o{ CONTENT_SOURCE : exposes
  CONTENT_SOURCE ||--o{ DIRECTORY_SNAPSHOT : refreshes
  DIRECTORY_SNAPSHOT ||--o{ DIRECTORY_ENTRY : contains
  ACTUAL_AUDIO o|--o{ DIRECTORY_ENTRY : appears_as
  SOURCE_INSTANCE ||--o{ ACTUAL_AUDIO : provides
  EXPORT_LAYOUT ||--o{ LAYOUT_NODE : contains
  CONTENT_SOURCE o|--o{ LAYOUT_NODE : referenced_by
  LAYOUT_NODE o|--o{ LAYOUT_NODE : parent_of
```

`DIRECTORY_ENTRY` 也可以是目录，因此图中的实际音频关系仅适用于文件条目。文件条目的 `info` 可为兼容旧插件而省略；提供时必须完整且对应确切字节，不能将未知大小写成 0。缺省保留实时 stat，不另建核心元数据准备阶段。历史快照只用于完整提交与恢复内部过程，不是用户历史版本产品。

## 插件变更

当前跨领域用例：`extensions` 解释包/安装策略，`sources` 只准备候选数据，宿主取得精确代码，持久化执行共同SQL计划。迁移验证见[记录](../verification/p2-plugin-migration.md)。数据库条件提交不跨Cloudflare请求，外部结果不明仍由原操作核对。

```mermaid
sequenceDiagram
  autonumber
  participant U as WebUI
  participant H as 桌面或Worker变更控制器
  participant C as 共用迁移激活用例
  participant E as extensions
  participant S as sources
  participant DB as 持久化 Adapter
  U->>H: 先只读检查ZIP / 地址
  H->>E: 共用归档校验、semver与宿主支持
  H-->>U: 插件信息及API/宿主兼容结果
  Note over U,H: 检查不加载代码、不改变安装
  U->>H: 审阅后安装ZIP / 地址
  H->>E: 校验包、版本与宿主兼容
  H->>DB: 记录持久操作和期望安装代际
  H-->>U: 202与原operationId
  H->>C: 捕获升级输入
  C->>DB: 一次冻结完整实例集合及各自epoch/stateRevision
  H->>H: 桌面加载候选；Worker发布并核对新旧代码集合
  Note over H,C: Worker后续调用必须含精确候选修订
  loop 每步一个实例，事务外转换/验证
    H->>C: 当前租约与候选模块
    C->>DB: 读取一个未准备输入
    C->>S: preparePluginMigration
    S-->>C: 规范化配置与目标私有状态
    C->>DB: 条件暂存候选，当前活动数据不变
  end
  H->>C: 所有候选已就绪，另一步激活
  alt 安装代际、完整实例集合与各自版本仍匹配
    C->>DB: 同事务切换安装、全部实例、completed并清候选
    C-->>H: 成功
  else 转换失败或版本冲突
    C->>DB: failed并清候选，保留原安装和全部活动数据
    C-->>H: 固定错误码与公开说明
  end
  U->>H: 恢复查询原操作
  H-->>U: 持久进度或终态
```

结构不变的桌面安装仍立即完成，移除保留实例/布局；Worker所有变更都异步发布。迁移与目录刷新复用桌面同一后台循环，Worker每次后台/定时调用有界续步。`preparing`、`migrating` 是原变更记录的阶段，不引入通用工作流引擎。真实云端Secrets/D1/静态资源保留与在途播放影响仍待验。

## 内容刷新

当前持久实现由 `library` 拥有操作和完整发布，宿主只负责安排独立的 step。每实例一个活动操作；实例范围先入口、再入口目录及仍可达的已浏览子目录。页面恢复原操作 ID，GET 不推进；桌面后台连续续步，Worker 每次 HTTP 后台或每分钟 scheduled 调用最多一页。详细取舍见 [ADR 0007](../adr/0007-durable-paged-refresh.md)。

```mermaid
sequenceDiagram
  participant UI as WebUI / 冷读取
  participant H as 桌面后台 / 独立 Worker 调用
  participant L as library.refreshes
  participant P as sources / 当前插件
  participant DB as SQLite / D1
  UI->>L: start 范围 / ensure 缓存缺失
  L->>DB: 新建或复用有效操作和暂存身份
  L-->>UI: 202 operationId / 503 Retry-After
  loop 每次独立 step，最多一页
    H->>L: step(operationId)
    L->>DB: 核对代际并领取有期限租约
    alt 成功取得执行权
      L->>P: roots/list 当前游标（事务外）
      P-->>L: 有序条目、增量计数、下一游标
      alt 仍有下一页
        L->>DB: 条件追加暂存行，保存游标和计数，释放租约
      else 当前目录完整
        L->>DB: 条件追加末页并原子切换发布指针
        L->>L: 转下一目录或完成，记录局部失败
      end
    else 其他调用正在处理或操作已失效
      L-->>H: 已有进度 / 终态，不重复读取
    end
    L-->>H: 当前公开进度
  end
  UI->>L: GET 原操作 ID
  L-->>UI: 公开进度 / 终态和失败明细
  opt 取消 / 替换 / 配置或插件变化
    UI->>L: cancel / start / 来源操作
    L->>DB: 更新状态或代际；迟到提交条件不再匹配
  end
  Note over L,DB: 旧完整目录保留至新目录完整成功；刷新不写布局
```

目录失败状态由现有快照记录持有，不以最近一次任务的终态替代：

```mermaid
flowchart LR
  Fail[A目录刷新失败] --> Saved[保留A完整内容 计数 时间并保存error]
  Saved --> Header[共同SQL读取snapshotHeader]
  Header --> DTO[DirectoryStatus 时间 计数 error]
  DTO --> UI[页面显示保留最近成功内容]
  Path[已发布路径] --> Browse[library一次解析并列目录]
  Browse --> Header
  Browse --> Listing[DirectoryListing 条目与当前目录状态]
  DTO --> Listing
  Listing --> Browser[含嵌套目录的浏览器警告]
  Other[B目录成功或页面重开] --> Header
  Success[A目录完整刷新成功] --> Clear[发布新内容并清除A的error]
  Clear --> Header
```

## 音频读取

箭头表示一次读取的真实责任链。临时地址和来源签名留在插件内，协议只依据实际返回的表示和范围输出响应。

```mermaid
sequenceDiagram
  autonumber
  participant C as DAV 客户端
  participant D as DAV Adapter
  participant L as library
  participant S as sources / 插件调用
  participant O as 来源音频服务
  C->>D: GET 或 HEAD，可含 Range
  D->>L: 路径 stat
  L->>S: 获取实际文件描述
  S-->>L: 内容身份、大小和类型
  L-->>D: 当前文件描述
  alt HEAD 或范围不可满足
    D-->>C: 无正文的 HEAD 或 416
  else 打开音频
    D->>L: open 期望内容身份与范围
    L->>S: 实例约束和取消信号
    S->>O: 必要认证、签名及范围读取
    O-->>S: 实际响应头与字节流
    S-->>L: 实际内容身份、长度、范围与 Web Stream
    L-->>D: 已核对的读取结果
    D-->>C: 按实际事实发送 200 / 206 和字节
    opt 客户端取消或流错误
      D->>L: 取消当前读取
      L->>S: AbortSignal / 流取消
      S->>O: 终止真实上游读取
    end
  end
```

上游完整 200 不得伪装成 206。返回头前发生内容换版时可核对描述；正文开始后不能换编码或从头拼接。图不承诺任何特定 CDN、DAV 库或宿主已满足这些行为。

## 可选标签处理设计

网易云alpha.14默认每页200首先发布完整清单，对MP3/FLAC/M4A预定最终大小N+1MiB，不取全库歌词、封面或音频。目录与HEAD不补标签，首GET才构造所读单曲；API0.1.9可选原子缓存固定首次计划，紧凑零区段在流式读取时生成合法填充。QQ继续在目录分页内准备最终信息，APE不默认预留。富详情批量、共享封面及`ReadRange.readMany?`首尾读取继续用于文件准备，CDN请求和标准MIME解析仍归来源Adapter。[生产接线与原型边界](../verification/lazy-mount-feasibility.md)、历史[两阶段验证](../verification/deferred-catalogue.md)与[冷准备调查](../verification/netease-cold-request-reduction.md)分别保留适用范围。

三种插件实现通过同一个文件 Interface 接入，核心不增加强制处理阶段。QQ、网易云已选用共用工具；其他插件保持自主选择。设计见[可选补标签设计](audio-tags.md)，当前证据见[实现记录](../verification/metadata-implementation.md)。

```mermaid
flowchart LR
  subgraph P[来源插件内部：自行选择]
    O[上游文件与来源资料]
    O --> A[直接透传]
    O --> B[插件自带补标签]
    O --> C[选用共用音频工具]
    T[现成格式库] --> C
    A --> F[最终描述与字节读取]
    B --> F
    C --> F
  end
  F --> I[公开 list / stat / open]
  I --> L[核心快照与文件访问]
  L --> D[WebDAV / 挂载]
```

共用工具可以复用准备后的音乐资料，但不解释平台请求或认证；核心只核对最终大小、内容身份和实际范围。未选择补标签的插件不依赖该工具；它的格式集合不限制其他插件。

```mermaid
sequenceDiagram
  participant P as 网易云插件
  participant C as 实例缓存 SQLite/D1
  participant U as 来源接口与原音频
  participant T as 可选音频工具
  participant L as 核心快照 / DAV
  L->>P: 普通 list 当前游标
  P->>U: 批量成员、歌曲详情及播放版本
  P->>C: 保存永久紧凑歌曲 seed，查询准备索引
  P-->>L: 预定版本v4与完整info，准确大小N+1MiB
  Note over P,L: 全部分页成功后发布完整清单
  opt 目录属性或HEAD
    L->>L: 复用已发布info与ETag，无标签准备
  end
  L->>P: GET open(期望内容身份, 最终范围)
  P->>C: 查询此版本的永久计划
  alt 已有计划
    C-->>P: 固定字节计划，不受ready TTL影响
  else 此版本首次读取
    P->>C: 取得稳定seed
    P->>U: 该文件缺少的资料、封面、歌词与头尾范围
    P->>T: prepare(资料, 原文件范围, reserveBytes)
    alt 标签与容器结构适合预留空间
      T-->>P: 标签字节、紧凑零区段、原音频区段
      P->>C: putIfAbsent原子固定首次永久计划
      C-->>P: 返回实际获胜计划
      P->>C: 保存带TTL的ready索引，供未来刷新复用
    else 资料超预算
      P->>C: 保存此曲准确exact v2计划及ready索引
      P-->>L: content_changed，提示刷新后打开
      Note over P,L: 下次完整刷新发布新描述，不增长旧版本
    end
  end
  opt 本次读取取得固定计划
    P->>U: 取得同一媒体版本的地址和所需范围
    P->>T: open(固定计划, 原文件读取, 最终范围)
    T-->>L: 标签、按需生成填充和原音频流
  end
```
