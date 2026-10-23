# 开发探针与专项验证

按本次改动选择需要的入口。日常启动、构建和交付见[开发指南](development.md)；已有结果查[验收台账](verification.md)。

## 专项命令

| 命令 | 验证内容 |
|---|---|
| `bun run check` | 构建最小/QQ/网易云插件、严格类型检查、导入图检查、自动化测试；任一步失败即停止 |
| `bun test tests/management-auth.test.ts tests/worker-management-auth.test.ts` | 单管理员的 Bun SQLite / 本地 workerd D1 会话旅程，以及正式 Worker 产物的共用管理 API 接线；不访问云端或音乐平台 |
| `bun test tests/desktop-integration.test.ts tests/desktop-mount-restore.test.ts tests/desktop-listener.test.ts tests/desktop-background.test.ts` | 原生事件桥、逐项恢复与手动操作优先、监听切换、后台设置与退出；使用临时数据及受控组件 |
| `cargo test --locked --manifest-path native/desktop/Cargo.toml` | 原生辅助程序的协议与启动参数编码；不启用真实系统自启 |
| `bun test tests/plugin-migration-source.test.ts tests/plugin-change-persistence.test.ts tests/plugin-migration-desktop.test.ts tests/worker-publishing.test.ts tests/migrations.test.ts` | 迁移转换、SQLite/D1原子激活、正式桌面更新/重启、Worker新调用接棒及旧数据库升级；使用独立临时数据 |
| `bun test tests/source-authentication-completion.test.ts` | 两个真实示例经正式管理认证入口完成授权，资料请求临时失败独立重试、旧QR期限不使已完成操作退回过期；使用受控上游 |
| `bun run build:sample` | 同一 JSON Schema 生成 Ajv standalone 校验，构建浏览器兼容 ESM 并生成 ZIP |
| `bun run build:qq` | 构建 QQ 开发预览与必要许可，生成固定 SDK 原始读取入口、固定日志设置以消除 process 依赖；生成 dist/plugins/org.musicfs.qq.zip |
| `bun run probe:worker:qq` | 实际 QQ 打包模块在本地 workerd/D1、无 Node 兼容开关；状态隔离、受控SDK续期/双控制器合并/密文跨运行时恢复及正式管理路由完成认证；可显式选择真实开发会话 |
| `bun run build:netease` | 固定 4.32.0 必要 SDK 模块、原样加密及 Ajv standalone，输出 dist/netease/org.musicfs.netease.zip |
| `bun run probe:worker:netease` | 实际网易云 ESM 在 Bun/workerd 请求真实二维码；可显式选取已授权实例验证 D1 会话恢复和每日目录；需要网络 |
| `bun scripts/probe-netease-refresh-offline.ts` | 实际网易云打包SDK与正式Worker service，在本地workerd/D1使用受控响应检查冷热刷新、每步SQL及共享封面；不访问真实平台 |
| `bun run build:worker` | 组装正式 Worker core/薄入口/独立 registry、WebUI、模板及 D1 迁移；使用 `workerd` 条件选择原生密码实现，可附已有插件 ZIP 路径 |
| `bun run probe:worker:service` | 实际正式入口在本地 workerd 的页面/API/DAV、D1重启、未配置发布凭据及坏插件启动拒绝 |
| `bun scripts/probe-worker-refresh.ts` | 正式 Worker service 的 42 页独立 HTTP 推进、D1重启续接、每步查询数量及4,158文件allprop无逐项来源读取；使用本地来源样本，不证明云端免费 CPU |
| `bun scripts/probe-worker-refresh.ts --cpu-profile /tmp/musicfs-dav-worker.cpuprofile` | 同一正式本地链路准备后采样一次DAV allprop的用户isolate，保存可由DevTools打开的V8 profile；不是云端计费CPU |
| `bun scripts/probe-dav-resources.ts` | 已准备描述的纯XML耗时/CPU/内存增量，1/100/4,657文件；不是云端CPU或峰值内存验收 |
| `bun run build:desktop -- --target linux-x64` | 构建所选桌面目标，含共用页面、原生辅助程序、rclone 和三个插件 ZIP；目标工具链见[辅助程序 README](../native/desktop/README.md)，`--all` 需要四个目标的完整链接环境 |
| `bun run build:author-kit` | 生成公开类型/最小插件/构建器/文档及独立锁文件，不带核心、页面或来源SDK |
| `bun run package:release -- --targets windows-x64,linux-x64` | 将选定桌面目标、Worker、作者包和源码归档，生成统一清单与 SHA256SUMS；默认选择全部四目标 |
| `bun scripts/probe-desktop-product.ts --mount` | 在原生Linux运行实际发行物、外置sample、后台复用及真实FUSE全文/偏移/忙卸载/退出；不用源码服务代替发行物 |
| `bun scripts/probe-desktop-product.ts --mount --crash-recovery` | 同一临时FUSE挂载两次SIGKILL后台；验证保留原端口与原rclone，以及端口被占用后的明确需重挂/正常重挂。只终止探针临时后台，约需两次30秒锁恢复 |
| `bun run build:web` | 构建共用 React/Vite 页面至 dist/web |
| `bun run build:auth-fixture` | 开发专用的“非真实音源”认证测试包，生成至 dist/p0/authentication-fixture.zip |
| `bun run dev:service` | 用显式测试凭据启动 127.0.0.1:8787 的开发服务，状态保存在 dist/dev-data，同时提供已构建页面 |
| `bun run dev:web` | 127.0.0.1:5173 的 Vite 开发服务器，管理/DAV 请求代理到开发服务 |
| `bun run probe:compiled` | 构建当前宿主的独立二进制，在临时目录安装外置插件、持久化双实例，再启动第二个进程读回 |
| `bun run probe:worker` | 构建固定模块集合，在本地 Miniflare/workerd 中验证 ZIP、校验、插件流、D1 条件更新与重启；需要本地回环端口 |
| `bun run probe:worker:dav` | 同一 Fetch DAV 在本地 workerd/D1 读取真实样本字节，验证 XML、HEAD、固定长度及范围 |
| `bun run probe:worker:authentication` | 同一正式管理路由在本地 workerd/D1 验证认证恢复、实例隔离、输入失败和真实延迟上游在取消后的旧结果拒绝 |
| `bun run fetch:rclone:linux` | 从官方地址取得固定 Linux 探针版本并核对已固定 SHA-256，仅写入 dist/tools，需要网络 |
| `bun scripts/probe-mount-cache.ts` | WSL/Linux原生FUSE的4k离线目录首次/立即/跨旧5秒边界重进；也验证手动保留/刷新后看到新条目，不读真实平台 |
| `bun scripts/probe-playback-cost.ts` | 有效生成音频、实际网易云打包SDK及本机挂载，比较预读策略的来源请求和读取等待；不是平台限流或真实音质测试 |
| `bun scripts/probe-shared-dav-cache.ts` | 正式桌面共享读取Module、生成音频及FFprobe，验证同范围/重叠复用、更新身份、取消、重建与清理；需回环监听 |
| `bun run probe:rclone` | 已核验 rclone 经临时真实 HTTP 服务列目录、完整/随机读取；可用 MUSICFS_RCLONE 指定其他已验证二进制 |


