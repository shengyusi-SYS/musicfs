# QQ 音乐 API 与 TypeScript / Worker 集成调查

调查：2026-10-18。只做公开文档和源码审阅，没有使用真实账号执行登录、读取歌单、播放或 Worker 部署验收。以下“支持”指文档及代码提供该能力。

## 2026-10-20 实现复核补充

原调查是静态证据。现已核对 npm 正式发布包 3.3.3，完整性为 `sha512-KgNmuZ1v4yYBTXASn8dcbJ8PCkuWsgGgGTCx9z7fODIftNQ2/npSQTVy/l9J/pEFJAN+SMITBZnjYzcTLT7iVw==`；该固定包已进入 QQ 示例插件，实际范围见[真实验证记录](../verification/p1-qq-source.md)。发布来源为 [npm 包](https://www.npmjs.com/package/@yakult-green-tea/qq-music-api/v/3.3.3)。

- 手机 QQ 真实扫码、会话恢复、每日推荐与真实 MP3 Range 已验证；本地 workerd 恢复同一会话并校验账号/目录通过，不代表真实云部署已完成。
- `/user/playlist` 对 created 和 favorites **合并并按 ID 去重**，公共响应没有可靠的来源类别。仅拿此输出无法满足分别分类的要求；不可按歌单名称或所有者推断。后续需要插件内保留原始类别的适配入口，复用 SDK 协议能力；alpha.3 已通过固定 SDK 的原始导出适配保留两类来源，见 [ADR 0005](../adr/0005-pinned-qq-sdk-read-adapter.md)及[实测记录](../verification/p2-qq-catalog.md)。
- `/serverless` 闭包中的日志模块直接读取 `process.env`，原样浏览器构建在本地 workerd 启动失败。作者构建使用 Bun `define` 固定日志设置后，实际打包模块无需 Node 兼容开关即可执行；没有修改依赖源码或增加全局 process 补丁。
- SDK 的 HTTP/元数据请求有自己的超时，外层 Request 的信号没有传到所有底层请求。当前媒体读取使用插件自己的 `ctx.fetch` 并传递信号；整体元数据取消仍待完成。
- sealed 会话的续期有进程内共享 Promise/退避状态。跨请求/跨 isolate 的协调及条件保存仍需实际实现和验证，不能凭本地单次调用推断已满足 MusicFS 续期合同。

## 建议

**不必先要求用户单独部署一个 QQ API 服务。** 当前 `@yakult-green-tea/qq-music-api` 已有独立的 Web 标准 `serverless` 子入口，适合共用 TypeScript 核心的 Node CLI + Cloudflare Worker 方案。可以在同一应用内调用 `handleRequest(Request, env, options)`，无需多一个容器和公网 API。先使用 QQ/微信的 HTTP 扫码通道；QQ 音乐 App 扫码再选配 Durable Object MQTT/WSS 中继。[源码入口](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/src/serverless/index.ts)、[部署说明](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/docs/README.md)。

注意：npm 根入口并非纯 SDK，导入即 `app.listen()` 启动 Koa；Worker 必须导入 `/serverless`。Node 端如果选择根入口嵌入，是同一进程内启动一个服务监听，仍非要求用户另外部署。若希望 Node 与 Worker 真正共用一次调用路径，也可都使用 `/serverless`，但此时会话行为同 sealed 模式，且 Node 原生 MQTT 登录优势不自动出现。[package.json](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/package.json)、[运行时与嵌入说明](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/docs/README.md)。

## 1. yakult-green-tea/qq-music-api

核实 npm 版本 **3.3.3**；Git HEAD `e7dff2e1e2496780702bda528362edbdaf6bbf6e`，2026-10-18 00:26:18 +08；MIT。是 Rain120/qq-music-api 的维护 fork。不要与旧上游能力或旧版本限制混淆。

| 需求 | 已提供的接口/实现 | 对虚拟目录的意义 |
|---|---|---|
| 登录 | QQ、微信、QQ 音乐 App 扫码；状态、退出、刷新 | 能接入本人账号 |
| 自建和收藏歌单 | `/user/playlist`，实现分别读取 created 和 favorites，再合并去重；有收藏列表续读参数 | 可形成“你的歌单”“收藏歌单”，适配层须保留来源信息，不能只靠名字分类 |
| 私有歌单内容 | `/user/playlist-detail` | 自己不公开歌单可读 |
| 喜欢歌曲 | `/user/liked-songs?offset&limit`，limit 上限 100，回 total/more | 可做“喜欢的音乐”，需完整分页 |
| 发现 | 推荐歌单、分类歌单、排行榜、新歌、新碟、猜你喜欢、每日 30 首、雷达、电台 | 可映射“发现”分类目录 |
| 播放地址 | `/getMusicPlay`，会话取流、音质选择、best、试听和不可用状态 | 适配层在打开文件时临时解析 URL；不能把“接口返回 HTTP 200”视为音频可播 |
| 标签/歌词 | 歌曲/专辑详情、`/getLyric` | 提供命名和媒体元数据基础，嵌入标签或旁车文件仍由本项目实现 |

来源：[Serverless 实际路由表](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/src/serverless/index.ts)、[已登录读取实现](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/src/services/auth/authenticatedReads.ts)、[喜欢歌曲分页](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/src/routes/operations/getUserLikedSongs.ts)、[播放处理](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/src/routes/operations/getMusicPlay.ts)。

### Worker 兼容与限制

- `/serverless` 使用 Fetch / Request / Response、Web Crypto；仓库有依赖闭包测试，要求整个 serverless 图没有 npm 包及 Node 内置模块。包整体存在 Koa/Axios/ws 依赖，不代表正确子入口也依赖它们。[闭包契约测试](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/tests/serverless.closure-contracts.test.ts)。
- 默认 QQ 采用纯 HTTP 网页登录，微信也是 HTTP；**QQ 音乐 App** 扫码需要持续 MQTT over WSS，由宿主注入 `qqRelay`，可用 Durable Object 持有。不能笼统说“所有 QQ 扫码都要求中继”。源码某些大段旧注释仍只写微信/中继 QQ，实际应以 `capabilitiesFor`、当前文档及 `/login/channels` 运行时响应为准。[能力实现](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/src/serverless/qrRuntime.ts)。
- 配置稳定的 `QQ_SESSION_SECRET`；sealing 将凭据加密装入 token，避免依赖 isolate 内存。设备身份由该 secret 推导，随意改密钥会改变设备身份。密钥轮换支持 previous secret。[sealedSession](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/src/serverless/sealedSession.ts)、[设备推导](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/src/serverless/derivedDevice.ts)。
- sealed 模式必须主动调用 `/login/refresh` 并保存新 token；文档称最多延长至首次扫码后 30 天。对无人值守 WebDAV，需要服务端账号配置仓库保存当前 sealed token，刷新后原子更新；“无需独立 API 服务”不等于“应用无需任何持久存储”。Node stored 模式则支持加密会话文件/宿主 repository 及请求时自动刷新。[会话说明](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/docs/README.md)。
- 签名/QIMEI 引导已以 Web Crypto 加纯 TS 算法实现，而非必须调用另一台签名服务器。[androidDevice.ts](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/src/services/auth/androidDevice.ts)。
- 上游作者明确记录 Serverless 机房出口可能导致搜索返回空列表、部分歌没有 URL；这是作者观察，本次没有复验，原因也未定论。因此发布时宜保留“本地 Node 模式”和远程 API transport 作为可选降级，先做真实 QQ/微信账号及目标 CF 地区验收。[部署注意事项](https://github.com/yakult-green-tea/qq-music-api/blob/e7dff2e1e2496780702bda528362edbdaf6bbf6e/docs/README.md)。

## 2. L-1124/QQMusicApi

核实 HEAD `27861e51432ea6b6e88dc35c4e8c8e239c0339e8`，2026-10-05；Python 3.10+，GPL-3.0-or-later。它本质是可嵌入 Python 的异步 SDK，另有可选 FastAPI Web 包装。独立 HTTP 服务是使用方式之一，并非 SDK 调接口的强制前提。[pyproject.toml](https://github.com/L-1124/QQMusicApi/blob/27861e51432ea6b6e88dc35c4e8c8e239c0339e8/pyproject.toml)、[Web 教程](https://github.com/L-1124/QQMusicApi/blob/27861e51432ea6b6e88dc35c4e8c8e239c0339e8/docs/tutorial/web.md)。

已核源码覆盖：QQ/微信/QQ 音乐 App 扫码、手机号验证码登录、凭据校验刷新；自建歌单 `get_created_songlist`、收藏歌单 `get_fav_songlist`、喜欢歌曲 `get_fav_song`（dirid=201）；歌单详情、发现首页/猜你喜欢/雷达/推荐歌单/新歌、歌曲取 URL。收藏和喜欢列表有分页器；歌曲 URL 选择普通/加密文件类型，URL 不代表其返回内容必然是可直接播放的明文媒体。[登录](https://github.com/L-1124/QQMusicApi/blob/27861e51432ea6b6e88dc35c4e8c8e239c0339e8/qqmusic_api/modules/login.py)、[user.py](https://github.com/L-1124/QQMusicApi/blob/27861e51432ea6b6e88dc35c4e8c8e239c0339e8/qqmusic_api/modules/user.py)、[songlist.py](https://github.com/L-1124/QQMusicApi/blob/27861e51432ea6b6e88dc35c4e8c8e239c0339e8/qqmusic_api/modules/songlist.py)、[recommend.py](https://github.com/L-1124/QQMusicApi/blob/27861e51432ea6b6e88dc35c4e8c8e239c0339e8/qqmusic_api/modules/recommend.py)、[song.py](https://github.com/L-1124/QQMusicApi/blob/27861e51432ea6b6e88dc35c4e8c8e239c0339e8/qqmusic_api/modules/song.py)。

对既定 TS Node + CF Worker 架构，这个 Python 包不是直接可导入的依赖；其 niquests、cryptography、orjson、paho-mqtt 等依赖也不能靠给 TS Worker 开 `nodejs_compat` 解决。若选择它，最直接是常驻 Python API sidecar，TS 通过 HTTP 调用；否则需要自行移植相关协议。其 QQ 音乐 App 登录同样使用 MQTT 长连接。**当前已有较贴合目标运行时的 TS 库，因此不建议为了同样的只读歌单能力先新增 Python 常驻服务。** [依赖清单](https://github.com/L-1124/QQMusicApi/blob/27861e51432ea6b6e88dc35c4e8c8e239c0339e8/pyproject.toml)、[登录教程](https://github.com/L-1124/QQMusicApi/blob/27861e51432ea6b6e88dc35c4e8c8e239c0339e8/docs/tutorial/login.md)。

## 实施前验收重点

用本人有效账号在本地 Node 与目标 Worker 各核一轮：扫码、重启后会话恢复、完整翻页、自建/收藏分类、私有歌单、喜欢歌曲、刷新 token 落盘、免费/会员/不可用歌曲的真实 URL、音频 HEAD/Range 和 rclone seek。API 库提供元数据与取流，不负责把它们映射成 WebDAV 文件树，也不承诺平台授权之外的播放能力。
