# 音频自动携带音乐资料：可行性验证

日期：2026-10-21（北京时间）。本轮是有限的离线技术验证，未接入产品、改动发行物或访问音乐平台/Cloudflare 账号。

这是产品实现前的历史实验记录。后续已完成四格式区段读取、M4A 无整曲缓冲方案、SQLite/D1 缓存及两个示例插件接线，当前状态以[实现记录](metadata-implementation.md)为准；下文的“尚未完成”只描述当时检查点。

## 用户目标与验证问题

读取音频时自动携带基础音乐资料、封面、原文歌词及来源已有译文/罗马音；有时间轴则保留，不转码。只在不可行或成本过高时比较伴随文件等替代方案。由来源插件决定补充方式，核心沿用最终文件协议，不增加通用资料合并系统。

本轮回答两个问题：现成库是否能正确写入这些信息且保持声音数据；能否在两个宿主中实现，并避免为了标签先取得整首音频。

## 已取得的证据

环境：Bun 1.4.3、FFmpeg 8.0.1、music-metadata 12.2.3、Miniflare 4.20260730.0／实际 workerd 1.20260730.1。MP3/FLAC/M4A 使用约一秒合成音和微小 PNG；APE 使用标签库官方 395,624 字节测试样本。独立解析写后标签，MP3/FLAC/M4A 以 `ffmpeg -c:a copy` 的音频 payload SHA-256 比较前后数据；APE 使用原编码媒体区段逐字节比较及解码 PCM 哈希，原因见下文。未做压力测试、随机用例或反复平台取流。

| 路线 | Bun | 实际 workerd | 需要整首音频吗 |
|---|---|---|---|
| taglib-wasm 2.4.0 通用写入 | MP3、FLAC、M4A 已通过 | 当前发布包未通过 | 本次 buffer 路径需要 |
| browser-id3-writer 6.4.0 生成 MP3 标签前缀，再映射原音频区段 | 已通过 | 已通过 | Worker 无需整曲缓冲 |
| node-taglib-sharp 6.0.3 通用内存文件 | FLAC、M4A、APE 通过 | MP3 及新增 FLAC、M4A、APE 通过 | 本次通用保存路径需要 |

## 以来源为准的格式范围

| 来源 | 本轮范围 | 已有来源证据 |
|---|---|---|
| QQ | MP3、M4A、FLAC、APE | 固定 SDK 有四种原生映射，APE 还按 `size_ape` 判断文件存在；MP3/M4A 有真实字节证据，QQ FLAC/APE 尚无真实可读样本 |
| 网易云 | MP3、FLAC、M4A | MP3/FLAC 已有真实字节；两次真实目录均有一个 M4A，但该 M4A 未作完整字节验收；不增加 APE |

依据：[QQ 音质/字节记录](p2-qq-quality.md)、[网易云来源记录](p2-netease-source.md)、[后续目录记录](p2-clients.md)，以及固定 SDK 的 `services/auth/playback.js`、`protocol/qualityFile.js` 与当前[网易云类型处理](../../plugins/netease/media.ts)。这区分了上游实现、真实目录观察和完整字节验证；某账号或某曲缺少某档位，不能推导平台完全不支持。

不因标签库支持就增加 WAV、OGG、Opus、DSD 等范围，也不为某来源没有的格式增加适配。这是本次示例插件的验证范围，不是核心或第三方插件的格式白名单。sample 的 WAV 挂载验证与本轮补标签范围不同。

### 通用 Wasm 库

三种格式均独立读回歌名、两位歌手、专辑、专辑艺术家、完整日期、曲号/碟号、封面和歌词；音频 payload 哈希全部保持不变。MP3 中 LRC 原样保存在 USLT；FLAC、M4A 的读回解析得到 0/500 ms 两个同步点。标签能携带时间信息，不等于已证明某播放器会逐行滚动。

原样 Worker loader 先因 Node 路径初始化失败；最多两次小范围加载适配后，最终在 Embind 的 `new Function` 处报 `Code generation from strings disallowed for this context`。停止继续改库，不以官方平台支持声明代替实际运行结果，也不为了该候选增加运行时放权或维护一套 Wasm 构建。

