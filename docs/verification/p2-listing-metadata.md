# 目录文件描述与批量属性读取

日期：2026-10-20。范围：公开 API 0.1.3、sample 0.1.1、网易云 alpha.5、QQ alpha.7。此前版本的真实证据保留原版本；本记录没有替代云端或目标系统验收。

## 正式路径与职责

插件在已有 `list` 分页中可返回完整 `Entry.info`（内容身份、精确字节数、媒体类型）；核心校验后随条目暂存，末页原子发布。不新增元数据任务、队列或独立刷新阶段。网易云复用已取得的实际表示；QQ 复用原生 SDK 音质解析与获胜 CDN 的 `bytes=0-0` 响应，不能用歌曲 `size_*` 提示冒充真实描述。

DAV 只在请求内容属性时懒调用一次 `FileView.statMany`，按来源戳批量前后核对，使用已发布 info；缺 info 的旧插件保留实时 stat，不能据此获得大目录预算保证。单文件 HEAD/GET 仍实时 stat，打开时另核对实际字节/版本。内容描述字段顺序固定后生成 ETag，准备和实时路径一致。流程见[图表](../architecture/diagrams.md#当前目录属性读取)。

QQ 每页最多准备六个实际文件，以目标音质数调整歌曲出现位置数。保留四加五候选 CDN 策略；目录调用的 SDK 重试为零、注入宿主 Fetch/取消、CDN 不自动转址，45 次应用请求护栏超限时整页临时失败，保留最近完整快照。故障候选全失败时仍可能达不到准备出口，不承诺全部条件下必然完成。

## 本地正式 Worker/D1 的大目录

命令：`bun scripts/probe-worker-refresh.ts`。实际打包正式 Worker service，由本地 workerd 执行，共同 SQLite/D1 SQL，42 页独立 HTTP、重启续接及一次完整发布。样本插件在页面返回已知完整文件描述，非真实音乐来源。

- 4,158 文件 `Depth: 1` allprop：207，精确大小属性完整，**15 条 D1 SQL、0 次插件 stat、0 次外部请求**。
- 刷新每 step 最多 15 条 SQL；包括后台启动的所有请求最多 22 条 SQL。保留原 21 页重启续接与 waitUntil 终止的检查。
- 这证明该路径不再逐文件做数据库/来源读取；没有测得 Cloudflare 计费 CPU、免费部署可用性或所有插件的页预算。

## 真实账号与媒体

通过正式本地 `/api/plugins` 兼容更新，使用已授权实例，不重新扫码或改动用户布局。

| 路径 | 本次实际结果 |
|---|---|
| 网易云 alpha.5 每日，无损+标准/fallback | 1 页、30 曲、35 文件；35/35 均持久保存完整 info；12 曲隐藏、24 缺失、18 回退、1 合并，与前版实际结果一致 |
| QQ alpha.7 微信每日，默认128k/hide | 5 页、30 曲、2 文件；2/2 均保存真实 info，分别 5,215,076 / 3,624,750 字节；28 曲按无完整地址隐藏 |
| 网易云正式 DAV | 首次插件更新使 roots 失效，503 指向已有准备操作；按正常管理流程完成后 allprop 207/35 文件，单文件 HEAD 200 的 ETag 与发布值一致；If-Range 读取 1,024 字节得到206 |
| rclone v1.75.2 | 正式DAV已准备每日目录的35个文件均可列出且大小大于零；未重复整个大集合或媒体全文下载 |
| QQ alpha.7 实际包、本地 workerd/D1 | 恢复同一真实微信会话：每日2文件、自建1歌单、收藏0歌单、推荐25歌单；128k+M4A多目标发布4文件，30曲/28隐藏/56缺失计数持久一致；不启用 Node 兼容 |

QQ 本地 workerd 命令沿用 `probe:worker:qq`，仅显式选择开发数据库和已授权实例；没有云端扫码或发布。目录真实元数据来自实际媒体探测，既有真实媒体字节记录不自动变成本版本所有格式/客户端已验。本轮不重复下载此前已验证的整份 FLAC 或重刷 4,158 曲。

## CPU 与依赖的有界复核

新增 `bun scripts/probe-dav-resources.ts --output /tmp/musicfs-dav-resources.json` 隔离纯 XML 工作：1/100/4,657 文件、轻量属性/allprop，准备好的描述、0 网络/DB，记录耗时、进程 CPU、heap/RSS 增量及输出大小。内存增量不是峰值，进程 CPU 也不是 Worker 计费 CPU。

本次一轮 4,657 allprop 为 2,246,466 字节，约78ms墙钟/138ms进程CPU。限定原型另比较官方推荐的 `fast-xml-builder 1.3.1`：五次中位墙钟约44—45ms，现 DOM 约79—81ms；语义对照、browser目标和无Node兼容的本地workerd执行通过，但仍是数十毫秒。收益包括属性投影方式变化，不能全部归因于依赖本身。原型和原始结果只留 `/tmp`。

决定：本轮继续 `@xmldom/xmldom`，不增加根依赖、手写转义器或 XML 缓存框架。先验普通客户端旅程与真实免费环境，再根据测量调整表示/序列化边界。官方建议见 [fast-xml-parser README](https://github.com/NaturalIntelligence/fast-xml-parser#before-using-this-library)。

后续正式热点采样和同一xmldom内的请求投影/命名/SQL减法见[读取CPU记录](p2-read-cpu.md)；上面的数字保留本检查点，不将局部改善改写为免费云端已验。

## 未完成出口

普通客户端不会推进管理任务。来源内容准备、503/重试提示、OpenList/播放器冷目录到播放/拖动的完整体验仍需实测；连接页已补现有准备入口说明，没有增加另一套任务 UI。

Cloudflare Free 当前 HTTP/Cron 为10ms CPU、50外部子请求；D1另有每次调用50查询限制，waitUntil在响应后最多延长30秒。上述本地查询结果不能证明真实免费路线通过：[Workers限额](https://developers.cloudflare.com/workers/platform/limits/)、[D1限额](https://developers.cloudflare.com/d1/platform/limits/)。QQ认证/roots的剩余facade取消、来源会话续期及完整示例，仍按总台账继续。

## 本轮包与集成检查

155项测试/1,788次断言通过，三组TypeScript及134模块/434依赖边界通过；共用WebUI构建通过。四目标桌面和包含三个示例插件的正式Worker bundle统一重建；最终Linux发行物的实际FUSE样本全文、五次偏移、忙卸载保留、重复启动和正常退出再次通过（16,044字节WAV）；其余交叉编译与真实云端/目标系统分别记录。当前插件包：

| 包 | 字节 | SHA-256 |
|---|---:|---|
| sample 0.1.1 | 3,913 | `72ad8c81bbaf7b9b03a933158d9366192ecaaeda3d0250531237398055796a50` |
| QQ alpha.7 | 132,814 | `bf46390848c4701f413bd059b7263809121ba46346606b3f7ae2386cae542fe9` |
| 网易云 alpha.5 | 245,632 | `12868fcaf82bcb0df16e8f8dbfb5d23d52f31deca03171ac498e9fc30b74c7f6` |
