# 网易云双宿主插件的 SDK 与请求边界调查

日期：2026-10-20  
范围：MusicFS 网易云示例插件的扫码登录、会话、歌单/推荐与播放地址。仅查维护方源码、npm 发布元数据和 Cloudflare 官方文档；下载发布包到 `/tmp`，未安装依赖、修改 SDK、构建仓库或运行宿主验证。下文“事实”来自实际发布包，“建议/推断”是本项目判断，不能作为网易云链路已经通过的证据。

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

这些门槛是后续实施清单，本研究没有将任何一项标记为已通过。
