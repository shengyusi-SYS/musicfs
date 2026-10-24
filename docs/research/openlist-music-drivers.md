# OpenList/AList 非云盘音乐驱动补查

日期：2026-10-17。排除网易云音乐云盘驱动，专查歌单/喜欢/推荐映射为文件目录。使用公开仓库检索、分支关键词检索和源码静态审阅；未登录、未部署、未实测媒体读取。

## 结论

尚未找到并核实可直接装入 OpenList/AList 的网易云或 QQ 完整账号歌单驱动。找到一个前轮遗漏的重要近似实现：**ykxVK8yL5L/FastWebdav 内置网易云歌单数据提供器**，可把指定歌单转成 WebDAV 文件目录；可以考虑由 OpenList 的通用 WebDAV 驱动接入，但组合未联调。它是独立服务，不是 OpenList 原生插件。

## FastWebdav：非云盘歌单映射确有实现

仓库：[ykxVK8yL5L/FastWebdav](https://github.com/ykxVK8yL5L/FastWebdav)。克隆核实 HEAD `e88dfc37e4e54e1af8a190d2fa3faf1b4d33aea3`，最新提交 2024-07-31，MIT。

- Rust WebDAV 层 + Python FastAPI provider；根目录列出配置的 provider 实例，每个实例可对应一个歌单。
- `NeteaseCloudMusic(provider, playlist_id, count=50)` 调用硬编码第三方 API 的 `/playlist/track/all`，再调用 `/song/url`。将歌曲生成带实际返回 size、格式扩展名和下载 URL 的 `DavFile`。
- 不读云盘，不依赖预先下载歌曲，符合“指定歌单 → 文件目录”的核心思路。
- 只有手工配置歌单 ID；构造参数和 HTTP 请求没有用户 Cookie、账号登录、自动枚举自建/收藏歌单或发现功能。
- 固定 `offset=0`，默认 50 首；遇到某首 URL 为空使用 `break`，后续歌曲会一并漏掉。文件名只有歌名，可能重名。
- 取流 URL 在列举时批量取得；缓存 10 分钟。不能据源码认定目前接口仍可用。

证据：[网易云 provider](https://github.com/ykxVK8yL5L/FastWebdav/blob/e88dfc37e4e54e1af8a190d2fa3faf1b4d33aea3/FastAPI/models/NeteaseCloudMusic.py)、[provider 路由及根目录](https://github.com/ykxVK8yL5L/FastWebdav/blob/e88dfc37e4e54e1af8a190d2fa3faf1b4d33aea3/FastAPI/main.py)、[WebDAV 文件系统](https://github.com/ykxVK8yL5L/FastWebdav/blob/e88dfc37e4e54e1af8a190d2fa3faf1b4d33aea3/src/vfs.rs)。

建议的接入关系（待验证）：

```text
指定网易云歌单 → FastWebdav → WebDAV → OpenList 的 WebDAV 存储
```

## Meting provider：有 QQ/网易云参数，不能视作成熟支持

同仓库 `Meting(provider, server, playlist_id)` 允许 `server=tencent/netease`，通过 Meting API 将歌曲列为 `.mp3`。但 size 固定为 1,000,000,000 字节；README 作者明确说明该模型已不可用、接口数据不全，仅供参考。没有登录能力。

证据：[Meting.py](https://github.com/ykxVK8yL5L/FastWebdav/blob/e88dfc37e4e54e1af8a190d2fa3faf1b4d33aea3/FastAPI/models/Meting.py)、[作者 README](https://github.com/ykxVK8yL5L/FastWebdav/blob/e88dfc37e4e54e1af8a190d2fa3faf1b4d33aea3/README.md)。[fast-webdav-devops](https://github.com/ykxVK8yL5L/fast-webdav-devops) 为同框架生成的相关仓库，不重复计为独立成熟方案。

## 排除与检索范围

- OpenList 主仓库、Worker 的网易云驱动均为云盘，不计入本轮候选。[主仓驱动列表](https://github.com/OpenListTeam/OpenList/tree/main/drivers)。
- 大量站点在 OpenList 页面嵌入 Meting/APlayer，只是网页播放器，与 WebDAV 文件目录无关。
- ShareList 当前核心仓库及官方 linkdrive/plugins 清单未发现网易云/QQ 歌单 provider；关键词搜索也未核实第三方音乐源。[ShareList](https://github.com/reruin/sharelist)、[官方插件库](https://github.com/linkdrive/plugins)。
- alist-tvbox 的 QQ 音乐登录用于更新 Python/TvBox 插件凭据；其 `/dav` 代理直接转发内置 AList，未发现将音乐插件目录注册到该 AList 的接线，不能算已核实的歌单 WebDAV 输出。[WebDavProxyFilter](https://github.com/power721/alist-tvbox/blob/master/src/main/java/cn/har01d/alist_tvbox/config/WebDavProxyFilter.java)、[PluginService](https://github.com/power721/alist-tvbox/blob/master/src/main/java/cn/har01d/alist_tvbox/service/PluginService.java)、[QqMusicService](https://github.com/power721/alist-tvbox/blob/master/src/main/java/cn/har01d/alist_tvbox/service/QqMusicService.java)。
- `musicwarp` 为 Navidrome 对 OpenList 网盘音频的 302 代理，方向不同；`Netease_url` 仓库描述为自动下载网易云歌单，未作为驱动候选。

GitHub 未认证搜索存在索引与速率限制，分支代码无法保证穷尽。因此结论采用“未找到可核实实现”，不声称所有公开分支不存在。
