# 共享音频读取缓存：现成能力与边界

查阅日期：2026-10-21。用于需求、成本与ROI决策，本轮不实现功能、不安装依赖、不请求音乐平台、不部署或测试云端。资料限于Cloudflare三份官方文档和四个维护方仓库；必要处只在线读取同仓库的短实现文件，没有下载源码到工作区。候选库尚未锁定发行版本，不能将当前分支调查当作兼容性验收。

本调查基线为dev.9：当时目录、资料与标签计划共用，App已有原生full缓存，直接DAV尚无服务端片段缓存。后续已在dev.11复用rclone服务端VFS，现行能力见[共享读取设计](../architecture/shared-read-cache.md)，选择与停止理由见[缓存决定](../planning/cache-optimization.md)。下文保留当时主源核查，不将旧建议或“尚未实测”措辞当成当前待办。

## 结论

没有发现可直接接入当前Web Stream链路、同时完成音频206片段复用、容量淘汰及双宿主持久化的现成替代品。应先区分普通HTTP响应缓存、字节存储和范围协调：三者各有可复用工具，不能把其中一个当作完整功能。

桌面若决定实现共享读取，`cacache`值得作为字节存储候选，仍需明确最小范围协调和容量策略；不是先引入通用HTTP缓存客户端。Worker Cache API适合可丢失的边缘加速，不能当跨机房持久文件库；原生支持的是“完整缓存对象上读取Range”，不是直接保存206响应。现有客户端缓存继续有效，不要求桌面与Worker使用同一后端。

## Worker Cache API