## 可选真实来源复测

QQ 的真实授权/字节验证见[首条链路](verification/p1-qq-source.md)，原始分类、SDK 适配和当前缺口见[后续记录](verification/p2-qq-catalog.md)。本地 workerd 复测已有开发会话时，显式设置 `MUSICFS_QQ_TEST_STATE_DB`（开发 SQLite 的绝对路径）及 `MUSICFS_QQ_TEST_INSTANCE_ID`，再运行 `bun run probe:worker:qq`。脚本只读所选 QQ 实例的私有状态，在临时 D1 恢复后校验真实账号、每日推荐、自建/收藏和有限推荐集合，最后清理；不输出凭据，不执行云部署或重新扫码。

默认QQ Worker探针另验证实际安装ESM的认证底层取消，无Node兼容开关。显式设置`MUSICFS_QQ_LIVE_QR_PROBE=1`时，它在本地workerd正式管理入口分别创建QQ/微信二维码、未扫码轮询并取消，不要求人扫码、不复用或改变真实账号。这项需要访问平台网络；二维码、密文和会话不打印，不代表真实Cloudflare出口或新的人为扫码已验。

网易云对应设置 `MUSICFS_NETEASE_TEST_STATE_DB` 和 `MUSICFS_NETEASE_TEST_INSTANCE_ID`，运行 `bun run probe:worker:netease`。它只读该实例私有状态，恢复到临时 D1 后读取真实每日推荐，不重新消费原二维码；当前[实测记录](verification/p2-netease-source.md)包括完整喜欢和真实 MP3。

通用真实 DAV 字节复测入口为：

```sh
bun scripts/probe-real-dav.ts --path-file /tmp/selected-library-path.txt
```

路径文件只保存一个已发布的绝对 library 文件路径，例如 `/分组/文件.mp3`。先显式设置 `MUSICFS_DAV_ORIGIN`、`MUSICFS_DAV_USERNAME`、`MUSICFS_DAV_PASSWORD`；不要在文档或命令示例中写真实凭据。脚本检查 HEAD/完整 GET/五种范围/416，最多读取 64 MiB，输出计数和 SHA-256，不打印路径。`--save /tmp/audio.mp3` 可供本地媒体格式检查；提供 `MUSICFS_RCLONE` 时，还验证该已校验二进制的列表、完整下载与前后偏移。脚本不执行系统挂载，也不等同于普通播放器实播。

## 独立播放器复测

先通过正式管理页面准备目录，再把一个DAV文件URL或OpenList生成的代理下载URL写入私有临时文件：

```sh
bun scripts/probe-player.ts --url-file /tmp/selected-audio-url.txt --output /tmp/player-result.json
```

默认执行已安装的`mpv`，可用`MUSICFS_MPV`显式指定受信任二进制；脚本不下载或安装播放器。直接DAV需要将读取Basic认证头放在`MUSICFS_PLAYER_AUTHORIZATION`环境变量中，OpenList已签名代理URL通常不需要该头。`MUSICFS_PLAYER_AUDIO_OUTPUT`可选明确音频输出（本次为`pulse`）；凭据和URL不打印、不写入仓库。

成功报告记录加载到播放、各次定位恢复的实际耗时；命令超时包含命令/属性名和私有日志位置。等待超时仍按未通过处理，先定位失败再决定下一次验证，不通过反复延长等待取得通过结论。

脚本通过Unix IPC控制真实播放器，在实际输出设备上静音播放，检查解码、时间前进与五次双向seek后的恢复；拒绝仅null输出。它适用于Linux/macOS的验证宿主，不是产品播放器或Windows验收程序。默认不运行于`bun run check`，也不自动下载整个媒体或重复DAV字节矩阵。失败日志留在脚本报出的临时目录，成功清理。实际版本/结果见[客户端记录](verification/p2-clients.md)。

