# 大目录读取的重复工作与本地 CPU 定位

日期：2026-10-20。基线提交0470174；Linux x86_64、Bun1.4.3、Nodev24.19.0、Miniflare4.20260730.0/本地workerd。范围是已有完整快照的目录读取，不改来源功能、路径、ETag算法、数据库schema或公开插件合同。真实Cloudflare免费计划仍待验。

## 发现与取舍

先前15条D1查询、0逐文件来源请求已解决网络/查询数量；仍然存在随条目数增长的CPU和结果转换。正式createWorkerService在真实本地D1发布4,158条后，对一次allprop取得V8采样：热点同时包含D1 toJson、DOM构造/序列化、属性投影、逐文件digest及垃圾回收。只更换XML构建器不能解决整条路径，已做过的fast-xml-builder比较不重复展开。

本次减掉四类重复工作：

- DAV在每次请求按文件/目录编译已知与缺失属性组、元数据需求；按字段读取值，不再为每个属性创建完整字段映射。共享相同快照日期的UTC表示，仅在本响应内存在；XML节点、命名空间和转义继续由xmldom完成。
- 唯一文件名走快速返回；同一批只计算一次折叠名称，只有实际冲突项才创建散列Promise，保留原来的冲突扩展与重排稳定性。portableName继续使用sanitize-filename。
- 一次statMany中复用同一来源戳的分组字符串；实例代际/安装代际仍按原合同在整批前后检查。
- 快照仍用一个SQL读取，只有首行携带快照头，后续行仅该列为空；不把相同头重复传回成千上万次。完整顺序、空目录和旧内嵌JSON快照保持同一读回方式，没有增加查询或持久缓存。

来源规则留在插件，命名与描述归library，SQL投影归持久Adapter，XML投影归DAV。没有增加依赖、通用缓存、任务、仓储或新的协议表示。

## 可复现入口与口径

```sh
bun run check
bun scripts/probe-dav-resources.ts --output /tmp/musicfs-dav-resources.json
bun scripts/probe-worker-refresh.ts --cpu-profile /tmp/musicfs-dav-worker.cpuprofile
```

最后一个命令先通过正式管理路由完成42页、重启续接及完整发布，再只对准备后的DAV allprop采样；结束清理临时D1/进程。`.cpuprofile`可用DevTools查看，终端输出采样窗口、样本数和热点。默认不传该参数时不开Inspector。实现只在开发脚本，产品没有调试端口。

官方说明本地DevTools用于CPU定位，生产计时器有I/O粒度限制，云端可以另取生产profile：[Cloudflare CPU profiling](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/)。本地V8采样不是计费CPU，包含idle/program/GC和采样开销；不能把窗口总时长或某个热点样本直接当作一次云请求的CPU配额。Bun进程CPU还包含运行时线程，heap/RSS增量不代表峰值。

## 已有证据

独立微测中，4,657条带完整info、仿真实引用长度的夹具选中行JSON从4,007,461降至2,624,629字节，减少约34.5%；SQLite选取/解析约8.24→6.21ms。唯一名称约9.44→5.53ms。它们说明重复数据/工作确已减少，不是D1或云端耗时。

同一xmldom原型在两个独立Bun进程、各7次温热交替中，4,657文件names中位墙钟38.8—40.2→27.2—28.5ms，allprop69.0—71.8→46.8—51.2ms，输出逐字节相等。进程CPU波动较大，不据此宣称Worker CPU等比例下降。原始临时结果位于 `/tmp/musicfs-xml-projection-prototype/`，正式源码和上面的命令可重跑，不依赖该目录。

最新完整检查 **215 pass、0 fail、2,592次断言**，三组类型与 **153模块/545依赖**边界通过。回归复用已有DAV/命名/刷新覆盖，新增一项混合资源属性投影及SQLite/D1各一项快照头/空目录/旧JSON读回；没有用计时阈值作为测试成功条件。

在其他检查及子代理测量结束后，分别使用0470174的四个原始模块和当前模块，串行重跑正式workerd探针。一次allprop的采样窗口为184.91→152.08ms（139→111样本），包含idle及GC，不能按差值推导计费CPU降幅。原来的value映射不再出现为热点；当前仍可见digest、DOM和GC。完整响应仍有4,159个资源、4,158个精确文件大小，15条D1、0来源stat、0外部请求；42页/第21页重启/末页原子切换和后台单步均通过。

最后空闲宿主的纯XML一轮，4,657文件names/allprop墙钟34.41/49.16ms，字节仍为1,334,710/2,246,466。该夹具不包含D1或真实来源；前后原始profile在 `/tmp/musicfs-dav-worker-before-final.cpuprofile`、`/tmp/musicfs-dav-worker-after-final.cpuprofile`，文件不进入Git。

代码冻结后重建Linux发行物与含三个插件/18模块/七份迁移的Worker包。Linux二进制SHA-256为 `f0c2e9b84e92badad308317fd667f0a1a3a99f348643b7bb88f8739309d8dae7`；实际发行物的页面、外置sample、16,044字节HEAD、RIFF范围、后台复用和正常退出通过，本轮未重复FUSE。开发8787服务已恢复新代码，schema仍为7；重启前后4条安装、6个实例及布局的逐行摘要相同。其他目标系统、真实账号媒体矩阵和云端没有因此补齐。

## 尚未收口

当前仍为每个文件派生ETag、构造整份XML，D1也要转换完整结果。即使无来源请求，已观察成本仍明显，不能把本次局部减法标成免费Worker已通过。已完成一次ETag预存的临时原型取舍，本轮暂缓持久化改动，不先新增独立元数据任务或缓存平台。

真实免费部署、D1/Secrets/静态资源保留、云出口、在途切换和目标系统证据保持原验收义务。用户目前没有Cloudflare账号；继续可执行的本地工作，不改变免费优先路线或交付标准。

### ETag预存候选：本轮暂缓

单一临时原型仅在Bun加载library时注入已算好的标签，未覆盖全局crypto、未改产品或schema；2次温热、5次测量。4,657文件statMany墙钟中位424.465→1.429ms，进程CPU456.396→2.750ms；完整Description逐字节一致，单文件实时内容变化仍重新计算。但结果排除了预计算与实际D1转换成本，行JSON增加344,618字节（约12.8%）。正式Worker采样中digest仅为部分热点，不能用Bun倍率推断云端净收益或10ms预算已满足。

因此本轮保持schema7、原ETag算法和原读取合同；先闭合已发现的FR22用户旅程及发行交付。后续有真实云端或端到端证据指向此项时再决定，不因局部倍率永久增加字段和序号对齐合同。临时原型及报告为`/tmp/musicfs-etag-single-candidate.ts`、`/tmp/musicfs-etag-single-candidate.json`，不作为产品依赖或最终验收。