约一秒样本的单次写入墙钟：MP3 12.38 ms、FLAC 3.62 ms、M4A 4.53 ms，初始化 27.93 ms。这里只证明功能可运行，不能外推整曲首播时间、Worker 计费 CPU 或峰值内存。该首轮未验证 APE；后续仅取一个官方小样本做下述纯 TypeScript 路线验证，未扩大 Wasm 候选调查。

### MP3 标签前缀与流式读取

库从空 buffer 生成 736 字节 ID3v2.3 标签。原文件 17,208 字节，旧前缀 73 字节，新文件 17,871 字节，其余原始区段逐字节透传。来源资料与 10 字节 ID3 头已知后，最终大小可以直接计算，不需要先下载整首文件。

workerd 实际通过：

- 基础字段、多歌手、封面、三个歌词版本和 SYLT 两个时间点的独立解析读回。
- HEAD 与完整流的大小一致。
- 标签内部、标签/音频边界、音频中段三个 Range 与独立构造的预期文件切片一致。
- 音频 payload 哈希不变；Bun 与 workerd 生成的文件相同。

库负责标签序列化；实验增加约 39 行格式/偏移逻辑和 39 行临时 Worker。生产可以复用既有 DAV 范围解析与 `FixedLengthStream`，但仍需正确形成最终 `contentId`，并接入来源资料。这不是插件已经完成的证据。

该库写入 ID3v2.3 的 `TYER` 和 `TDAT`；完整年月日存在于原生标签，但 music-metadata 的统一字段只显示年份。具体播放器的日期与歌词同步展示尚待消费端检查。该实验只覆盖 MP3，不推广到 FLAC、M4A、APE。

### 纯 TypeScript 通用备选

`node-taglib-sharp 6.0.3` 的公开 `File.createFromAbstraction()` 加小型同步内存流，在实际 workerd 中写入一个既有合成 MP3，独立读回基础字段、双歌手、专辑艺术家、年份、曲号/碟号、封面、LRC 全文；音频 payload 哈希保持不变。文件 17,179 → 18,687 字节。

该次正常调用使用 `nodejs_compat` 及标准 `createRequire` 打包包装，不需修补 Wasm 或实现格式算法。整库未压缩模块约 1.12 MB，单次 dispatch 墙钟 11.27 ms；仍不代表整曲 CPU 或峰值内存。

其同步 `IStream` 支持 read/write/seek/setLength，不能直接 await 远端 Range，所以这次通用保存成功仍属于完整文件路径。另核实包公开了 `Id3v2Tag.fromEmpty()`、`render().toByteArray()` 及单帧 render 接口，可独立生成小标签，并提供 ID3v2.4 日期相关帧。这为复用同一个库生成 MP3 前缀提供依据，但尚未用它替换前述 browser-id3-writer 实验，不能将两个独立结果合并成已完成的产品实现。

上述是首个 MP3 探针的范围。随后按来源格式补做了下述有限验证；没有重新跑已有 MP3 全矩阵，实际播放器同步展示仍未验收。

### 来源范围内的后续格式验证

FLAC、M4A 各复用一个合成文件，在 Bun 和实际 workerd 中调用同一份 `node-taglib-sharp 6.0.3` 处理代码；独立读回歌名、两位歌手、专辑、专辑艺术家、完整 `2026-10-21`、曲号/碟号、PNG 封面、LRC 的 0/500 ms 两个同步点。四次输出的音频 payload 哈希均与原文件相同。

M4A 的通用 `performers` setter 首次把两个歌手拼成一个字符串。一次定向调整改用库公开的 `AppleTag.setQuickTimeData()`，写两个 UTF-8 data box 后，独立解析得到两个歌手；没有修改库或重写 MP4 编码。完整日期分别由 Xiph `DATE`、Apple `©day` 现成接口设置。

FLAC 另用公开 `XiphComment.render()`、`XiphPicture.renderForFlacBlock()`、`FlacBlock.render()` 生成 490 字节元数据前缀，替换原 8,286 字节元数据；后面的 12,353 字节原音频区段逐字节相同，资料读回与音频哈希通过。这证明可单独生成小区段，不是已经完成远端 Range 接线。

