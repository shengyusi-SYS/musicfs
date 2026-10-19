# 云端音乐账号映射为目录、磁盘与 WebDAV：开源项目调查

调查日期：2026-10-17。目标：登录网易云、QQ 等音乐平台，将发现、个人歌单、收藏歌单映射为目录，歌曲映射为可由普通播放器读取的音频文件，按需取流，并通过虚拟磁盘、WebDAV 或 SMB 访问。

补查更新：发现前轮遗漏的 FastWebdav，已有“指定网易云歌单 → WebDAV 文件目录”provider，但缺账号登录/完整歌单树，且代码较旧。它不是 OpenList 原生驱动。详见 [非云盘音乐驱动补查](openlist-music-drivers-followup.md)。

## 结论与证据边界

有相同思路的开源实现。最直接的范例是 **astrovm/ytmusicfs**，但平台是 YouTube Music。中国平台中，**OpenList / OpenList-Worker 的网易云音乐驱动是局部命中：挂载音乐云盘，不是账号全部歌单**。**net-mpd** 将网易云账号的歌单、喜欢、推荐等暴露为 MPD，业务内容很接近，但没有提供所需的文件协议。

本次检索未找到并核实一个同时满足“网易云与 QQ 登录 + 自建/收藏/发现多级目录 + 音频文件按需读取 + WebDAV/SMB/磁盘挂载”的完整现成项目。这是检索结论，不是对所有公开、未索引或私有项目不存在的证明。

核验采用作者仓库、源码、项目文档和 Releases；没有使用用户账号实测登录、整曲播放或真实挂载。下文“支持”指项目文档或代码已有实现，不等于已在本环境验证当前平台服务端可用。仓库持续维护与某一音乐接口实际可用，分别判断。

## 候选对照

