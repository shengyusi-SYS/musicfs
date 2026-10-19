# 网易云、QQ 音乐 API 与 TS CLI / Worker 集成

核查日期：2026-10-18。当前产品范围：平台账号登录、发现、自建/收藏歌单、喜欢歌曲、音频按需读取；Node.js CLI 与 Cloudflare Worker 双部署，统一 WebDAV，桌面通过 rclone 挂载。

这是公开源码与文档能力核验，没有使用用户账号或真实 Worker 做登录、会员整曲、凭据刷新和长连接测试。不能把存在接口等同当前账号和部署环境可用。

## 是否需要独立 API 服务

需要平台适配模块，但不必强制用户另行部署 API 服务。应区分：

1. **库/模块内嵌**：与 CLI 或 Worker 同一进程/请求处理入口，默认推荐。
2. **同包内部辅助服务**：第三方入口确有 HTTP 服务需求时，由 CLI 管理，用户仍可一条命令启动；但会增加端口和进程管理。
3. **远程 API 服务**：仅作为可选部署适配，用于保留现有服务或经验证的网络出口/运行环境限制。服务化并不会改变上游授权结果。

## 网易云

核实仓库 [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)，提交 `19c7dad6db7d660954c7a615a686ff0acb030f91`，2026-10-17。

| 目标 | 源码能力 |
|---|---|
| 登录与会话 | QR key/create/check、手机登录、login_status、login_refresh |
| 自建/收藏歌单 | user_playlist、user_playlist_create、user_playlist_collect |
| 喜欢歌曲 | likelist，以及自建歌单读取的红心入口 |
| 歌单曲目 | playlist_detail、playlist_track_all、song_detail |
| 发现 | recommend_songs、recommend_resource、personal_fm 等 |
| 音频 | song_url / song_url_v1，按音质请求平台 URL |
| 歌词/封面 | lyric / lyric_new，以及歌曲/专辑元数据 |

来源：[登录二维码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/19c7dad6db7d660954c7a615a686ff0acb030f91/module/login_qr_check.js)、[会话刷新](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/19c7dad6db7d660954c7a615a686ff0acb030f91/module/login_refresh.js)、[创建歌单列表](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/19c7dad6db7d660954c7a615a686ff0acb030f91/module/user_playlist_create.js)、[收藏歌单列表](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/19c7dad6db7d660954c7a615a686ff0acb030f91/module/user_playlist_collect.js)、[每日推荐](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/19c7dad6db7d660954c7a615a686ff0acb030f91/module/recommend_songs.js)、[歌曲 URL](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/19c7dad6db7d660954c7a615a686ff0acb030f91/module/song_url_v1.js)。

### Node CLI

README 提供 Node.js/TypeScript 直接导入函数的例子，无需先独立部署 Express 服务。可封装到本项目 provider 内部，暴露统一的登录、列歌单、列曲目、解析音频等操作。[README](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/19c7dad6db7d660954c7a615a686ff0acb030f91/README.MD)。

### Worker

不能将“可导入 Node 包”直接等同“未经修改可导入 Worker”。当前入口动态扫描 module 目录，初始化临时文件；request 层使用文件系统、HTTP agents、代理库和进程内状态。Worker 具有部分 Node 兼容能力，但需验证具体依赖和状态生命周期。[main.js](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/19c7dad6db7d660954c7a615a686ff0acb030f91/main.js)、[request.js](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/19c7dad6db7d660954c7a615a686ff0acb030f91/util/request.js)、[Cloudflare Node 兼容文档](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)。

建议按目标能力静态导入必要接口描述，适配 fetch、Cookie/持久状态、随机数及加密实现；不承诺整个原库原样运行。此为设计建议，尚未实现或部署验证。

## QQ 音乐

详见 [QQ 专项核验](qq-api-integration-research.md)。新发现的 yakult-green-tea/qq-music-api 已有专门的 `/serverless` 导出，不能再把它笼统归为仅能部署 Node 服务的库。根入口与 serverless 入口具有不同副作用和依赖，需要按宿主选择。

## 推荐产品结构

```text
Node CLI / Worker
       ↓
统一虚拟目录 + WebDAV
       ↓
网易云 provider / QQ provider
       ↓
内嵌第三方协议实现（默认）
或可选远程 API 后端
```

建议默认交付“用户只部署本项目”，不要求再搭网易云 API、QQ API。实现阶段应优先完成两平台在 Node 与真实 Worker 上的登录、完整歌单分页、音质/文件大小、整曲和随机读取、凭据刷新验证。若仅云端出口被拒，是否需要额外后端应由该实测结果决定。

音频处理必须区分可浏览、可取 URL、可播放完整音频；保持平台身份，不将第三方自动匹配/换源当作原平台授权取流。song_url_v1 的 unblock 分支是额外功能，不是基本文件系统目标所必需。
