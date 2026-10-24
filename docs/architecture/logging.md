# 日志与 IO 诊断

[English](../en/logging.md)

日志用于解释 WebDAV 访问和核心上下游 IO：播放器请求是否到达、耗时发生在哪一层、缓存是否请求来源字节、音频在何处中断。持久刷新和插件任务仍以已有操作记录为准，日志不建立另一套任务数据库。

## 位置与默认行为

| 范围 | 位置 | 默认记录 |
|---|---|---|
| 桌面应用 | 数据目录 `logs/musicfs.log` | 默认 info：启动、配置及刷新终态；2 MiB 轮转，保留 3 份备份 |
| rclone 挂载及远程 WebDAV | 数据目录 `mounts/rclone.log` | 原生 JSON ERROR 日志，2 MiB 轮转，保留 3 份备份 |
| 进程启动失败 | 原有 `startup.log`、`launcher.log` | 启动器提示、运行时崩溃输出；与应用 IO 日志分开 |
| Worker | Cloudflare Worker 的 Observability | 应用警告、错误和未捕获异常；模板关闭逐次调用日志和 traces |

桌面在「设置 → 日志与诊断」分别调整应用和挂载/缓存日志，立即生效并保存，无需退出后台或重新挂载。应用默认 `info`，正常访问仍只在 `debug` 记录；rclone 默认 `ERROR`。rclone 使用官方 `options/set` 更新已有进程，尚未使用时只保存设置，不为日志启动原生服务。

复现问题前选择「详细」，之后点击「下载日志」。ZIP 包含应用、MusicFS 管理的 rclone、启动器日志及版本、构建修订、进程号、启动时间和实际设置摘要；不包含账号配置、数据库或授权状态。应用及 rclone 各取当前日志与最多三份备份，每个文件最多取末尾 2 MiB，摘要标明截取项。

无已保存设置时，桌面仍可通过 `MUSICFS_LOG_LEVEL` 选择启动级别；页面保存的设置在后续启动优先使用。Worker 继续通过同名运行变量配置，未设置时为 `warning`，在 Cloudflare 修改变量后部署生效；不新增 D1 配置轮询或云端日志存储。

源码开发服务复用相同日志装配。文件日志不可写时回退到进程输出，不让诊断功能阻塞服务启动。

IO 类别按事件、错误代码、来源故障及处理阶段区分，同类记录每分钟最多保留 20 条，超出部分由 LogTape 汇总被抑制数量；最多追踪 128 种事件键。正常请求只在 debug 记录，不逐歌曲、逐 SQL、逐音频块写日志。请求计时表示响应头就绪，音频流计时才表示消费结束，二者不互相替代。

## 关联链路

```mermaid
flowchart LR
  Client[播放器 / 挂载] --> DAV[WebDAV 请求 ID]
  DAV --> Library[目录与文件视图]
  Library --> Source[来源操作与实例 ID]
  Source --> Fetch[来源 API / 媒体连接]
  DAV --> Cache[桌面共享缓存]
  Cache --> Native[rclone VFS]
  Native --> Back[内部 DAV 与资源键]
  Back --> Library
  DAV --> End[完成 / 取消 / 流中断与字节数]
```

Hono 负责请求 ID，LogTape 的异步上下文关联同一次调用内的来源操作和上游连接。共享缓存跨原生进程后以不可变资源键辅助关联。`source`、`cache`、`rclone`、`dav` 类别区分平台请求、本机缓存连接、挂载控制和对播放器的输出。

缓存链路记录 `native` 或 `bypass`，内部回源事件表示缓存确实请求了来源字节；不把“经过 VFS”伪称为缓存命中。命中率和原生缓存容量仍查询 rclone 已有状态接口，不为日志追加查询。

DAV 的 5xx 默认记录，包括等待文件准备的 503。记录中带请求 ID、HTTP 方法、Range、发生阶段和可用的准备任务编号；正常等待使用独立事件，不挤占其它故障的样本。

来源操作同时观察 HTTP 连接与插件返回结果。即使上游 HTTP 为 200，插件返回限流、认证或暂时故障时也记录其类型和冷却时间；后台刷新记录终态和失败摘要，详细模式增加检查点。

音频流只在 EOF、取消或错误时记录一次结果，包含预期/实际字节、读取范围、内容身份、耗时及末次数据间隔；区分提前 EOF、流错误和请求/消费者取消。背压和取消继续传递，正常 seek 取消不作为警告，超时仍记为警告。HTTP 500 返回可复制的错误编号，重复事件按 IO 类别限量。

## 职责与依赖

采用 [LogTape](https://logtape.org/manual/start) 管理级别、上下文、结构化记录和高频限量；桌面轮转交给 `@logtape/file`，rclone 使用自身轮转参数。它支持 Bun 与边缘运行时，核心包没有传递依赖，避免为 Worker 引入桌面文件日志或另外一套日志实现。Pino、Winston 更适合已有 Node 日志栈的项目，本项目优先统一两宿主。

桌面诊断控制器拥有日志输出和 `diagnostics.json`，通过 LogTape 过滤器和 rclone 控制口应用级别；配置不进入音乐核心、来源设置或音频缓存身份。

日志装配归宿主，采集归传输和 IO 适配边界。领域层不导入日志库；来源异常使用标准 Error cause 保留诊断关系，面向用户的错误语义不变。不会读取响应正文来记录日志，也不会因为观测产生额外平台请求。

应用日志选择请求/操作 ID、路由模板、状态、耗时、字节数、错误类型/代码与栈位置；不传入完整 URL、查询参数、凭据、Cookie、请求正文、音乐路径或原始上游错误消息。原生工具日志由工具管理，公开问题记录只保留必要且去标识的信息。

Cloudflare 默认记录应用事件、关闭每次访问的 invocation log，减少扫描和 Range 请求的记录量；没有额外日志服务、Tail Worker 或日志数据库。现有部署自定义配置继续保留。[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、[rclone 日志](https://rclone.org/docs/#logging)
