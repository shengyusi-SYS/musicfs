# 网易云双宿主插件的 SDK 与请求边界调查

日期：2026-10-20  
范围：MusicFS 网易云示例插件的扫码登录、会话、歌单/推荐与播放地址。第 1—5 节为维护方源码、npm 发布元数据和 Cloudflare 官方文档调查，原始发布包下载到 `/tmp`；第 6 节补记候选实际接入后的证据。下文“建议/推断”是本项目判断，不能自动作为网易云链路已经通过的证据。

## 建议结论

优先验证 **`NeteaseCloudMusicApi@4.32.0` 的必要业务模块 + 原样 `util/crypto.js` + MusicFS 插件内部的实例级 Fetch 适配器**。它不是原生 Fetch SDK，但必要模块有明确的 `request` 回调，可以复用上游端点、参数和加密，避开服务端启动入口。该路线无需独立平台 API 服务，也不要求自己实现 AES、MD5 或 RSA。固定 npm 发布包、校验完整性并随插件作者构建打包，用户只安装预构建插件。[4.32.0 元数据](https://registry.npmjs.org/NeteaseCloudMusicApi/4.32.0)、[对应源码发布包](https://registry.npmjs.org/NeteaseCloudMusicApi/-/NeteaseCloudMusicApi-4.32.0.tgz)

当前增强版 `@neteasecloudmusicapienhanced/api@4.41.1` 作为后续协议更新候选；不优先为首个适配引入其播放模块中的无条件解灰工具依赖。`api-framework` 是另一种产品，不能替代网易云 SDK。调查没有找到证据充分、明显更适合本项目且维护成熟的原生 Web/Fetch 网易云 JavaScript SDK；这不是对所有包都不存在的证明。

| 候选 | 实际可复用边界 | 双宿主代价 | 判断 |
|---|---|---|---|
| `NeteaseCloudMusicApi@4.32.0` | `module/*.js` 的 `(query, request)` 与 `util/crypto.js` | 适配 Fetch、Cookie、错误/取消；验证 Node 内置兼容与资源表现 | 首选实测 |
| `@neteasecloudmusicapienhanced/api@4.41.1` | 相同业务回调；新增 xeapi/neapi 加密能力 | 默认请求层有文件、共享会话及更多依赖；播放模块会加载解灰工具 | 协议更新备选 |
| `netease-music-sdk@0.3.3` | 实例客户端和旧 weapi 实现 | Axios 0.17、Node crypto、缺少现有二维码/音质合同证据，还会修改原型 | 不采用 |

## 1 发布物身份与许可

实际读取 npm registry JSON 和对应 tarball，版本元数据如下。`latest` 是调查时结果，接入须使用精确版本与锁文件，不能跟随浮动 `main` 判断已锁依赖。

| 包 | 精确版本 / 发布时间（UTC） | 发布物标识 | 许可证据 |
|---|---|---|---|
| `NeteaseCloudMusicApi`，注意包名大小写 | `4.32.0` / `2026-05-18T02:44:39.777Z` | `gitHead: 4d63e5562199115915f2ee855460ef8999873b53`；registry 未提供 repository 字段 | package.json 与发布包 LICENSE 均 MIT |
| `@neteasecloudmusicapienhanced/api` | `4.41.1` / `2026-10-05T14:42:17.872Z` | npm 该版无 gitHead；GitHub `v4.41.1` 发布指向 `2db6684` | package.json 与发布包 LICENSE 均 MIT |
| `@neteasecloudmusicapienhanced/api-framework` | `1.2.1` | 独立通用反代框架 | 发布包 package.json 声明 GPLv3，LICENSE 也是 GPLv3；README 的 MIT 文案与发布物冲突 |
| `netease-music-sdk` | `0.3.3` | `gitHead: b2c4d8443354f7a48db1e756d9e9a399354888cb` | registry/package.json 声明 MIT |

来源：[原版 registry](https://registry.npmjs.org/NeteaseCloudMusicApi)、[增强版 registry](https://registry.npmjs.org/@neteasecloudmusicapienhanced/api)、[增强版固定发布](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/releases/tag/v4.41.1)、[框架固定发布物](https://registry.npmjs.org/@neteasecloudmusicapienhanced/api-framework/-/api-framework-1.2.1.tgz)、[旧 SDK registry](https://registry.npmjs.org/netease-music-sdk/0.3.3)。原版 GitHub 仓库归档不等于 npm 包已经停止发布，应以所选发布物为准。

两项主要候选的 npm integrity：

```text
NeteaseCloudMusicApi@4.32.0
sha512-yRDwpMcLZnOSkmR/flEpGEJpufNxOQVILb2+2mnSrKPZp/3PbIo2uIOuTa3SjGaAtK3dUKJdQBTkOn0POKDa+A==

@neteasecloudmusicapienhanced/api@4.41.1
sha512-0QDKtLrSLfz4iP2M57nQTqRQuJkzJV2AUOjHSCSBgqOFQEoGkw4zSue8bbfkzz/lFRLvnIr9SjsrPj95BThxUQ==
```

MIT 候选发布包 LICENSE 保留了 Binaryify 的版权声明；插件分发仍须带上 SDK 及实际打包依赖的许可。这里仅记录源码事实，不把文档中出现的其他项目声明当作本包许可。

## 2 首选：复用原版 4.32.0 的必要模块

### 模块接缝

发布包的 `module/login_qr_key.js`、`login_qr_check.js`、`login_status.js`、`login_refresh.js`、`user_playlist.js`、`playlist_detail.js`、`song_detail.js`、`recommend_songs.js`、`recommend_resource.js`、`song_url_v1.js` 均把实际 HTTP 操作交给传入的 `request`。简单模块只导入无外部依赖的 `util/option.js`；该函数将 `query.crypto` 放在模块默认值之前，因此适配器能明确选择上游已有的加密模式。[4.32.0 源码发布包：上述 module 与 util/option.js](https://registry.npmjs.org/NeteaseCloudMusicApi/-/NeteaseCloudMusicApi-4.32.0.tgz)

几个与需求直接相关的实际行为：

| 模块 | 发布包中使用的上游路径/行为 | MusicFS 需承担的语义 |
|---|---|---|
| `login_qr_key` / `login_qr_check` | `/api/login/qrcode/unikey`、`/api/login/qrcode/client/login` | 声明式等待步骤、超时/取消、仅在成功后确认会话 |
| `login_status` / `login_refresh` | 账号状态为 weapi；token 刷新返回 Set-Cookie | 权威检查与会话恢复，按实例存放并条件提交 Cookie |
| `user_playlist` | `uid/limit/offset/includeVideo`，默认 weapi | 全分页；根据上游 owner 等字段区分自建与收藏 |
| `playlist_detail` | `/api/v6/playlist/detail`，请求 `n: 100000` | 验证完整 trackIds，与总数核对；不得把大 n 当作完整性证明 |
| `playlist_track_all` | 先取 trackIds，再按 offset/limit 请求详情，默认 limit 1000 | 不能只看回传详情判定总数；保留原始位置和重复项 |
| `likelist` | 注释明确为无序 ID 集合 | 不能声称此接口保留了喜欢时间顺序；需验证系统喜欢歌单是否提供所需顺序 |
| `song_url_v1` | `/api/song/enhance/player/url/v1`，支持逗号 ID；只依赖 `util/option` | 按响应实际 level/type/试播信息决定导出、隐藏、回退和去重 |

这些是源码路径/参数事实，**不是对应账号内容、权限或可播放性的实测结论**。来源同为 [4.32.0 固定发布包](https://registry.npmjs.org/NeteaseCloudMusicApi/-/NeteaseCloudMusicApi-4.32.0.tgz)。

### 现成密码实现

4.32.0 的 `util/crypto.js` 为 153 行，使用：

- `crypto-js`：AES-CBC/ECB、PKCS#7、MD5；eapi 签名和请求加密已经由上游实现。
- `node-forge`：weapi 的 RSA 公钥操作，上游调用 `forgePublicKey.encrypt(str, 'NONE')`，不是可直接用 RSA-OAEP 替代的协议。
- `zlib`：可选压缩响应解密；还使用全局 `Buffer`。该文件没有增强版新的 X25519/neapi 路径。

原样 `util/crypto.js` 的 SHA-256 为 `79b91bcf6bf67e3da60ef07a02c03adb911b61f31a18b483176d2d755bce8552`。作者构建可导入该文件，不能为了让浏览器构建通过而手抄/删改其中算法。完整依赖 package.json 仍包含服务端框架等内容，因此**安装包大小不等于最终必要模块的插件包大小**，必须测量实际打包图与产物。[4.32.0 util/crypto.js、package.json](https://registry.npmjs.org/NeteaseCloudMusicApi/-/NeteaseCloudMusicApi-4.32.0.tgz)

### 不能使用的默认入口

该版 `main.js` 会扫描文件夹、建立临时匿名 token 文件，并在尾部导入 server；`util/request.js` 顶层读取临时文件、创建 Node HTTP 代理，引用 `global.deviceId`，实际通过 Axios 发请求。没有在其请求参数中发现把 MusicFS `AbortSignal` 传入 Axios 的路径。因此不应把“Bun 能 import 主包”当作完成双宿主接入。[4.32.0 main.js、util/request.js](https://registry.npmjs.org/NeteaseCloudMusicApi/-/NeteaseCloudMusicApi-4.32.0.tgz)

`login_qr_create.js` 虽然可以生成二维码，但顶层导入的 `util/index.js` 又包含 fs/path。它生成的 pc 扫码内容是带 codekey 的网易云登录链接；MusicFS 已有通用二维码展示能力，插件返回这个步骤内容可避免为图片生成引入整条服务端工具依赖。仍需实际扫码验证当前平台是否接受该流程。另 `login_qr_check.js` 的 catch 引用 try 内 `let result`，失败时可能形成二次 ReferenceError；应在插件调用边界统一翻译异常和保留旧状态，不能靠源码补丁伪称已修复上游。[4.32.0 login_qr_create.js、login_qr_check.js、util/index.js](https://registry.npmjs.org/NeteaseCloudMusicApi/-/NeteaseCloudMusicApi-4.32.0.tgz)

## 3 增强版 4.41.1：协议更新候选

增强版同样保留 `(query, request)`，但当前 `module/song_url_v1.js` 在函数内无条件 require `@neteasecloudmusicapienhanced/unblockmusic-utils` 与 `dotenv.config()`，之后才判断 `query.unblock === 'true'`；正常播放默认 `createOption(query, 'xeapi')`。检查 4.37.0、4.38.0、4.39.0、4.40.1 的发布包也有该无条件依赖和 xeapi 默认值；简单退一个小版本并不能消除此耦合。[4.41.1 发布包](https://registry.npmjs.org/@neteasecloudmusicapienhanced/api/-/api-4.41.1.tgz)、[4.37.0 发布包](https://registry.npmjs.org/@neteasecloudmusicapienhanced/api/-/api-4.37.0.tgz)

`util/crypto.js` 当前原样内容的 SHA-256 为 `45bdb719176d66d864f876da3d7436eab5d99a37f031d1f6fd5025b4191c577c`。除了 CryptoJS/forge，还顶层依赖 Node crypto、zlib 和 zstd 工具，含 X25519、AES-GCM、ChaCha20-Poly1305 等现成实现。不能把“使用 Node crypto”直接等同于“必须付费”或“不可能在 Worker 运行”；但整个 CJS 文件的可打包性、初始化和所有静态依赖需要实际验证。[增强版 crypto 原始源码](https://raw.githubusercontent.com/NeteaseCloudMusicApiEnhanced/api-enhanced/main/util/crypto.js)、[4.41.1 发布包](https://registry.npmjs.org/@neteasecloudmusicapienhanced/api/-/api-4.41.1.tgz)

更关键的是默认 `util/request.js` 的状态所有权：顶层匿名 token 和 xeapi 公钥文件、全局 WNMCID/NMTID、xeapiSessionId/Key、neapiUserStatus 与共享刷新 Promise。直接复用这个单例可能让实例或 Worker 请求共享不应共享的状态；仅改 Axios adapter 并不能解决。建议若未来确实需要 xeapi/neapi，先确认该协议所需的实例状态，再使用现成密码函数和明确的实例级传输边界，或优先推动上游提供客户端工厂。[增强版 request 原始源码](https://raw.githubusercontent.com/NeteaseCloudMusicApiEnhanced/api-enhanced/main/util/request.js)

## 4 排除项与 Web SDK 替代

`@neteasecloudmusicapienhanced/api-framework@1.2.1` 的 README 明说其不包含平台密码协议；发布包 `util/request.js` 是 Axios 包装，`main.js` 仍通过 fs 动态扫描业务文件，并没有 Fetch 注入 API。引入它后仍需自行实现网易云协议，同时再引入一套服务器/配置/缓存设施，不能减少 MusicFS 的必要适配代码。README 的 MIT 与实际 GPLv3 文件不一致也是额外维护问题；无需为了本任务引入它。[维护方说明](https://github.com/NeteaseCloudMusicApiEnhanced/api-framework)、[固定发布包](https://registry.npmjs.org/@neteasecloudmusicapienhanced/api-framework/-/api-framework-1.2.1.tgz)

`netease-music-sdk@0.3.3` 提供 TypeScript 声明与实例 `MusicClient`，但发布包 `lib/lib/request.js` 直接使用 Axios，未发现注入 Fetch/Signal 的参数；`lib/lib/crypto.js` 使用 Node crypto、big-integer，且写入 `String.prototype.hexEncode`。该版本依赖 Axios `^0.17.1`，没有在本次源码检查中找到完整二维码认证及当前多种音质支持的证据。它没有比原版必要模块更清晰的本项目接入边界，不推荐用这个更旧的实现替换当前维护的协议库。[维护方仓库](https://github.com/XGHeaven/netease-music-sdk)、[0.3.3 固定发布包](https://registry.npmjs.org/netease-music-sdk/-/netease-music-sdk-0.3.3.tgz)

本次也检索了 Web/Worker/Fetch 相关维护方项目和增强版列出的 SDK 生态；可见 Java、Python、Swift、Rust 移植，以及需要另启 API 服务的客户端。没有找到足够的发布/源码证据证明其中有比上述方案更合适的成熟、原生 Fetch JavaScript 库。Rust/Wasm 移植不是本任务的优先替代：它会增加构建和状态/网络桥接边界，且还需要重做本项目宿主验收；这是一项维护成本判断，不是声称 Wasm 无法运行。[增强版 SDK 生态](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)、[维护方 Rust SDK 文档](https://docs.rs/ncm-api-rs/latest/ncm_api_rs/)

## 5 普通 Worker 的验证条件

Cloudflare 官方当前文档称 `node:crypto` 除列出的 DSA/DH keypair、argon2、UUIDv7、ed448/x448、FIPS 等例外外受支持；Node 兼容由 compatibility date/flag 控制。该兼容开关本身不能作为需要付费产品的证据。采用适当兼容日期的普通 Worker，因此有理由先实测原样密码模块，不必立即更换付费宿主或自写算法。[Node crypto 支持](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)、[Node 兼容](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)

这仍不能证明免费额度足够。官方当前限制包含每个请求 10 ms CPU、50 次 subrequest、128 MB isolate 内存；网络等待与 CPU 计时不同。需测量目录分页、批量详情和音质解析的实际工作量，避免“每首歌 × 每个音质一个请求”导致超限。完整刷新应使用有边界的分页/批量任务，且最终只发布完整成功快照。[Workers 资源限制](https://developers.cloudflare.com/workers/platform/limits/)

主代理接入时的必要验收门槛：

1. **原样代码与产物边界**：固定发布包与 lockfile；作者构建只选必要模块；产物无 Express 服务、fs 临时 token、解灰器、外部 API 服务及修改后的 SDK 密码源码。用实际插件包运行 Bun 和 workerd，不仅做 TypeScript 编译。
2. **网络与隔离**：所有上游请求经过当次插件调用的 Fetch/AbortSignal；Cookie、设备标识、认证待办和刷新结果按实例保存；两个交错账号不能共用凭据或请求 Promise。Set-Cookie 用成熟解析/存储依赖处理，不能按逗号拆分 Expires。
3. **认证与恢复**：真实扫码、状态权威确认、进程重启恢复、失效/刷新、取消和旧任务竞争。会话保持属于插件私有状态，不引入核心的网易云分支。
4. **内容与播放**：喜欢顺序、歌单归属与完整分页；实际 level/type、试听/无完整地址、单/多版本和去重；新解析的 URL 用于真实 HEAD/范围读取，不把短期 URL 放入稳定文件引用。
5. **普通免费 Worker**：实际 CPU、subrequest、包大小、初始化、取消/网络失败/最后成功快照保留与发布验证。若超限，先定位调用粒度/实现开销；有证据后再决定是否需要改变已确认部署前提。

这些门槛的全部通过尚未证明，以下记录已经执行的具体范围。

## 6 首条可安装链路的实际接入记录

已落地 [网易云插件](../../plugins/netease/README.md)与 [author build](../../scripts/build-netease.ts)，固定 `NeteaseCloudMusicApi@4.32.0`、`tough-cookie@6.0.2`。主代理统一安装并维护根锁文件；没有修改 SDK 源码或替换其密码算法。CookieJar 按实例序列化保存，Fetch 直接使用当次调用的取消信号。

Bun 的浏览器目标最初会把上游 CJS 内置模块加载留成动态 require；直接 external 在 Worker 中启动失败。随后显式把原始 `require('crypto'/'zlib')` 连接到静态命名空间导入，并保留外部 `node:crypto`、`node:zlib`，实际产物中没有 Bun 浏览器版这两个内置模块的替代实现。中途也检查出虚拟 namespace 被自动 polyfill 的结果，该中间产物没有作为原生模块成功证据。

最终执行结果：

| 入口 | 已观察到的结果 | 不能据此声称 |
|---|---|---|
| `bun test tests/netease-plugin.test.ts` | 9 项 / 47 断言通过；原样 SDK 回调/密码代码配合可控 Fetch，覆盖 Cookie 范围/保存恢复、确认后暂时失败、取消、原生集合归属、完整分页/重复位置、分页变化、试播隐藏、真实字节流边界和信号传递 | 实际账号登录、实际平台内容或真实 CDN 音频通过 |
| 聚焦严格 TypeScript 检查 | 网易云插件、作者构建、探针和聚焦测试通过仓库相同严格类型选项 | 全仓库检查通过 |
| `bun run scripts/probe-worker-netease.ts` 的 Bun 路径 | 动态导入预构建插件；原生密码依赖可加载；实际取得网易云扫码二维码 | 手机授权与会话恢复已经实测 |
| 同一探针的本地 workerd 路径 | 静态导入预构建插件，启用 `nodejs_compat`；正式管理 API 建立两个独立 CookieJar 的 D1 实例；实际取得网易云扫码二维码 | 已云端部署，或已满足普通免费计划 CPU/请求预算 |

最终 alpha.1 产物为 `dist/netease/org.musicfs.netease.zip`；每次作者构建都随包生成完整第三方许可（含 CryptoJS、forge、tough-cookie、tldts/tldts-core、Zod、Ajv）。扫码/播放真实验收入口及显式会话恢复探针见 [插件说明](../../plugins/netease/README.md)。

首次冻结 alpha.1 时只有首条开发预览链路，**完整网易云示例仍未完成**：当时没有真实扫码账号或真实音频证据；音质只有单版本隐藏，尚无完整多版本/向下回退/实际版本去重和会话续期；所有适用内容/权限、大集合、云端与免费资源预算仍须继续验证。后续真实扫码与内容反馈见下节。

## 7 真实分页反馈后的 alpha.2 修正

主代理随后通过正式界面确认了真实扫码完成和五个内容入口；实例刷新时四个目录成功，喜欢目录返回“不一致的音频列表”。只读诊断反馈：喜欢的第 0 页请求/返回均为 100 个编号，得到 100 曲/36 个导出文件；第 1 页请求 100 个唯一编号，实际返回 102 行、100 个唯一编号，没有未知编号。另外每日推荐 30 曲/18 个文件成功。这里只记录脱敏计数，不保存真实账号、曲目或音频地址。

进一步逐字段比较推翻了“只是相同表示重复”的最初候选：两组相同歌曲编号分别对应 standard/lossless、MP3/FLAC，大小、MD5、试听信息和临时地址不同。问题是把歌曲编号当作响应行唯一键。alpha.2 的最小修正为：

- 每行编号必须属于本次请求，且所有请求编号至少出现一次；未知和缺少编号继续失败。
- 先选择目标 level 的完整非试听候选；其他 level 不触发隐式回退。
- 类型名只做大小写规范后验证已有 mp3/flac/m4a 白名单。
- 同编号、同目标 level 的候选，只有实际引用（编号、level、格式、MD5、大小）一致时合并；临时地址不作为文件身份。同目标 level 的不同实际文件继续明确失败。

新增一项包含 100 个请求编号/102 行原生多音质形状的回归，连同大写格式、相同实际文件不同短期地址、禁止隐式回退及冲突/未知/缺少编号反例。该回归对 SHA-256 为 `0760980fbaaae1c1f6020b55dc07b4a394a5828b18e4d218b1e500e6007ceeb7` 的原始 alpha.1 bundle 重放时红色，复现相同“不一致的音频列表”；修正后 `bun test tests/netease-plugin.test.ts` 为 10 项 / 57 断言通过，聚焦严格类型检查通过。未修改上游 SDK、密码代码或配置/私有状态版本。

alpha.2 构建安装及原账号喜欢全目录的正式刷新复测由主代理继续，不能把这次模拟回归通过等同于原场景已经恢复；真实音频、会话续期和完整音质策略仍按主线证据分别验收。

## 8 alpha.3 音质策略候选

主线随后记录了 alpha.2 的真实喜欢完整刷新（4158 曲）、标准/隐藏下的每日推荐与 MP3 全文/范围/rclone、workerd 实际会话恢复等证据，详见 [真实来源验收](../verification/p2-netease-source.md)。这些都是 alpha.2 的验证范围。

alpha.3 源码候选按 FR08/FR18 接入单/多版本、隐藏/向下回退、实际标签、相同实际引用去重和可累加目录统计。维持当前已适配的四档，向下顺序为 Hi-Res、无损、极高、标准；特殊音效或未知格式没有借此扩入。每页按唯一歌曲和请求档位做批量/调用内缓存，最后按原始出现位置导出。

配置兼容没有采用隐藏旧字段或核心来源分支：`quality` 正式保留为单版本目标；新增 `audio` 管理模式、多版本目标与缺失策略。这样旧 `quality: "exhigh"` 在运行时和通用 RJSF 表单中都能保留原值，多版本目标不受旧单目标限制。config/state/file reference 版本保持兼容。

仅重新生成网易云私有 Ajv standalone 验证器，未执行 ZIP 作者构建、安装或访问真实账号。`bun test tests/netease-plugin.test.ts` 为 16 项 / 98 断言通过，包含旧配置、多目标同实际引用合并、不同实际版本、重复出现位置、实际降级策略、试听排除、暂时/认证/限流/未知格式不降级，以及文件读取不回退；聚焦严格 TypeScript 检查通过。

候选源码测试通过不等于实际交付完成。alpha.3 的统一构建安装、真实账号多音质、workerd 和新增多目标请求/CPU 预算仍由主线继续验收；不把 alpha.2 的证据改写为 alpha.3 已通过。

主线随后统一构建安装alpha.3（ZIP245,489字节），真实每日30曲的无损/标准多目标+回退导出35文件，实际极高MP3 17、标准MP3 18，Bun与本地workerd统计一致；7,734,765字节实际极高MP3的DAV/rclone完整与范围通过。真实FLAC、免费云端CPU/请求、续期仍未验；证据统一见[真实来源记录](../verification/p2-netease-source.md)。
