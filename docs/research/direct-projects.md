# 云音乐映射文件系统：直接项目调查

调查日期：2026-10-17。依据公开仓库 README 和实际源码静态审阅；未提供平台账号，未做登录和真实音频播放测试。仓库存在和代码实现不等于第三方平台接口目前可用。

## 结论

- 确认存在与设想高度一致的开源实现：**YTMusicFS**，将已登录 YouTube Music 的歌单、喜欢歌曲、专辑呈现为真正 FUSE 文件目录，普通播放器按文件播放。但它没有网易云或 QQ 适配。
- 中国平台找到 **OpenList / OpenList-Worker 的网易云音乐驱动**，但实际是“网易云音乐云盘”映射，只有云盘歌曲平铺，没有发现/自建歌单/收藏歌单目录。不能用 README 的“网易云音乐”概括成完整账号音乐库挂载。
- 检索未找到可核实的网易云 + QQ 完整歌单目录虚拟文件系统现成项目；这不是证明其绝对不存在。

## 1. YTMusicFS：高度同思路，平台不同

仓库：[astrovm/ytmusicfs](https://github.com/astrovm/ytmusicfs)。核实版本 `a5da8727b8dc7235f2f43d81025931a871053e72`，最新提交日期 2026-10-15；MIT，未见归档状态。当前文档要求 Python 3.14+、FUSE，安装例子是 Linux 发行版，不应自行声称开箱支持 Windows。

- 登录：先在本地浏览器登录 YouTube Music，再用 `--browser brave/chrome/firefox` 读取浏览器 Cookie；支持私有歌单。
- 文件树：`/playlists/<歌单>/<歌手 - 歌曲>.m4a`、`/liked_songs/<歌曲>.m4a`、`/albums/<专辑>/<歌曲>.m4a`。另有 `/.ytmusicfs/status.json`。
- 音频：实现 FUSE read，按需从 YouTube 取流，持久化元数据和音频缓存；文档给出 Audacious、mpv 直接读挂载路径的例子。
- 更新：保存的目录立即可见，后台刷新库，每小时合并刷新；喜欢歌曲延迟刷新。
- 限制：音频 URL 会过期，首次播放前大小可能是估计值；seek 在部分播放器不够平滑；大库扫描元数据会触发大量网络读取。未见原生 SMB/WebDAV 服务端；把 FUSE 目录再次由 Samba/WebDAV 导出属于组合方案，不能视为仓库自带。

来源：[固定版本 README](https://github.com/astrovm/ytmusicfs/blob/a5da8727b8dc7235f2f43d81025931a871053e72/README.md)、[filesystem.py](https://github.com/astrovm/ytmusicfs/blob/a5da8727b8dc7235f2f43d81025931a871053e72/ytmusicfs/filesystem.py)、[file_handler.py](https://github.com/astrovm/ytmusicfs/blob/a5da8727b8dc7235f2f43d81025931a871053e72/ytmusicfs/file_handler.py)、[content_fetcher.py](https://github.com/astrovm/ytmusicfs/blob/a5da8727b8dc7235f2f43d81025931a871053e72/ytmusicfs/content_fetcher.py)。

## 2. OpenList-Worker：网易云云盘局部命中

仓库：[OpenListTeam/OpenList-Worker](https://github.com/OpenListTeam/OpenList-Worker)。核实版本 `5f53f58dd0f5e5d03eb6079da7f637fa151d8dca`，最新提交 2026-10-16，AGPL-3.0，未归档。它是 OpenList Go 后端的 TypeScript/Serverless 移植，有 Cloudflare Workers、EdgeOne、ESA、Node 容器等部署选项。

- `types.ts` 明确注释“网易云音乐云盘 - Cookie 认证”。配置只有 `cookie`、`song_limit`。
- 登录接入：导入既有 Cookie，初始化要求同时含 `__csrf` 和 `MUSIC_U`。该驱动没有扫码/账号密码登录流程。
- 目录：`list()` 调用 `getSongObjs()`，后者只访问 `/weapi/v1/cloud/get`；每条 `songToItem()` 都是 `is_dir:false`。因此挂载目录中是云盘歌曲平铺，**没有**“发现→歌单→歌曲”的层级。
- 分页限制：默认 `song_limit=200`，请求 `offset=0`，没有遍历分页逻辑。配置更高 limit 是否被平台接受需实测。
- 播放：`get()` 按文件名查云盘歌曲，调用 `/api/song/enhance/player/url`、`br=999000` 获取实际 URL。这里的请求码率不能当作音源一定无损的承诺。
- 协议：通用 WebDAV 路由支持 PROPFIND、GET、HEAD。GET/HEAD 重定向到存储解析出的 raw URL 或通用下载端点；通用 raw 路由支持代理/重定向，支持配置 Range 透传，回传 Content-Range/Accept-Ranges。是否可拖动取决于配置和上游。
- 写操作：云盘 remove 已实现，会调用云盘删除接口；mkdir/rename/move/copy 未支持，上传明确在无状态环境不支持。这并非只读驱动，部署需要用通用权限限制写操作。
- QQ：当前完整 drivers 目录未见 qq_music/qqmusic 类驱动。SMB 在 README 中属于接入上游 SMB 存储的驱动，不能混同为 SMB 服务端输出。

来源：[driver.ts](https://github.com/OpenListTeam/OpenList-Worker/blob/5f53f58dd0f5e5d03eb6079da7f637fa151d8dca/src/backend/drivers/netease_music/driver.ts)、[types.ts](https://github.com/OpenListTeam/OpenList-Worker/blob/5f53f58dd0f5e5d03eb6079da7f637fa151d8dca/src/backend/drivers/netease_music/types.ts)、[util.ts](https://github.com/OpenListTeam/OpenList-Worker/blob/5f53f58dd0f5e5d03eb6079da7f637fa151d8dca/src/backend/drivers/netease_music/util.ts)、[webdav.ts](https://github.com/OpenListTeam/OpenList-Worker/blob/5f53f58dd0f5e5d03eb6079da7f637fa151d8dca/src/backend/server/webdav.ts)、[raw.ts](https://github.com/OpenListTeam/OpenList-Worker/blob/5f53f58dd0f5e5d03eb6079da7f637fa151d8dca/src/backend/server/raw.ts)、[驱动目录](https://github.com/OpenListTeam/OpenList-Worker/tree/5f53f58dd0f5e5d03eb6079da7f637fa151d8dca/src/backend/drivers)。

## 3. GMusicFS：历史先例

仓库：[EnigmaCurry/GMusicFS](https://github.com/EnigmaCurry/GMusicFS)。核实 HEAD `44d8630d9224a8ae38465b8cf4cb800759d8ff27`，最新提交 2014-05-20。

Python FUSE + gmusicapi，将 Google Music 映射为 `artists/<歌手>/<专辑>/<歌曲>`，含 `cover.jpg`，MP3 可直接由 mplayer 读文件取流。旧登录配置为 username/password/deviceId，双因素使用应用密码。README 明说只读、没有缓存、不支持 MP3 随机 seek，大型播放器全库读标签效率差。只作历史架构参考，不能推荐今天部署；此处未独立核实其依赖 API/登录的现存可用性。

来源：[固定 README](https://github.com/EnigmaCurry/GMusicFS/blob/44d8630d9224a8ae38465b8cf4cb800759d8ff27/README.md)。

## 4. Spotify Filesystem：容易误判的名称命中

仓库：[bjma/spotify-filesys](https://github.com/bjma/spotify-filesys)。核实 HEAD `1822270695903403b1926760601b726617257737`，最新提交 2021-06-23。

它“模拟 Unix-like 文件系统”管理 Spotify 库，配 Spotify developer client ID/secret 和 localhost OAuth callback，提供 tree、cd 等命令。README 中 pwd、ls 仍未实现，open 仅写“理想上应播放目标曲目”；源码为 CLI/tree 数据结构，无实际 FUSE/WebDAV 挂载实现。因此它可借鉴音乐库目录模型，**不能列为现成虚拟磁盘播放方案**。

来源：[README](https://github.com/bjma/spotify-filesys/blob/1822270695903403b1926760601b726617257737/README.md)、[filesys](https://github.com/bjma/spotify-filesys/tree/1822270695903403b1926760601b726617257737/filesys)、[cmd](https://github.com/bjma/spotify-filesys/tree/1822270695903403b1926760601b726617257737/cmd)。

## 检索边界

使用了中英文关键词组合：网易云/QQ音乐 + 文件系统/虚拟磁盘/挂载/WebDAV/FUSE；netease/musicfs/neteasefs/musicdav + filesystem/mount；以及 Spotify、SoundCloud、Google Music 同类实现。大量结果实际是下载后上传 WebDAV、播放器消费 WebDAV、平台数据备份到 WebDAV、或本地音频按标签重新组织，不能当作“在线账号库实时映射为音频文件”的命中。
