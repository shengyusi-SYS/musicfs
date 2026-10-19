# MusicFS 架构与流程图

日期：2026-10-20。「当前 P0/P1 链路」对应本地实现，其余为完整目标的设计图，不表示已完成部署或验收。Mermaid 源码在本页维护；模块定义见 [架构设计](README.md)，调用与字节合同见 [插件 Interface](plugin-interface.md)。关系图描述逻辑身份，不等同于 SQL 表结构。

当前已有共用管理页面、通用交互认证、插件/实例、目录快照/布局、管理 HTTP 和共用 Fetch DAV。QQ 的真实扫码、每日推荐和正式 DAV/rclone 字节已完成[限定验证](../verification/p1-qq-source.md)；完整示例、续期合并、部署/挂载与发行仍按设计推进。源码和范围见[开发说明](../development.md)、[P0 目录/DAV 记录](../verification/p0-library-dav.md)、[WebUI 接线](../verification/p1-webui.md)与[通用认证](../verification/p1-authentication.md)。

## 当前 P0/P1 链路

仅描述已执行的本地请求路径。Worker 探针使用固定模块，不表示后台部署已实现；rclone 完成客户端读取，未执行系统挂载。

```mermaid
flowchart LR
  Web[React / Vite 共用 WebUI] --> DTO[独立管理 DTO / HTTP 客户端]
  DTO --> Manage[HTTP 管理调用]
  Manage --> Auth[Bearer 管理认证]
  Auth --> E[extensions 安装/移除]
  Auth --> S[sources 实例/配置/交互认证]
  Auth --> L[library 布局/刷新]
  E --> Host[桌面外置加载 / Worker 固定注册]
  L --> S
  S --> Host
  Host --> Plugin[独立最小插件 / QQ 开发预览]
  Client[rclone / 字节测试客户端] --> DAV[Basic 认证 / 共用 Fetch DAV]
  DAV --> L
  L --> Store[SQLite / D1 快照与布局]
  S --> Store
  E --> Store
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
    P-->>S: 下一步 / complete / 错误
    S->>D: 条件接受步骤与私有状态；终态增加代际
    S-->>W: 公开结果
  else 取消
    W->>S: cancel（操作 ID）
    S->>D: 先写 cancelled 并增加代际
    S->>P: 尝试清理当前挑战
    Note over S,D: 旧轮询结果不能覆盖取消；清理失败不撤销取消
    S-->>W: cancelled
  end
```

## 当前 QQ 插件内部链路

仅描述 alpha.5 的已接线责任。自建/收藏、推荐、完整分页、实例音质/回退/去重已接入；续期和部分 metadata facade 取消仍待完成。没有把 SDK 的整个路由服务暴露成 MusicFS API。

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
  HTTP --> UC[插件变更用例]
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

`DIRECTORY_ENTRY` 也可以是目录，因此图中的实际音频关系仅适用于文件条目。快照可以记录未就绪的元数据，但未知大小不表示无权限。历史快照只用于完整提交与恢复内部过程，不是用户历史版本产品。

## 插件变更

这是跨领域用例，`extensions` 解释包，`sources` 准备实例状态，宿主执行代码变化。数据库条件提交不跨 Cloudflare 发布请求；外部结果不明时由同一操作核对。

```mermaid
sequenceDiagram
  autonumber
  participant U as WebUI
  participant C as 插件变更用例
  participant E as extensions
  participant S as sources
  participant H as 桌面加载或 Worker SDK Adapter
  participant DB as 持久化 Adapter
  U->>C: 上传包 / 地址 / 更新或移除
  C->>E: 检查包、兼容并准备变更计划
  E->>DB: 记录操作与期望安装代际
  C->>S: 准备候选迁移，保留当前状态
  S-->>C: 候选状态与期望实例版本
  C->>E: 执行候选发布
  E->>H: 暂存代码或上传并部署候选集合
  H-->>E: 实际运行修订或待核对结果
  alt 代码确认就绪
    C->>DB: 条件发布安装记录与候选实例状态
    DB-->>C: 成功或版本冲突
    alt 数据库提交成功
      C-->>U: 成功与实际版本
    else 状态在发布期间已变化
      C->>E: 核对当前安装与候选清理
      C-->>U: 冲突，未报告业务成功
    end
  else 外部结果不明
    C->>E: 查询并核对原操作
    C-->>U: 仍在核对，保留当前可用事实
  else 明确失败或状态已变化
    C->>E: 结束候选，保留可用版本
    C-->>U: 具体失败 / 冲突
  end
```

操作状态可描述为准备中、发布中、核对中、完成或失败，不是先引入通用工作流引擎。移除也走此用例，使新调用失效并保留实例/布局引用。新旧注册集合、回退、Secrets/D1/静态资源保留和在途读取须 P0 实测。

## 内容刷新

慢操作在事务外进行，布局始终由用户布局操作更新。完整分页和期望代际同时满足，才能切换该目录最近成功快照。实例刷新先更新内容入口，再处理各入口及仍可达的已浏览子目录；新子目录首次打开时读取。以下为已接线的目录发布路径，[验证范围](../verification/p1-instance-refresh.md)不包含无限后台递归或真实云端资源验收。

```mermaid
sequenceDiagram
  autonumber
  participant UI as WebUI / 刷新入口
  participant L as library
  participant S as sources
  participant P as 当前插件
  participant DB as SQLite / D1 Adapter
  UI->>L: 刷新实例内容 / 指定目录
  L->>S: 捕获实例和安装上下文
  S-->>L: 当前代际与受约束调用
  opt 实例刷新
    L->>DB: 读取本实例已访问目录引用
    L->>S: 完整刷新内容入口
    Note over L,S: 队列初始为各入口；只续读仍可达的已访问子目录，去重并限制目录数
  end
  loop 队列内的目录
  loop 读取到分页完成
    L->>S: 读取目录页与游标
    S->>P: list 上下文与取消信号
    P-->>S: 有序条目、本页计数、下一游标或错误
    S-->>L: 合同结果
  end
  alt 完整成功且上下文仍有效
    L->>DB: 条件提交完整目录与汇总计数
    DB-->>L: 新快照或版本冲突
    L->>L: 累计成功目录数，加入可达的已访问子目录
  else 来源失败 / 取消 / 代际已变化
    L->>DB: 记录当前操作结果，不覆盖成功快照
    L->>L: 累计失败明细；取消或代际变化立即终止
  end
  end
  L-->>UI: 成功目录数和失败明细 / 整次操作错误
  Note over L,DB: 刷新不写用户布局；旧操作也不能覆盖新操作状态
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
