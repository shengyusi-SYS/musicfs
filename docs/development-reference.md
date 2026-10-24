# 开发检查与专项诊断

日常开发与构建见[开发指南](development.md)，平台和格式范围见[兼容性说明](verification.md)。按改动选择相关测试，不要求每次跑完整矩阵。

## 日常检查

```sh
bun run typecheck
bun run check:boundaries
bun run check:i18n
bun test
```

`bun run check` 顺序构建页面和示例插件，并运行上述检查。只改文档时核对链接即可；改 UI 时补实际操作流程；改文件表示时关注大小、身份、Range 和缓存复用。

## 专项探针

可复用诊断入口统一位于 `scripts/probes/`，运行所需的宿主样本位于 `tests/probes/`。先用 `bun run build` 生成页面和示例插件；探针的临时或构建结果保存在忽略目录，原始回执不写入文档目录。

| 要检查的行为 | 命令 | 运行条件 |
|---|---|---|
| 单管理员与浏览器会话 | `bun test tests/management-auth.test.ts tests/worker-management-auth.test.ts` | 本地 SQLite、workerd/D1 |
| 插件编译后加载与持久化 | `bun run probe:compiled` | 当前宿主的 Bun 编译环境 |
| Worker 插件合同与文件读取 | `bun run probe:worker`、`bun run probe:worker:dav` | 本地 workerd，无云部署 |
| 正式 Worker 页面/API/DAV | `bun run probe:worker:service` | 本地 workerd 与已构建资源 |
| 冷热刷新及存储调用 | `bun scripts/probes/netease-refresh-offline.ts` | 受控上游，不访问音乐平台 |
| DAV XML 的局部成本 | `bun scripts/probes/dav-resources.ts` | 本地合成目录 |
| 标签与最终文件读取 | `bun scripts/probes/worker-audio-metadata.ts` | 合成音频、本地 D1/DAV |
| 原生 rclone 客户端 | `bun run probe:rclone` | 已安装或构建缓存中的 rclone |
| 挂载目录与读取缓存 | `bun scripts/probes/mount-cache.ts`、`bun scripts/probes/mount-reads.ts` | 可用的本机 FUSE |
| 直接 DAV 共享字节缓存 | `bun scripts/probes/shared-dav-cache.ts` | rclone、FFprobe 和回环监听 |
| 目录定向失效 | `bun scripts/probes/directory-invalidation.ts` | rclone 与回环监听，结果输出到终端 |
| 正式桌面程序与挂载 | `bun scripts/probes/desktop-product.ts --mount` | 已构建发行物、当前系统挂载条件 |

其他探针按文件名区分主题。固定版 rclone 的下载入口为 `bun run fetch:rclone:linux`，只在现有二进制不可用时需要。日志排查见[日志设计](architecture/logging.md)。

## 可选真实来源复测

QQ 的真实授权/字节验证见[首条链路](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p1-qq-source.md)，原始分类、SDK 适配和当前缺口见[后续记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p2-qq-catalog.md)。本地 workerd 复测已有开发会话时，显式设置 `MUSICFS_QQ_TEST_STATE_DB`（开发 SQLite 的绝对路径）及 `MUSICFS_QQ_TEST_INSTANCE_ID`，再运行 `bun run probe:worker:qq`。脚本只读所选 QQ 实例的私有状态，在临时 D1 恢复后校验真实账号、每日推荐、自建/收藏和有限推荐集合，最后清理；不输出凭据，不执行云部署或重新扫码。

默认QQ Worker探针另验证实际安装ESM的认证底层取消，无Node兼容开关。显式设置`MUSICFS_QQ_LIVE_QR_PROBE=1`时，它在本地workerd正式管理入口分别创建QQ/微信二维码、未扫码轮询并取消，不要求人扫码、不复用或改变真实账号。这项需要访问平台网络；二维码、密文和会话不打印，不代表真实Cloudflare出口或新的人为扫码已验。

网易云对应设置 `MUSICFS_NETEASE_TEST_STATE_DB` 和 `MUSICFS_NETEASE_TEST_INSTANCE_ID`，运行 `bun run probe:worker:netease`。它只读该实例私有状态，恢复到临时 D1 后读取真实每日推荐，不重新消费原二维码；当前[实测记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p2-netease-source.md)包括完整喜欢和真实 MP3。

通用真实 DAV 字节复测入口为：

```sh
bun scripts/probes/real-dav.ts --path-file /tmp/selected-library-path.txt
```

路径文件只保存一个已发布的绝对 library 文件路径，例如 `/分组/文件.mp3`。先显式设置 `MUSICFS_DAV_ORIGIN`、`MUSICFS_DAV_USERNAME`、`MUSICFS_DAV_PASSWORD`；不要在文档或命令示例中写真实凭据。脚本检查 HEAD/完整 GET/五种范围/416，最多读取 64 MiB，输出计数和 SHA-256，不打印路径。`--save /tmp/audio.mp3` 可供本地媒体格式检查；提供 `MUSICFS_RCLONE` 时，还验证该已校验二进制的列表、完整下载与前后偏移。脚本不执行系统挂载，也不等同于普通播放器实播。

## 独立播放器复测

先通过正式管理页面准备目录，再把一个DAV文件URL或OpenList生成的代理下载URL写入私有临时文件：

```sh
bun scripts/probes/player.ts --url-file /tmp/selected-audio-url.txt --output /tmp/player-result.json
```

默认执行已安装的`mpv`，可用`MUSICFS_MPV`显式指定受信任二进制；脚本不下载或安装播放器。直接DAV需要将读取Basic认证头放在`MUSICFS_PLAYER_AUTHORIZATION`环境变量中，OpenList已签名代理URL通常不需要该头。`MUSICFS_PLAYER_AUDIO_OUTPUT`可选明确音频输出（本次为`pulse`）；凭据和URL不打印、不写入仓库。

成功报告记录加载到播放、各次定位恢复的实际耗时；命令超时包含命令/属性名和私有日志位置。等待超时仍按未通过处理，先定位失败再决定下一次验证，不通过反复延长等待取得通过结论。

脚本通过Unix IPC控制真实播放器，在实际输出设备上静音播放，检查解码、时间前进与五次双向seek后的恢复；拒绝仅null输出。它适用于Linux/macOS的验证宿主，不是产品播放器或Windows验收程序。默认不运行于`bun run check`，也不自动下载整个媒体或重复DAV字节矩阵。失败日志留在脚本报出的临时目录，成功清理。实际版本/结果见[客户端记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p2-clients.md)。