官方明确：`cache.put`不接受206响应；`cache.match`遇到Range时，可从匹配且带Content-Length的缓存对象返回206。缓存只在发起数据中心存在，不向其它机房复制，`put`不支持Tiered Cache；其Promise完成也不代表确实存入对象。Cache API在Worker内部调用，与可跳过Worker执行的Workers Caching是不同机制。[Cache API官方文档](https://developers.cloudflare.com/workers/runtime-apis/cache/)

**对本项目的推论：**

- 已有完整对象时可按Range复用，但为一次跳读主动下载整曲来填缓存，不符合本项目按需目标。
- 若只存已读块，需要把每块定义为具有独立内部键和准确长度的完整对象，再由MusicFS协调查块、缺块和拼接。可以技术上使用200存块；它不是原206的透明缓存，也不能把部分字节以200存到原完整文件键下。
- 使用Cache API只能减少命中时的来源读取；请求仍进入自己的Worker。不同机房、未命中或缓存未保留时，必须正常回源，不能依赖它保存不可变标签计划等正确性数据。
- 该官方页没有为项目承诺每块的保留时长或持久性，因此不能把TTL等同于保留保证。

免费约束仍需计入调用：Cache API每请求50次，与fetch共用额度；单对象上限512MB。Worker内存为每isolate128MB，客户端断开后`waitUntil`最多延长30秒，不能以它保证整曲后台下载完成。[Workers限制](https://developers.cloudflare.com/workers/platform/limits/)

免费计划包含每天100,000次请求、每次10ms CPU；定价页说明子请求不另按入站请求计费，数据出站/带宽不另收费。**推论：**缓存命中可以省来源往返和部分工作，但不能宣传为减少用户访问MusicFS的次数，也不能只依据带宽免费就忽略CPU及调用预算。本轮未核算真实账号成本或免费CPU是否通过。[Workers定价](https://developers.cloudflare.com/workers/platform/pricing/)

## HTTP缓存库能否直接处理206片段

| 候选 | 已核实能力 | 对本需求的结论 |
|---|---|---|
| `http-cache-semantics` | 计算HTTP新鲜度、重验证和可缓存性；body及实际缓存由调用方保存 | 不是字节缓存；当前官方实现明确不理解206及Range，不能作为片段合并实现 |
| `cacheable-request` | 包装Node.js原生HTTP/HTTPS请求，提供响应缓存、重验证和存储Adapter | 不直接适配现有Web Stream插件合同；README没有承诺片段索引、重叠范围合并或缺块填充，不能据“RFC缓存”认定本需求已解决 |
| `make-fetch-happen` | Node.js Fetch封装、磁盘HTTP缓存、连接及重试等 | 当前策略调用`http-cache-semantics.storable()`，没有绕开其206限制；不是片段缓存捷径 |

`http-cache-semantics`的README把策略对象和body存储分开；官方`index.js`的`understoodStatuses`排除206，重验证逻辑也说明不支持Range。这里不能只看“默认可缓存状态列表里有206”，因为真正的`storable()`还检查理解的状态集合。[官方README](https://github.com/kornelski/http-cache-semantics)、[官方实现](https://github.com/kornelski/http-cache-semantics/blob/master/index.js)

`cacheable-request`文档明确是Node.js请求包装器，默认内存缓存，可通过Keyv接存储；本轮没有进一步证明其内部对206的具体行为。缺少片段协调合同已经足以排除“接入即解决全部音频读取缓存”的判断，不据文档缺项推断它完全不能缓存任何媒体。[官方README](https://github.com/jaredwray/cacheable/tree/main/packages/cacheable-request)

`make-fetch-happen`文档要求消费响应body后才能形成缓存；只开始读取后取消，不等于拿到可复用的已读片段。其当前策略把响应状态传给`http-cache-semantics`，`storable()`直接委托该库。为此替换现有fetch，还会引入另一套Node流、重试和传输装配；本需求没有这项必要性。[官方README](https://github.com/npm/make-fetch-happen)、[官方策略实现](https://github.com/npm/make-fetch-happen/blob/main/lib/cache/policy.js)

## cacache的定位

`cacache`提供磁盘内容寻址、内容去重、完整性校验、元数据及流式读写。`get()`会整项载入内存，大数据应使用流式接口。`verify()`可按调用方filter移除索引并回收不再被索引引用的内容；单独删除索引不代表内容文件立即删除。[官方API](https://github.com/npm/cacache)

**不能默认认为它附带磁盘TTL和容量LRU。** 这份官方API没有按业务到期、总磁盘容量或最近访问顺序自动淘汰的合同；`opts.size`是单次数据长度校验，不是容量上限，`memoize`是内存复用，不是磁盘配额。因此它可仅作字节存储，但业务仍须拥有到期/容量决定、条目索引和必要回收调度。没有必要在当前资料调查中为此另建通用缓存管理系统；只有选定需求后才比较最小接线成本。[官方API与verify说明](https://github.com/npm/cacache)

## 对下一步决策的建议

| 方向 | 建议 | ROI依据与代价 |
|---|---|---|
| 复用现有目录、资料与标签缓存 | 保持；先确认现状确实命中 | 已跨DAV客户端复用，不需要重复实现 |
| App挂载原生full、播放器原生缓存 | 继续作为已有能力 | 用户端直接受益，不增加服务端字节生命周期；不承诺其它客户端已自动具备 |
| 桌面共享已读字节 | 可列为有条件高ROI候选 | 真实重复读取或多个客户端可共同受益；还须承担范围协调、有限磁盘使用及取消语义，不是换一个fetch包即可完成 |
| Worker直接缓存原206 | 不选 | 官方API明确不接受；改几个HTTP头不能补上缺块和版本协调 |
| Worker内部完整块对象 | 仅在共享语义稳定后做有界评估 | 可复用原生Cache API，但多机房未命中和调用预算降低收益；不能默认要求额外存储产品 |
| 为首次小Range下载整曲 | 不作默认 | 用更大首次流量换未来命中，与按需和减少无用平台请求的目标冲突 |

当前可执行的规划动作是：先确认共享读取要服务哪些直接DAV客户端、希望重用哪些读取，再决定是否值得接桌面字节存储。若决定进入实现，仅用一个有界离线垂直样本判定相同及重叠范围、取消后重读、文件版本变化和容量回收是否符合合同；它们对应本功能真实责任，不恢复高并发或平台矩阵。Worker不因追求形式统一而先增加持久音频库。

## 未确定项与停止边界

- 没有安装或实测候选库，Bun/Windows编译发行物和Web Stream转换尚未验；选型时需固定实际版本。
- 没有测MusicFS直接DAV的真实重复字节比例，不能给出命中率、节省金额或承诺耗时；当前研究只能判定依赖能负责哪一层。
- 没有实际部署Cache API；当前部署域名的可用性、区域命中与真实免费CPU须在确有实施必要时做最小验收。
- 未实现Worker块对象包装，也未证明它比客户端缓存或桌面方案更划算；不预设必须采用R2/KV/付费套餐。

七个主源范围已足以排除“HTTP缓存库直接替换”及“206直接写Worker Cache”两条误判，本轮到此停止，不扩展依赖、源码下载或许可证闭包调查。
