# 持久分页刷新

日期：2026-10-20。正式 `library.refreshes`、管理接口、共用页面、桌面后台及 Worker 调度均已接线；设计取舍见 [ADR 0007](../adr/0007-durable-paged-refresh.md)。这份记录验证刷新执行粒度，不替代真实 Cloudflare 免费计划或 DAV 大目录属性预算验收。

## 已实现的行为

开始刷新返回 `202 + operationId`，GET 只查询，POST step 至多读取一页插件内容。SQLite/D1 保存游标、累计计数及有序暂存行，末页完成后原子切换该目录的发布指针。原 beginRefresh/publishSnapshot/failRefresh 三个写入口及专用SQL已删除，旧 JSON 快照仍可读。失败继续保留旧目录；取消、替换、配置/插件变化使旧页的条件提交失效。普通冷读取复用已有活动任务，返回带原操作 ID 与 Retry-After 的 503；已有有效快照仍可直接读。

桌面后台启动及收到相关请求后续跑，页面关闭不取消任务；正常关闭中断本步并保留检查点。Worker 开始/冷读取可以安排一页 waitUntil，后续独立请求推进，模板每分钟 scheduled 调用提供一次慢速续步。step 的响应不再次安排后台页，防止一次请求实际读两页。页面展示暂存进度，完成后才使成功目录查询失效；其他调用正在执行时退让两秒。

## 自动化与正式宿主

- `bun run check` 完整通过，最终移除旧快照写入口后再执行 `bun test`：**142 pass、0 fail、1,338 断言**。三组严格类型通过，**131 模块/419 依赖**无越界；最终页面重试/恢复修正通过类型及浏览器验收，页面构建通过。Schema 分块约 558 kB 的既有构建提示仍在。
- [`tests/refresh.test.ts`](../../tests/refresh.test.ts)：42 页模拟 4,158 曲/1,913 文件，每页重建控制器；每 step 恰好一次 list，旧快照保留到末页，顺序和增量计数正确。另覆盖迟到取消/替换、冷读取复用、请求中断释放租约后续读。
- [`tests/refresh-persistence.test.ts`](../../tests/refresh-persistence.test.ts)：在真实 SQLite 与本地 Miniflare D1 执行共同 SQL，覆盖页追加/恢复、跨页出现身份重复、游标循环、租约接管、代际隔离及清理未发布候选。迁移测试从 schema 1–4 升级到 5，保留旧数据并能再次打开。
- `bun scripts/probe-worker-refresh.ts`：正式 `createWorkerService` 在本地 workerd/D1，经 **42 次独立 step** 完成 4,158 文件；每次一步、一次真实回环上游 HTTP。第 **21** 页销毁/重建 runtime 后恢复，前 41 页保留旧发布指针，末页才切换；逐行与正式 library 读取均核对 4,158 条顺序。每 step 最多 **15 条 SQL**，包含 waitUntil 启动的全部 HTTP 请求最多 **22 条**。计数为每次请求的 prepare 次数，batch 中每个 SQL 单算，不含样本建库及断言查询；并非云端账单/CPU 测量。
- 同一正式 Worker 探针另验证：start 的 waitUntil 只读一页，之后 step 只读一页且不安排额外页，GET 不推进。整个探针只使用本地专属来源插件，没有改全局 Fetch/crypto。
- `probe:worker:service`、`probe:worker:dav` 和 `probe:compiled` 通过：第五版迁移、独立模块/页面、冷目录准备、D1/编译桌面进程重启、HEAD 16,044、完整/范围字节沿用真实正式入口。缺发布凭据和坏插件初始化仍明确拒绝。

## 真实网易云与页面

安装 alpha.4 后沿用已有授权及多目标无损+标准/fallback 配置。正式页面开始喜欢目录刷新，10 页进度之后重载页面并中途重启后台，同一 operationId 恢复，最终 **42 页、4,158 曲、4,657 文件**完整发布。页面成功统计与数据库头一致；之后再开始并在第 1 页取消，最近完整目录和统计不变。重试按钮重新创建相同目录范围的任务，另以快速 sample 冷入口验证后台已完成时页面仍正确恢复；最终每日30曲/35文件也准备成功。未重复扫码，也未把分页写成来源专用核心分支。

新目录取得实际 FLAC 样本，正式 DAV 全文/范围字节及媒体格式核对通过；具体数字见[来源证据](p2-netease-source.md#alpha4-持久分页与真实-flac)。四目标发行目录已重建，最新 Linux 实际发行物经 `probe-desktop-product.ts --mount` 完成冷准备、外置插件、重复启动复用、FUSE 全文/五偏移、忙卸载保留与正常退出；其他目标原生运行仍待验。

## 边界与下一项

单页内部可能仍有多次来源请求或较多加密 CPU，不能把“一页”当作免费计划已经可用。DAV allprop 目前仍逐文件获得真实大小/内容身份，外部请求和 D1 都有 N+1 工作；这是下一切片。固定 QQ SDK 的批量结果未提供可承诺的精确大小及内容身份，不能用 size_* 提示伪造 FileInfo；应先落实可靠的列表元数据及受限准备方式，再测真实客户端。

真实 Cloudflare 账号目前缺失，用户明确先继续本地开发；真实免费 CPU/额度、Cron、绑定保留及云出口继续待验。Windows/macOS 原生运行、OpenList/普通播放器及完整来源策略仍按[台账](../verification.md)推进。

## 后续描述读取切片

API0.1.3的完整文件info现已随上述条目暂存和发布，未增加刷新阶段；正式workerd样本的4,158文件allprop为15条D1 SQL、0来源stat/外部请求。真实来源与CPU边界见[目录描述记录](p2-listing-metadata.md)。本页此前的逐项元数据缺口作为历史观察保留，不代表该路径仍未实现；云端CPU和普通客户端仍待验。