APE 仅下载[库官方测试样本](https://github.com/benrr101/node-taglib-sharp/blob/master/test-integration/resources/samples/sample.ape)，395,624 字节，Git blob `7561c36f656537bee7612af777133737b131b4d2`，SHA-256 `9ee4a87b86768890413b5dc97661b2e9b61961342b91e87d5b69760e55a88cad`；不下载源码仓库，不访问音乐平台，不加入产品或发行包。Bun、实际 workerd 的通用改写，以及单独 `ApeTag.render()` 生成 467 字节尾标签，均独立读回上述字段及时间轴。原编码媒体区段 `[0,395220)` 在三份输出中逐字节相同，区段 SHA-256 与解码 PCM SHA-256 也相同。

APE 首次探针有可写 buffer 被原地修改后继续复用的试验污染，显式复制输入后修正，未修改标签库。该样本的 FFmpeg stream-copy hash 仍随尾标签变化，不能把它当作音频修改的证据或写成通过；ffprobe 末 packet 恰增加与文件增长相同的 296 字节，支持其包含尾标签的推断。此处以原媒体区段直接字节比较和 PCM 哈希为证据，原失败记录保留于结果文件。

| 格式 | 补标签能力证据 | 无整曲缓存的进展 | 尚未证明 |
|---|---|---|---|
| MP3 | 既有 Bun/workerd 前缀试验通过；纯 TS 库 Worker 内存写入通过 | 远端范围映射、跨前缀 Range 已通过 | 统一库替换及真实插件生产接线；播放器同步展示 |
| FLAC | Bun/workerd 基础字段、完整日期、封面与时间歌词通过 | 单独元数据块生成、音频区段保持通过 | 远端 Range 接线及整曲成本 |
| APE | Bun/workerd 同类字段通过 | 独立尾标签生成、原媒体区段保持通过 | QQ 真实来源文件、远端尾部探测/Range 接线及整曲成本 |
| M4A | Bun/workerd 同类字段通过 | 目前仍是整文件 buffer 改写 | 容器区段/偏移适配、适合 Worker 的实际成本 |

新增三个格式只验证原文时间歌词，不宣称译文/罗马音映射或客户端表现均已验收。MP3 先前已有三个歌词版本的写入证据。所有格式都未做整曲 CPU、峰值内存或播放器矩阵；不能把小文件可运行外推为 Worker 大文件可用。

## 方案比较与当前结论

MP3 已证明有不转码、不缓存整曲的可行路线；FLAC、APE 的小标签区段生成也有直接证据，暂不需要因此引入整曲缓存或新云存储。纯 TypeScript 库在 Worker 写入来源范围内的格式已取得有限证据，但 M4A 仍需整文件 buffer，不能与流式可用混为一谈。通用 Wasm 包的 Worker 失败不扩大成格式本身不可行。

纯 TypeScript 通用备选已经证明 Worker 可以使用现成多格式库的 MP3 写入能力；没有理由因 Wasm 包失败就立即实现自有格式编辑器。后续应优先评估复用该库的标签序列化与少量文件组合逻辑，避免长期维护两套 MP3 标签库。

| 候选交付路线 | 功能与成本判断 | 仍需解决 |
|---|---|---|
| 按需内嵌标签、音频区段透传 | MP3 已证明无需整曲缓存，符合优先目标 | 统一候选库的实际接线及其他格式的可用方案 |
| 整曲处理后提供最终文件 | 更容易复用通用库；需等待取得音频，内存/临时文件成本随文件增长 | 其他格式验证、实际文件规模的成本边界；不能默认新增云存储 |
| 原音频加伴随文件 | 可减少音频变换，但客户端必须读取外置资料，基础标签不足的问题仍可能存在 | 只有前两项不可行或成本过高时，才作为用户效果不同的备选比较 |

当前没有充分数据量化整曲首播延迟、峰值内存或付费账号月成本，不给出数字承诺。标签解析通过本身不等于所有播放器表现一致。

## 已确认的生产接线问题：资料何时准备

此次对现有代码的有限核对发现，比标签生成 CPU 更早需要收敛的是目录读取成本：

- 插件 `Entry.info` 可省略；提供时必须描述最终字节，不能继续使用未补标签的旧大小和内容身份。
- 通常的 PROPFIND Depth1 `allprop` 需要每个子文件的完整描述；DAV 调用 `statMany(entries)`，缺少 `info` 时逐项调用插件 `stat`。代码见 [DAV 接线](../../src/transport/dav/index.ts)、[批量描述回退](../../src/core/library/index.ts)。
- HEAD/GET 同样先取得文件描述再计算长度、范围，GET 随后才调用 `open`；最终返回信息不一致会被既有合同拒绝。

因此，将封面/歌词抓取搬到 `stat` 可以满足字节合同，却会在首次列目录时准备该层所有文件；搬到首次 `open` 再悄悄改变长度则不能满足当前合同。单曲流式实验没有解决这一问题，不能据此宣称整目录已能低成本懒加载。

下一步应比较：复用现有分页准备任务、仅为未准备曲目/专辑取得并缓存小体积资料；或者调整未知文件属性的目录行为并验证 OpenList/挂载实际兼容性。前者增加首次准备的来源请求，后者涉及当前协议接线及客户端行为。二者都不自动要求缓存整首音频或新增核心音乐领域。尚未选择实现，不通过刷新大账号或压力测试来证明这个代码层可直接核对的问题。

## Windows 元数据消费端证据

该虚拟机由用户指定用于补齐先前 Windows 测试，并另行排查 MusicFS 本机挂载与资源管理器映射失败；这条支线独立后台推进，不创建新工作区。本节仅记录已取得的元数据消费端证据，不能替代 Windows 整体验收。

元数据检查复用现有 SSH 传输合成样本与读取原生字段；最终产品接线后可补一款实际播放器的资料、封面、歌词同步与拖动播放旅程，不扩为播放器兼容矩阵或音乐平台压力测试。

用户已确认该虚拟机地址正确、sshd 正在运行、WinRM 停止；实际 WSL 与执行工具都曾在 SSH banner 前遇到断连。用户定位为虚拟机防火墙并自行处理后，本轮 SSH 已正常认证，确认 Windows 11 企业版 LTSC（build 26100，系统版本 10.0.26100.1742）、PowerShell 5.1、已有 WMP 12；此前推测仅由执行工具网络隔离造成并不成立。没有启用 WinRM或修改服务/防火墙。此前禁止调用物理 Windows 宿主的约束继续保留。

两份合成 MP3 经 SSH 传到虚拟机临时目录，已取得原生消费端证据：

| 检查 | prefix-worker 样本 | taglib 样本 |
|---|---|---|
| Shell 中文歌名、专辑、多歌手、专辑艺术家、年份、曲号/碟号 | 读回 | 读回 |
| Shell 完整发行日期属性 | 空 | 空 |
| WMP 作者值计数 | 2 | 1 |
| WMP 封面属性计数 | 1 | 0 |
| WMP 歌词 | 读到包含 LRC 时间标记的原文 | 未读出 |

本地独立解析已确认 taglib 样本同样有 APIC/USLT；两个样本分别使用 ID3v2.3/v2.4，字段编码与歌词语言也有区别。这里证明消费端存在差异，不将其直接归因于某个库丢失资料或单一标签版本。

SSH 执行位于 session 0，已有交互桌面位于 session 1。一次性同用户交互任务注册被 Windows 的 UserId 参数校验拒绝，未继续扩展 GUI 基础设施排障；因此没有截图，也未验证可见播放器和歌词逐行滚动。原生属性读取不能替代这些证据。一次性脚本/任务已清理，两份合成样本保留在虚拟机临时目录，供用户查看。

## 证据位置

有限实验位于 `/tmp/musicfs-metadata-poc-20261021`，不加入应用依赖和发行包：`taglib-result.json`、`taglib-conclusion.md`、`prefix-result.json`、`prefix-evidence.md`、`sharp-result.json`、`format-result.json`、`format-ape-result.json`、`format-ape-source.json`、`windows-native-result.json`。新增可复跑入口为 `bun run format-probe.ts`、`bun run format-flac-block-probe.ts`、`bun run format-ape-probe.ts`，使用该目录固定的测试依赖和已有 Miniflare。Windows 摘要由真实 SSH stdout 转录；目录只含合成/官方测试素材与测试依赖，不含音乐平台会话。

主要接口依据：[TagLib-Wasm](https://github.com/CharlesWiltgen/taglib-wasm)、[browser-id3-writer](https://github.com/egoroof/browser-id3-writer)、[node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp)、[Cloudflare Wasm](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)。实际结果以本轮运行证据为准。