| 项目 | 平台与登录 | 映射/输出 | 与目标的关系 |
|---|---|---|---|
| [YTMusicFS](https://github.com/astrovm/ytmusicfs) | YouTube Music，浏览器 Cookie | 歌单、喜欢、专辑 → FUSE 文件系统 | 最直接的同思路实现，需换中国平台后端 |
| [OpenList](https://github.com/OpenListTeam/OpenList) | 网易云，手工填 Cookie | 音乐云盘文件 → OpenList / WebDAV | 已有中国平台文件入口，但缺发现和歌单树 |
| [OpenList-Worker](https://github.com/OpenListTeam/OpenList-Worker) | 网易云，Cookie | 云盘文件 → Worker 文件服务 / WebDAV | 同上，部署架构不同，并非另一套完整音乐目录方案 |
| [net-mpd](https://github.com/4fuu/net-mpd) | 网易云，终端扫码/导入 Cookie | 歌单、喜欢、云盘、推荐 → MPD | 内容组织接近，输出协议不同 |
| [go-music-dl](https://github.com/guohuiyuan/go-music-dl) | 网易云、QQ 等，Cookie / 部分扫码登录 | Web/TUI、歌单、播放、下载、上传到 WebDAV | 可借账号与取流逻辑；WebDAV 功能是下载同步 |
| [QQMusic-monitor](https://github.com/huohen92/QQMusic-monitor) | QQ 音乐，基于 QQMusicApi | 歌单监控 → 实际下载目录 | 可以实现下载后共享，不能等同即时虚拟挂载 |
| [QQMusicApi](https://github.com/L-1124/QQMusicApi) | QQ/微信/QQ 音乐 App 扫码、手机验证码 | Python SDK / HTTP API | QQ 适配层组件，没有文件系统输出 |
| [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) | 网易云登录态 | API，用户歌单、推荐、歌曲 URL 等 | 网易云适配层组件，没有文件系统输出 |
| [lxserver](https://github.com/XCQ0607/lxserver) | LX 用户体系；在线元数据/自定义音源 | Subsonic、网页播放器、同步 | 标准音乐协议方向的近似实现，未证实中国平台账号完整登录映射 |

## 重点项目

### 1. YTMusicFS：最值得参考的完整思路

作者将 YouTube Music 库暴露为只读 FUSE 文件系统，浏览器 Cookie 用于私有库访问。目录包含 `playlists`、`liked_songs`、`albums`，普通播放器读取歌曲文件时才获取媒体；项目提供缓存和修复不可播放 ID 等操作。它直接证明“平台内容 → 虚拟音频文件 → 普通播放器”的模式已有开源实现。平台限制是它没有网易云或 QQ 驱动，SMB/WebDAV 也需要另行导出。详见 [仓库及使用文档](https://github.com/astrovm/ytmusicfs)。核实提交为 `a5da8727b8dc7235f2f43d81025931a871053e72`，日期 2026-10-15；代码与维护证据见 [直接项目源码调查](research-direct-projects.md)。

### 2. OpenList：网易云云盘可用作验证入口，不能当歌单挂载

源码核实：初始化读取 Cookie 的 `__csrf`、`MUSIC_U`；列表调用 `/weapi/v1/cloud/get`，返回的对象均是文件，使用云盘文件名和大小；取链调用歌曲播放 URL 接口。默认 `SongLimit=200`，请求 offset 固定为 0。没有自建歌单、收藏歌单或发现目录的枚举实现。[初始化和文件操作](https://github.com/OpenListTeam/OpenList/blob/main/drivers/netease_music/driver.go)、[参数](https://github.com/OpenListTeam/OpenList/blob/main/drivers/netease_music/meta.go)、[云盘列举与取链](https://github.com/OpenListTeam/OpenList/blob/main/drivers/netease_music/util.go)。

它的实际结构近似：

```text
网易云音乐云盘/
├── 歌曲A.flac
└── 歌曲B.mp3
```

OpenList 自身提供 WebDAV 和音频预览，可作为文件协议框架；其驱动目录中本次未见 QQ 音乐驱动。主项目 Releases 在调查时显示 v4.2.7，发布时间为 2026-10-15，说明框架仍有近期维护，不能据此推定网易云驱动已实测可播。[功能与许可](https://github.com/OpenListTeam/OpenList)、[驱动目录](https://github.com/OpenListTeam/OpenList/tree/main/drivers)、[Releases](https://github.com/OpenListTeam/OpenList/releases)。

### 3. OpenList-Worker：同样的云盘范围

官方生态文档列出网易云驱动和 WebDAV；进一步核实 Worker 的网易云驱动也从 `/weapi/v1/cloud/get` 列举平铺文件，不能因为名称“网易云音乐”就推定包含所有歌单。Worker 适合参考 TypeScript 文件驱动接口；部署选项和运行环境的限制应独立评估。[官方生态介绍](https://openlistteam.github.io/OpenList-Docs/ecosystem/official_worker)、[仓库](https://github.com/OpenListTeam/OpenList-Worker)。进一步源码记录见同目录 `research-direct-projects.md`。

### 4. net-mpd：网易云业务组织最接近

支持扫码登录、会话刷新/导入；通过 MPD 歌单暴露喜欢、心动、私人 FM、每日推荐、最近播放、云盘及用户歌单，歌曲使用稳定的 `netease://song/<id>`，开播时再解析 URL。适合借鉴账号会话与动态内容组织。

它的主要用途是用 rmpc 控制服务端内置音频播放；MPD 的浏览/控制接口不能直接给只认 SMB/WebDAV 的播放器使用。项目 README 明确以 rmpc 为测试前端，其他 MPD 客户端覆盖有限。[项目功能与架构说明](https://github.com/4fuu/net-mpd)。

### 5. go-music-dl 与 QQMusic-monitor：下载式替代方案

go-music-dl 有多平台搜索、歌单、我的歌单与 Cookie 配置，支持网易云、QQ 等扫码登录。它的 WebDAV 选项会在下载时把音乐上传至用户填写的 WebDAV 服务器，没有将远端账号歌单直接提供为 WebDAV 目录。适合参考跨平台账号/歌单/取流模块，或接受先下载再共享的使用方式。[作者 README，尤其“歌单分类与我的歌单”“Cookie 与扫码登录”“WebDAV 同步”](https://github.com/guohuiyuan/go-music-dl)。

QQMusic-monitor 监控歌单并下载，可按歌单建立实际目录；后接普通文件共享即可访问。但目录更新依赖监控与下载，磁盘占用也是真实音频占用。它不能满足首次点击一首未下载歌曲即可通过虚拟文件取流的同一语义。[作者功能及项目来源说明](https://github.com/huohen92/QQMusic-monitor)。

## 如果补齐你的完整需求，哪些组件已经具备

### QQ 音乐

[L-1124/QQMusicApi](https://github.com/L-1124/QQMusicApi) 已有扫码、手机验证码、凭据检查和刷新；用户模块区分自建歌单、喜欢歌曲、收藏的外部歌单；取流支持按文件音质请求，并有文件大小信息。[登录教程](https://github.com/L-1124/QQMusicApi/blob/main/docs/tutorial/login.md)、[用户接口源码](https://github.com/L-1124/QQMusicApi/blob/main/qqmusic_api/modules/user.py)、[取链教程](https://github.com/L-1124/QQMusicApi/blob/main/docs/tutorial/download.md)。

调查时 Releases 显示 v0.7.3（2026-09-13）。它是仍有近期发布的可研究组件，但没有文件协议层。取链教程区分未授权、VKey 失败和设备限制：能登录、能列歌，不代表每首歌每档音质都能取到完整音频。[发布记录](https://github.com/L-1124/QQMusicApi/releases)。

### 网易云

[NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 有登录、用户内容、推荐和歌曲 URL 等能力，用户歌单和推荐已有独立模块；可用于把 API 数据映射成目录。[用户歌单模块](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/user_playlist.js)、[推荐模块](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/recommend_resource.js)、[歌曲 URL 模块](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/song_url_v1.js)。

该增强项目含跨源匹配等额外行为。如果目标是播放当前账号在原平台有权访问的版本，应明确关闭或避免自动换源，避免目录所示来源和实际音频来源不一致。这是接入建议，不是它已有文件系统功能的声明。

### 文件协议与挂载

可选择扩展 OpenList 驱动，或者单独实现一个只读 WebDAV 服务。之后使用 [rclone WebDAV 后端](https://rclone.org/webdav/) 和 [rclone mount](https://rclone.org/commands/rclone_mount/) 挂为本地目录/盘符；Windows 需要 WinFsp。SMB 可以由服务器把本地挂载目录经 Samba 再共享。这些是组合设计，尚未在本次任务联调验证；不能写成现有音乐项目原生支持 SMB。

```text
平台账号 API（网易云 / QQ）
          ↓
目录树 + 稳定歌曲 ID + 按需解析音频 URL
          ↓
只读 WebDAV
    ├── WebDAV 播放器直接读取
    └── rclone mount → 本地目录/盘符
                          └── Samba → SMB 客户端
```

对你给出的需求，建议目标目录如下。**这是建议结构，不是已找到的某个项目截图或现成功能：**

```text
网易云音乐/
├── 发现/
│   ├── 每日推荐/
│   └── 推荐歌单/歌单名称 [ID]/
├── 你的歌单/
│   ├── 喜欢的音乐/
│   └── 歌单名称 [ID]/
│       ├── 001 - 歌手 - 歌名 [歌曲ID].flac
│       └── 002 - 歌手 - 歌名 [歌曲ID].flac
├── 收藏的歌单/歌单名称 [ID]/
└── 音乐云盘/
QQ音乐/
└── 同类结构（按其 API 实际能力提供）
```

## 关键实现问题

以下是根据文件协议和已核实项目行为作出的工程判断：

1. **目录与媒体分开获取。** 列歌单只需元数据；读取歌曲才解析临时 URL。不能将一次得到的 CDN 链接永久当文件身份。net-mpd 的稳定 URI、开播解析方式可借鉴。
2. **HTTP Range 与随机读取。** 播放器探测头尾、拖动位置都会读取不同字节段；需要正确返回长度、206 和范围，或用缓存补足。仅把 GET 重定向到一个链接，尚不能证明所有客户端兼容。
3. **同一路径保持文件内容稳定。** 音质切换、转码、插入标签都会改变大小和偏移。一次打开期间不应悄悄切换内容版本。
4. **控制扫描成本。** 全库索引器可能逐首读取标签，形成大量取流请求；目录缓存、分页、请求合并和并发上限比只优化播放按钮更重要。
5. **名称和身份分离。** 同名歌单、同名歌曲、非法文件名和列表顺序需要处理；追加平台 ID、曲序能减少路径冲突，内部缓存仍按 ID 管理。
6. **动态发现需要快照。** 每日推荐可按日期刷新；私人 FM 是动态序列，映射成无限目录会和普通文件浏览器冲突，应给出有限快照或单独的播放入口。
7. **默认只读较清晰。** 删除虚拟文件究竟是取消喜欢、移出歌单还是删除云盘歌曲，应另作设计。现有 OpenList 云盘驱动有真实删除与上传实现，试用时应使用只读账号权限/访问权限。

## 已排除的常见近似命中

- [NeriPlayer](https://github.com/cwuom/NeriPlayer)：第三方音乐客户端；GitHub/WebDAV 同步的是歌单、收藏、历史、统计等元数据，没有向外导出本需求的音乐文件目录。
- [jwu-au/QqMusic](https://github.com/jwu-au/QqMusic)：从旧版 iOS QQ 音乐已缓存/下载内容同步至硬盘、NAS 或 WebDAV；不是平台账号内容按需挂载。
- [netease-navidrome-sync](https://github.com/XlangNan/netease-navidrome-sync)：把网易云歌单匹配到已有 Navidrome 本地音频，缺少音频就跳过，不是云端音频虚拟化。
- [lxserver](https://github.com/XCQ0607/lxserver)：Subsonic 能输出在线内容，值得研究协议桥接；WebDAV 功能用于备份，自定义音源和 LX 服务登录不能等同网易云/QQ 账号登录。
- [WebMusic](https://github.com/FancyStarry/WebMusic)、[WebDavPlayer](https://github.com/Allenalonel/WebDavPlayer)：消费已有 WebDAV 音频的播放器，方向与“音乐平台 → WebDAV 服务”相反。
- [bjma/spotify-filesys](https://github.com/bjma/spotify-filesys)：CLI 中模拟目录树管理 Spotify 库，没有真正挂载成系统文件目录，不能当作现成文件播放方案。

## 历史同类

[EnigmaCurry/GMusicFS](https://github.com/EnigmaCurry/GMusicFS) 是更早的真实实现：Google Music → FUSE → 歌手/专辑/MP3 文件，播放器从挂载目录读歌曲。已核实的最新提交在 2014 年，README 记录了没有缓存、不支持随机 seek 和全库扫描效率问题。仅作历史架构参考，不将旧登录/API 的存在视为今天可部署的证据。[固定版本 README](https://github.com/EnigmaCurry/GMusicFS/blob/44d8630d9224a8ae38465b8cf4cb800759d8ff27/README.md)。

## 选择建议

- **验证“网易云音乐能够作为文件被读取”**：优先试 OpenList 云盘驱动。
- **学习“歌单如何成为虚拟目录与音频文件”**：优先读 YTMusicFS。
- **研究网易云喜欢/推荐/歌单组织与会话**：优先读 net-mpd。
- **实现网易云 + QQ 的完整需求**：可在 OpenList 内增加歌单目录驱动，或以两平台 SDK + 独立只读 WebDAV 服务实现；现有组件能减少工作，但中间的目录映射和可靠音频读取仍需开发。
- **接受下载式音乐库**：go-music-dl / QQMusic-monitor + 常规文件共享更接近可直接部署的组合，但不是按需虚拟化。

检索覆盖了中英文 WebDAV、SMB、FUSE、filesystem、mount、musicfs、neteasefs、SpotifyFS、网易云/QQ 挂载等关键词，并延伸检查 OpenList 生态、音乐 API、MPD/Subsonic 桥接和下载同步项目。对未核实的历史名称没有列为可用项目。
