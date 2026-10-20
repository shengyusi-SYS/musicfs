# MusicFS 架构与流程图

日期：2026-10-20。「当前链路」对应正式代码与本地验证；明确注明设计目标的流程仍含未实现部分，不表示已完成真实云端或目标系统验收。Mermaid 源码在本页维护；模块定义见 [架构设计](README.md)，调用与字节合同见 [插件 Interface](plugin-interface.md)。关系图描述逻辑身份，不等同于 SQL 表结构。

当前已有共用页面、认证、插件/实例、目录快照/布局、管理 HTTP 和 Fetch DAV；QQ 与[网易云](../verification/p2-netease-source.md)有真实来源证据。正式桌面启动/挂载和 Worker 后台发布已接线，完整范围见[台账](../verification.md)。

## 当前链路

描述正式代码与本地请求路径。Worker 模块组装与持久发布在本地 workerd/受控平台网络验证；rclone 完成真实读取及 RC 进程管理，系统挂载尚待对应环境。

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
  Spawn --> Local[私有凭据 / SQLite / 本机 HTTP]
  Local --> Browser
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

文件条目可随分页提供完整可信的 `Entry.info`；library 校验后暂存，目录完整成功才连同条目发布。已列对象私下关联解析目标及已发布 info，不新增持久路径索引。DAV 需要元数据时才懒调用一次 `statMany`，按不同来源代际在批量前后核对；提供 info 的条目直接描述，旧插件缺 info 时保留实时 stat。该调用次数优化不代表真实免费 Worker 的 CPU 或总体额度已验收。

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
    P-->>S: 有序 Entry，可含完整 info
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
  L-->>D: 名称/类型/日期，内部关联目标与 info
  alt propname 或仅名称/类型标记/日期
    D-->>C: 直接生成子项属性，不调用 statMany
  else allprop 或实际 etag/大小/媒体类型
    D->>L: 懒调用一次 statMany（已列对象）
    L->>S: 按不同来源戳做批量前检查
    S->>DB: 核对实例与安装代际
    S-->>L: 来源有效性
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
  opt 单文件 HEAD / GET
    C->>D: HEAD / GET 文件
    D->>L: stat 路径
    L->>S: 实时 stat，不使用批量快照捷径
    S->>P: 获取当前文件描述
    P-->>S: 内容身份、大小和类型
    S-->>L: 当前文件描述
    L-->>D: 实时描述
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

描述 alpha.9 的已接线责任。自建/收藏、推荐、完整分页、实例音质/回退/去重已接入；SDK续期及凭据就绪即完成授权已通过本地包验证，真实自然到期/失效重登及部分认证facade取消仍待收口。没有把 SDK 的整个路由服务暴露成 MusicFS API。

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
  Client --> SDK["固定 3.3.3 的 serverless SDK"]
  Catalog --> Collections["collections：保留自建 / 收藏原始角色"]
  Collections --> Client
  Client --> RPC["固定 SDK 的 sealed resolver / session Musicu"]
  RPC --> QQ
  Build["作者构建：生成有限原始导出入口"] -.-> RPC
  SDK --> QQ["QQ HTTP / 扫码接口"]
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
  U->>H: 上传包 / 地址
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
