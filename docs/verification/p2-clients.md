# OpenList 与独立播放器实测

日期：2026-10-20。产品源码基于 `bf1d060`；插件为网易云 alpha.5、QQ alpha.7。范围为 Linux x64 正式桌面 service、真实音乐会话与 MP3；没有用固定 WAV 代替真实来源。本文是客户端证据，不扩展产品功能。

## 工具与隔离

- OpenList **v4.2.7 / commit 3b28270 / Web v4.2.7**，从[官方固定 Release](https://github.com/OpenListTeam/OpenList/releases/tag/v4.2.7)下载 `openlist-linux-amd64.tar.gz`，50,151,865字节；官方 Release API SHA-256与本地一致：`e9ab57a1572401836c9edfa92697d9c69f330c0172dd97b2698a9839a367ba7c`。只在 `/tmp` 解压、监听127.0.0.1，不全局安装。
- 独立播放器 **mpv v0.41.0**，从系统官方 Ubuntu 软件源的 `0.41.0-2ubuntu4` 包及所需库提取到临时目录；FFmpeg 8.0.1，PulseAudio 输出。运行时静音；验证音频设备/解码/播放时钟，没有主观听音。
- 使用正式 `createDesktopService` 建立临时 SQLite、插件修订和布局，正式 API 安装包与创建实例。只读复制已获授权实例的配置/私有会话到测试实例，目录快照从空开始。原开发实例、授权和用户布局不变；没有重新扫码。
- 浏览器使用实际 OpenList UI 配置 WebDAV：网页代理开启、本机代理、其他供应商，保留默认30分钟缓存。播放器通过正常页面打开，未注入媒体 API 或替换播放器实现。

## 冷目录 → 管理准备 → 重试

1. OpenList 挂载成功，根目录可列出已发布的每日入口；首次进入歌曲目录，实际 MusicFS `PROPFIND` 返回503和准备操作标识。OpenList只显示 `failed to list objs: PROPFIND … 503`，没有消费 MusicFS 管理进度或自动完成所有层级。
2. 桌面后台完成内容入口准备。在 MusicFS 共用“数据源 → 内容源”对每日点击现有“刷新目录”，页面显示运行、完成和真实计数。
3. OpenList重载该失败页面后成功列出网易云 **30曲中可导出的18个标准MP3**。QQ另经相同管理入口准备 **30曲/2个128k MP3**，列表大小与MusicFS精确描述相符。
4. 加入QQ布局入口后，OpenList普通重载仍显示旧的根列表；点击其工具栏“刷新”才显示新增入口。这是独立客户端缓存，不是来源授权失效或MusicFS没有发布。

本次没有新增元数据任务、等待循环或OpenList专用产品适配。用户步骤记录于[连接说明](../clients.md)。首次准备成本与客户端重试仍是可见限制，不把本次成功说成所有客户端都能透明冷启动。

## OpenList 内置播放器

网易云真实标准MP3 **3,093,933字节、193.306729秒**：页面自动加载并播放，显示03:13总时长；通过实际进度条先跳到约02:25，再回到00:10，观察继续前进到00:17；最后回到前段并暂停。截图保存在 `/tmp/musicfs-openlist-seek-forward.png`、`/tmp/musicfs-openlist-playback.png`，不把曲名/私有URL写入仓库。

该浏览器本次以 `Range: bytes=0-` 得到206并缓冲短文件，界面拖动使用本地缓冲，不据此宣称每次操作都有上游范围请求。独立播放器另用较小缓冲验证实际请求，见下表。

## 独立 mpv 的真实解码与双向 seek

新增可选验收脚本 [probe-player.ts](../../scripts/probe-player.ts)，使用 [mpv官方JSON IPC](https://mpv.io/manual/stable/#json-ipc) 的正常load/seek/属性接口；不调用产品内部文件读取函数。它关闭播放器主缓存、限制demuxer缓冲，读取真实时长/可定位/音频格式与当前音频输出；五次精确跳转后分别等待实际播放时钟继续前进。

| 路径 | 实际媒体 | 输出与解码 | 五次跳转目标（秒） | 结果 |
|---|---|---|---|---|
| MusicFS DAV直接读取 | 网易云3,093,933字节MP3 | PulseAudio，48kHz，双声道 | 144.980 → 5 → 77.323 → 185.307 → 0 | 全部定位并恢复播放 |
| OpenList原生代理 | 同一网易云文件 | PulseAudio，48kHz，双声道 | 同上 | 全部定位并恢复播放 |
| OpenList原生代理 | QQ5,215,076字节、325.868118秒MP3 | PulseAudio，44.1kHz，双声道 | 244.401 → 5 → 130.347 → 317.868 → 0 | 全部定位并恢复播放 |

本地实际DAV请求日志包含非零与后退偏移的206，如网易云 `bytes=2343213-` 后回到 `bytes=429-`，QQ `bytes=3935575-` 后回到 `bytes=490-`；Content-Range总长分别始终为3,093,933与5,215,076。不同seek可由播放器从已有缓冲解码，不能把五次seek机械等同于五个相同偏移HTTP请求。具体任意字节一致性继续由既有[真实来源DAV记录](p2-netease-source.md)覆盖。

原始报告留 `/tmp/musicfs-player-direct.json`、`/tmp/musicfs-player-openlist.json`、`/tmp/musicfs-player-qq-openlist.json`；请求日志不含路径、认证头或上游媒体URL。脚本通过后退出播放器并清理IPC目录；失败保留临时日志供检查，不打印媒体URL。

## 复测与限制

使用方法见[开发入口](../development.md#独立播放器复测)。本轮新增的是验收工具/使用说明，三组TypeScript和diff检查通过；未重复155项产品测试、四目标构建或此前FLAC全文下载。

已验证的是两个来源的本地MP3、OpenList v4.2.7及Linux mpv，不代表全部音质/格式、所有播放器、Worker云端、Windows/macOS原生客户端或跨公网已经通过。FLAC播放器、云端和其余目标仍按[总台账](../verification.md)继续。音频输出保持静音，没有主观音质或扬声器出声证据。
