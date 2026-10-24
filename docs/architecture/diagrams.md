# MusicFS 架构与流程图

图示描述现行职责与合同，不证明目标系统或平台验收。模块细节见[架构](README.md)，版本事实见[台账](../verification.md)。专题图只在其设计页维护，避免复制后各自过时。

## 当前链路

箭头表示调用，桌面与 Worker 是两种独立部署。

```mermaid
flowchart LR
  UI[共用 WebUI] -->|浏览器会话| HTTP[管理 HTTP]
  Scripts[部署与自动化] -->|管理 Bearer| HTTP
  HTTP --> Change[宿主插件变更与迁移用例]
  HTTP --> Core[extensions / sources / library]
  Change --> Core
  Core --> Runtime[当前宿主的精确插件代码]
  Runtime --> Plugins[网易云 / QQ / 其他来源插件]
  Plugins --> Upstream[来源接口与音频服务]
  Reader[播放器 / OpenList] --> DAV[Basic 只读 DAV]
  DAV --> Files[宿主装配的 FileView]
  Files --> Core
  Core --> Store[SQLite 或 D1]
```

缓存的完整调用链见[共享读取图](shared-read-cache.md#所有权与调用)，App 磁盘与 WebClient 两种入口见[挂载图](desktop-mounts.md)，自动更新与展示策略见[调度和命名图](updates-and-naming.md)。缓存只改变字节读取，不接管目录、认证或 HTTP 条件处理。

管理与 WebDAV 的独立端口、手机管理和播放器导入分别见[访问入口图](management-access.md#桌面访问范围)；浏览器、插件及运行机器的语言归属见[国际化图](i18n.md#职责)。这些入口复用各自认证与领域合同。

## 模块依赖

箭头表示源码依赖。Adapter 实现使用方声明的接口，装配入口注入具体实现；不另设无所有者的通用 ports 包。

```mermaid
flowchart TD
  Entry[桌面 / Worker 装配] --> Transport[HTTP 与 DAV]
  Entry --> Host[宿主与基础设施 Adapter]
  Entry --> Usecase[application 插件迁移激活]
  Transport --> L[library]
  Transport --> S[sources]
  Transport --> E[extensions]
  Usecase --> S
  Usecase --> E
  L --> S
  S --> E
  Host --> Ports[各模块声明的存储与执行接口]
  L --> API[plugin-api]
  S --> API
  E --> API
  Plugins[来源插件] --> API
  Plugins --> Tags[可选 audio-tags]
  Tags --> API
  Web[WebUI] --> DTO[管理 DTO / HTTP 客户端]
```

核心不依赖音频工具或平台 SDK，Worker 不导入桌面磁盘/进程能力，前端不导入后台实现。实际规则由 dependency-cruiser 检查。

## 领域关系

这是逻辑概念关系，不等同 SQL 表。目录条目也可以是目录，实际音频关系仅适用于文件条目。

```mermaid
erDiagram
  PLUGIN ||--o{ INSTALLATION_REVISION : has
  PLUGIN ||--o{ SOURCE_INSTANCE : configures
  SOURCE_INSTANCE ||--o{ CONTENT_SOURCE : exposes
  CONTENT_SOURCE ||--o{ DIRECTORY_SNAPSHOT : publishes
  DIRECTORY_SNAPSHOT ||--o{ DIRECTORY_ENTRY : contains
  ACTUAL_AUDIO ||--o{ FINAL_REPRESENTATION : exports
  FINAL_REPRESENTATION o|--o{ DIRECTORY_ENTRY : appears_as
  SOURCE_INSTANCE ||--o{ ACTUAL_AUDIO : provides
  EXPORT_LAYOUT ||--o{ LAYOUT_NODE : contains
  CONTENT_SOURCE o|--o{ LAYOUT_NODE : referenced_by
  LAYOUT_NODE o|--o{ LAYOUT_NODE : parent_of
```

目录出现身份、实际媒体和最终文件表示分别使用；同媒体可因标签变化产生新表示。完整 `info` 必须对应准确最终字节；显式延迟与旧插件实时 stat 是兼容路径，不是未知大小可伪装为零。

## 内容刷新

同一持久分页算法服务两宿主。缓存缺失复用操作，显式刷新可替换；完整成功后按目录发布，失败不抹旧内容。周期安排见[缓存与定时图](cache-policy.md#更新过程)。

```mermaid
sequenceDiagram
  participant U as WebUI / 冷读取
  participant H as 桌面后台 / 独立 Worker 调用
  participant L as library.refreshes
  participant P as sources / 插件
  participant DB as SQLite / D1
  U->>L: start 或 ensure
  L->>DB: 创建或复用操作、暂存身份
  L-->>U: operationId 与进度 / 待准备响应
  loop 每次 step 最多一页
    H->>L: step
    L->>DB: 核对代际、操作并取得短租约
    L->>P: 当前游标读取，事务外
    P-->>L: 有序条目、计数、下一游标
    alt 仍有下一页
      L->>DB: 条件追加、保存检查点并释放租约
    else 本目录完整成功
      L->>DB: 原子追加末页并切换发布指针
    else 来源限流或暂时失败
      L->>DB: 按原策略保存 retryAt，旧内容保留
    end
    L-->>H: 持久进度
  end
  opt 取消、替换或来源变化
    U->>L: 原操作取消 / 新操作 / 配置变化
    L->>DB: 终态或代际变化，迟到页不再满足提交条件
  end
```

任务终态不替代目录失败标记：A 失败后 B 成功，A 仍显示最近成功内容及失败原因；只有 A 成功发布才清除。刷新不改变用户布局。

## 当前目录属性读取

对应共用 FileView/DAV 合同。准确预留表示已有完整 `info`，因此目录/HEAD 不触发逐曲补标签；显式 `deferredInfo` 才进入文件准备。详见[刷新设计](refresh-performance.md)。

```mermaid
flowchart TD
  Request[PROPFIND 或 HEAD] --> Resolve[library 解析与发布身份核对]
  Resolve --> View[复用有界发布视图 失配才读快照与命名]
  View --> Props{本次请求哪些属性}
  Props -->|名称 类型标记 日期 propname| Light[直接生成属性]
  Props -->|大小 类型 ETag allprop| Many[一次 statMany 按来源戳分组]
  Many --> Info{条目描述状态}
  Info -->|完整 info| Ready[复用准确描述]
  Info -->|显式延迟且缺 info| Prepare[复用 file-info 任务 返回 503 与重试头]
  Info -->|旧插件缺 info| Legacy[仅缺失项实时 stat]
  Ready --> Check[返回前再核对来源戳]
  Legacy --> Check
  Check --> Response[有效项响应 变化来源明确报错]
```

单文件缺少 `info` 时可按需 stat，GET 随后继续 `open` 的身份与字节核验。WeakMap 的已列目标不进入 JSON；Worker 暖视图只加速，D1 发布身份仍是事实源，runtime 不保存旧请求 context 或音频流。

## 可选标签处理设计

核心不强制补标签。来源选择透传、自行补标签或选用共用工具，均输出相同的最终描述与读取合同。格式和预算限制见[音频标签设计](audio-tags.md)。

```mermaid
flowchart LR
  Source[来源插件] --> Pass[透传]
  Source --> Own[自带补标签]
  Source --> Tool[选用共用音频工具]
  Pass --> Final[最终 FileInfo 与 open]
  Own --> Final
  Tool --> Final
  Final --> Core[library 与 DAV]
```

网易云的预留表示是具体插件策略，QQ 保持分页精确准备；APE 不默认预留。目录发布不等待全库封面/歌词准备，首次读取固定该表示的计划。

```mermaid
sequenceDiagram
  participant L as library / DAV
  participant P as 网易云插件
  participant C as 实例缓存
  participant U as 来源 API / 原音频
  participant T as 可选音频工具
  L->>P: list 当前页
  P->>U: 批量名单、富详情及播放版本
  P->>C: 保存稳定 seed 与表示身份
  P-->>L: 准确最终 info，分页完整后发布
  Note over L,P: 目录与 HEAD 直接使用 info，不准备标签
  L->>P: GET open 期望身份与范围
  P->>C: 查询此表示的永久计划
  alt 首次读取
    P->>U: 仅该曲所缺资料、封面、歌词和结构范围
    P->>T: prepare，指定合法预留预算
    alt 满足预算
      T-->>P: 标签、紧凑填充及原音频区段
      P->>C: putIfAbsent 固定首次获胜计划
    else 超预算
      P->>C: 保存单曲精确表示
      P-->>L: content_changed，刷新后取得新描述
    end
  end
  opt 已取得同一表示的固定计划
    P->>T: open 固定计划与原音频范围读取
    T-->>L: 最终表示的准确 Range 与可取消流
  end
```

资料期限只影响未来刷新，不能改变旧公开引用的字节。原音频不转码，不为 M4A 整曲缓存；工具隐藏容器偏移和标签编码，平台认证与请求仍归插件。

## 音频读取与挂载缓存管理

| 入口 | 字节路径 | 缓存管理所有者 |
|---|---|---|
| 桌面直接 DAV | 对外 DAV → 共享 VFS → 缺失范围走内部原文件视图 | `desktop/read-cache` |
| App 本机挂载 | 每挂载 VFS → 内部原文件视图，绕过共享落盘 | `desktop/mounts` |
| App 远程挂载 | 每挂载 VFS → 远程 DAV，远端策略独立 | 本地 `mounts` 与远端各自管理 |
| Worker 直接 DAV | 共用 DAV → 原文件视图 → 来源流 | 当前无服务端磁盘正文缓存 |

[共享读取图](shared-read-cache.md#所有权与调用)说明身份及命中门禁，[挂载设计](desktop-mounts.md)说明正常卸载与定向清理。源服务排队、消费者实际读取及缓存实存分别计量；新范围或淘汰后仍可取源。

## 当前交互认证

凭据就绪即完成授权，补充资料由内容操作取得。取消先写终态，不等待旧轮询清理；退出保留实例配置和布局。

```mermaid
sequenceDiagram
  participant W as WebUI
  participant S as sources
  participant DB as SQLite / D1
  participant P as 来源插件
  W->>S: start
  S->>DB: 新操作与实例代际
  S->>P: start 当前配置与私有状态
  P-->>S: 公开步骤与候选私有状态
  S->>DB: 按操作、状态修订及代际条件接受
  S-->>W: 公开步骤，无私有状态
  alt 继续认证
    W->>S: poll / submit 操作及挑战 ID
    S->>P: 当前挑战与输入
    P-->>S: 下一步 / 凭据就绪 / 来源错误
    S->>DB: 条件保存，终态同时提交凭据并推进代际
    S-->>W: 当前结果
  else 取消或退出
    W->>S: cancel 操作 / logout 实例
    S->>DB: 先提交取消或清空授权，推进代际
    S->>P: 取消时尝试挑战清理
    Note over S,DB: 迟到结果不可写回，布局与配置保留
  end
```

## 当前按需会话续期

插件判断凭据渠道、期限及下次尝试，sources 只协调同实例的必要续期，普通内容操作不排入全局串行队列。

```mermaid
flowchart TD
  Request[来源调用] --> Needed[插件纯本地 needed]
  Needed -->|无需续期| Content[普通内容操作]
  Needed -->|需续期| Lease[条件领取短租约并预留状态修订]
  Lease -->|他人持有| Wait[可取消等待并重读状态或短期失败]
  Lease -->|取得| Renew[插件可取消 renew 事务外]
  Renew --> Save[条件保存结果并释放租约]
  Wait --> Result{当前续期结果}
  Save --> Result
  Result -->|成功| Content
  Result -->|失败| Error[明确来源错误]
```

## 插件变更

检查不执行代码；结构升级完整冻结输入、逐个准备候选，最后整体激活。无结构变化的桌面安装可立即完成；Worker 代码变更需后台发布。外部发布与数据库没有全局事务。

```mermaid
sequenceDiagram
  participant U as WebUI
  participant H as 宿主变更控制器
  participant C as application 迁移用例
  participant S as sources
  participant DB as SQLite / D1
  U->>H: 只读检查 ZIP / 地址，再安装
  H->>H: extensions 包合同、兼容与修订检查
  H->>DB: 保存操作，结构升级时冻结完整实例输入
  H->>H: 桌面加载候选 / Worker 发布并核对精确模块
  loop 结构升级，每步一个实例
    H->>C: 当前候选代码与操作
    C->>S: 转换并验证候选，事务外
    S-->>C: 规范配置与候选私有状态
    C->>DB: 条件暂存，不改活动数据
  end
  H->>C: 激活
  alt 安装代际及完整实例集合版本仍匹配
    C->>DB: 同事务切换安装、全部实例与 completed
  else 失败或冲突
    C->>DB: failed，保留原安装与活动数据
  end
  U->>H: 原 operationId 查询至终态
```

## 当前 Worker 插件发布

```mermaid
flowchart TD
  Pending[持久代码与上传意图] --> Live[读取实际 core registry modules]
  Live --> Upload[上传新旧必要修订 保留绑定与设置]
  Upload --> Verify[重读实际 registry 核对]
  Verify -->|匹配| Next[含精确候选模块的新调用接棒]
  Next --> Activate[共同迁移与条件激活]
  Verify -->|结果不明| Hold[保留旧安装 原操作继续核对]
  Hold --> Verify
  Verify -->|明确失败| Fail[失败 保留旧活动版本]
```

持久恢复与真实云端的证据范围分别见[插件迁移](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p2-plugin-migration.md)与[云端记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p4-worker-cloud.md)，不承诺零中断。

## 核心与共用页面升级

```mermaid
flowchart LR
  Button[官方部署按钮] --> Clone[用户仓库与自动创建的 D1]
  Clone --> Source[根配置与 build / deploy 命令]
  Source --> Detect{目标 Worker 已存在?}
  Detect -->|不存在| Initial[初始核心与随包插件]
  Detect -->|存在| Live
  Live[云端实际 registry 与插件模块] --> Assemble[新 core 与 WebUI 组装]
  Config[目标配置与绑定] --> Assemble
  Initial --> Output
  Assemble --> Output[独立目录与准确模块清单]
  Output --> Migrate[按 DB 绑定应用 D1 迁移]
  Migrate --> Deploy[Wrangler 部署并保留变量与 Secrets]
  Deploy --> Current[同一 Worker 与精确插件修订]
```

源码按钮入口读取 Cloudflare 已填写的根配置；可携带资源的发行包继续使用包内配置。两者复用同一核心构建与升级组装工具。仅远程 Worker 不存在时采用初始注册表；授权或网络错误直接返回。源码部署额外把随包插件 ZIP 放进静态资源，供浏览器安装；公开下载文件不代表已经在 D1 中激活。

操作以[Worker 部署说明](../worker.md)为准，升级前先完成正在进行的插件变更；只保留 D1 而覆盖可执行插件代码不能完成升级。

## 当前桌面生命周期

```mermaid
flowchart TD
  Launch[桌面 / headless / 前台启动] --> Identity{已有健康后台}
  Identity -->|是| Entry[按当前入口签发登录链接]
  Identity -->|否| Start[锁与独立后台 读取设置和凭据]
  Start --> Listen[SQLite 与资源装配 两个独立监听器就绪]
  Listen --> Entry
  Listen --> Restore[按偏好后台恢复挂载 有限重试]
  Listen --> Integration[启用桌面集成时异步启动托盘]
  Entry --> Feedback[桌面按偏好打开页面 / 终端打印访问方法]
  Feedback --> Quit[请求退出 暂停恢复与新增直接读取]
  Quit --> Unmount[正常卸载所有挂载]
  Unmount -->|失败| Resume[恢复接收与可操作后台]
  Unmount -->|成功| Accept[202 接受]
  Accept --> Close[停止共享服务 再退出 RC 和后台]
```

后台就绪不等待自动挂载或托盘完成；未使用的原生缓存进程按需启动。无桌面入口复用同一后台与登录会话，前台模式由外部服务管理器持有进程。关闭网页不卸载后台，退出登录也不退出服务。具体入口见[远程运行](../headless.md)，退出所有权见[桌面架构](desktop-mounts.md)和[共享读取](shared-read-cache.md#生命周期)。
