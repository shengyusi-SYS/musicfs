# MusicFS 开发与验证

当前已有开发 alpha：插件、实例、目录、DAV、共用页面、QQ 与网易云实际来源，正式桌面启动/挂载及 Worker 后台发布也已接线；完整双宿主验收仍在推进。主线和验收见[目标](codex-goal.md)与[台账](verification.md)；下面的命令用于开发验证，不是普通用户必须操作的 CLI。

## 环境与入口

使用 `package.json` 指定的 Bun 版本；依赖以 `bun.lock` 为准。依赖图工具通过 Node 运行，本轮实际验证 Node v24.19.0。先安装依赖：

```sh
bun install --frozen-lockfile --ignore-scripts
```

从仓库根目录执行：

| 命令 | 验证内容 |
|---|---|
| `bun run check` | 构建最小/QQ/网易云插件、严格类型检查、导入图检查、自动化测试；任一步失败即停止 |
| `bun test tests/plugin-migration-source.test.ts tests/plugin-change-persistence.test.ts tests/plugin-migration-desktop.test.ts tests/worker-publishing.test.ts tests/migrations.test.ts` | 迁移转换、SQLite/D1原子激活、正式桌面更新/重启、Worker新调用接棒及旧数据库升级；使用独立临时数据 |
| `bun test tests/source-authentication-completion.test.ts` | 两个真实示例经正式管理认证入口完成授权，资料请求临时失败独立重试、旧QR期限不使已完成操作退回过期；使用受控上游 |
| `bun run build:sample` | 同一 JSON Schema 生成 Ajv standalone 校验，构建浏览器兼容 ESM 并生成 ZIP |
| `bun run build:qq` | 构建 QQ 开发预览与必要许可，生成固定 SDK 原始读取入口、固定日志设置以消除 process 依赖；生成 dist/plugins/org.musicfs.qq.zip |
| `bun run probe:worker:qq` | 实际 QQ 打包模块在本地 workerd/D1、无 Node 兼容开关；状态隔离、受控SDK续期/双控制器合并/密文跨运行时恢复及正式管理路由完成认证；可显式选择真实开发会话 |
| `bun run build:netease` | 固定 4.32.0 必要 SDK 模块、原样加密及 Ajv standalone，输出 dist/netease/org.musicfs.netease.zip |
| `bun run probe:worker:netease` | 实际网易云 ESM 在 Bun/workerd 请求真实二维码；可显式选取已授权实例验证 D1 会话恢复和每日目录；需要网络 |
| `bun scripts/probe-netease-refresh-offline.ts` | 实际网易云打包SDK与正式Worker service，在本地workerd/D1使用受控响应检查冷热刷新、每步SQL及共享封面；不访问真实平台 |
| `bun run build:worker` | 组装正式 Worker core/薄入口/独立 registry、WebUI、模板及迁移；可附已有插件 ZIP 路径 |
| `bun run probe:worker:service` | 实际正式入口在本地 workerd 的页面/API/DAV、D1重启、未配置发布凭据及坏插件启动拒绝 |
| `bun scripts/probe-worker-refresh.ts` | 正式 Worker service 的 42 页独立 HTTP 推进、D1重启续接、每步查询数量及4,158文件allprop无逐项来源读取；使用本地来源样本，不证明云端免费 CPU |
| `bun scripts/probe-worker-refresh.ts --cpu-profile /tmp/musicfs-dav-worker.cpuprofile` | 同一正式本地链路准备后采样一次DAV allprop的用户isolate，保存可由DevTools打开的V8 profile；不是云端计费CPU |
| `bun scripts/probe-dav-resources.ts` | 已准备描述的纯XML耗时/CPU/内存增量，1/100/4,657文件；不是云端CPU或峰值内存验收 |
| `bun run build:desktop -- --all` | 构建四个桌面目标，含共用页面、校验后的 rclone 和三个插件 ZIP；具体参数见[桌面说明](desktop.md) |
| `bun run build:author-kit` | 生成公开类型/最小插件/构建器/文档及独立锁文件，不带核心、页面或来源SDK |
| `bun run package:release` | 从已有正式构建生成四目标/Worker/作者ZIP、独立插件、统一清单与SHA256SUMS；拒绝混用源码/页面/插件版本 |
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
| `bun run probe:rclone` | 已核验 rclone 经临时真实 HTTP 服务列目录、完整/随机读取；可用 MUSICFS_RCLONE 指定其他已验证二进制 |

`dev:service` 需要开发者显式设置 `MUSICFS_ADMIN_TOKEN` 和 `MUSICFS_DAV_PASSWORD`，开发 DAV 用户名为 `musicfs`；不能把测试凭据当作发行默认值。构建前端后可直接打开 8787 服务，或用 Vite 开发；页面手动输入管理令牌，也可由启动入口经 fragment 传入并立即移除。[正式桌面启动器](desktop.md)另行生成私有凭据、持有后台并管理挂载；开发服务不装配本机挂载或退出接口。

最小/QQ 包分别输出到 `dist/plugins/org.musicfs.sample.zip` 和 `dist/plugins/org.musicfs.qq.zip`，网易云输出到 `dist/netease/org.musicfs.netease.zip`；正式宿主输出到 `dist/desktop/` 和 `dist/worker/`。编译基础探针输出到 `dist/p0/`。这些目录不进入版本控制。插件生成的校验代码在构建时产生；其 `.d.mts` 类型声明随源码保存。

统一发行在源码冻结后顺序执行，避免探针覆盖正式Worker目录：

```sh
bun run build:desktop -- --all
bun run build:worker dist/plugins/org.musicfs.sample.zip dist/plugins/org.musicfs.qq.zip dist/netease/org.musicfs.netease.zip
bun run build:author-kit
bun run package:release
```

`build:desktop`已构建共用页面及三个插件；Worker命令必须显式选择这三个插件，空参数仍表示空注册表。`package:release`只打包既有产物，不偷偷重建；各包写入同一源码内容摘要、页面摘要与插件修订，发生输入变更则先重建。每次发行的 ZIP、`plugins/`、`release-manifest.json` 和 `SHA256SUMS` 放在 `dist/releases/<版本>/`；先进入对应版本目录执行 `sha256sum -c SHA256SUMS`，再解压目标包验收。重新打包同版本会在全部打包成功后替换该版本目录，其它版本保持不变。构建身份保留基线Git提交与dirty标志，并以实际内容摘要判断输入是否一致，不把工作区构建描述成干净提交构建。

作者旅程见[指南](plugin-authoring.md)。在仓库外构建后，可运行`bun scripts/probe-desktop-product.ts --plugin-archive /绝对路径/自有插件.zip --plugin-id 自有插件ID`验证与最小示例相同合同的已知音频及双实例；此参数只用于该验收样本，不适用于任意插件音频。系统解压后的产品验收增加`--directory /绝对路径/解压目录`。探针不重建应用，本轮结果见[发行记录](verification/p4-release-artifacts.md)。

## 从源码发行包构建

`musicfs-<版本>-source.zip`提供同次发行的项目源码、构建/测试入口、锁文件和文档，不包含`.git`历史、已安装依赖或用户数据。`SOURCE.md`保留原发行身份。使用锁定的Bun，以及开发检查需要的Node和Git；在解压目录先建立本地Git快照，供现有构建工具枚举输入并记录内容身份：

```sh
git init
git add .
git -c user.name='MusicFS source build' -c user.email='source@musicfs.invalid' commit -m 'Import MusicFS source release'
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run build:desktop
```

这是开发者从源码复现的步骤，普通桌面用户直接运行发行程序，插件作者使用作者包即可。源码包导入后的Git提交与原发行提交不同，`SOURCE.md`保存二者的原始对应关系；不将本地重建描述成原二进制逐字节复现。构建其他目标、Worker或统一发行沿用上文命令，需要下载已固定版本的依赖和rclone。

各正式探针正常结束时清理临时数据库及安装文件。默认仅使用本地测试状态，不要求 Cloudflare 账号或音乐账号；QQ 探针的可选真实会话模式例外，见下文。Worker 探针固定兼容日期和显式模块清单，不执行线上部署，也不证明免费配额适用。`check` 中的 HTTP 测试也需回环端口；淘汰的 Nephele/Node 桥接诊断已归档到基线提交 `bfee998`，参见 [ADR 0004](adr/0004-shared-fetch-readonly-dav.md)。

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

## 实现入口

| 职责 | 源码 |
|---|---|
| 独立公开类型 | [plugin-api](../packages/plugin-api/src/index.ts) |
| 包清单/兼容与基础安装策略 | [extensions](../src/core/extensions/index.ts) |
| 共用插件迁移激活 / 候选转换 / 两驱动共同SQL | [application](../src/application/change-plugin.ts)、[sources migration](../src/core/sources/migration.ts)、[SQL计划](../src/infrastructure/persistence/plugin-change-sql.ts) |
| 实例调用、配置及状态条件写入协调 | [sources](../src/core/sources/index.ts) |
| 可选按需续期 / 两驱动共同SQL | [renewal](../src/core/sources/renewal.ts)、[SQL计划](../src/infrastructure/persistence/renewal-sql.ts) |
| 完整快照、布局、路径与内容核对 | [library](../src/core/library/index.ts) |
| 管理 API / 共用只读 DAV | [HTTP](../src/transport/http/index.ts)、[DAV](../src/transport/dav/index.ts)、[接口说明](management-api.md) |
| 共用页面 / 独立管理 DTO | [WebUI](../src/web/shell.tsx)、[合同](../src/contracts/management.ts)、[界面说明](architecture/web-ui.md) |
| 实际 ZIP 解析与预算 | [archives](../src/infrastructure/archives/index.ts) |
| SQLite / D1 Adapter | [SQLite](../src/infrastructure/persistence/sqlite.ts)、[D1](../src/infrastructure/persistence/d1.ts) |
| 桌面不可变外置模块 / Worker 注册集合 | [desktop](../src/hosts/desktop/plugins.ts)、[worker](../src/hosts/worker/plugins.ts) |
| 正式桌面启动 / rclone 挂载 | [launcher](../src/hosts/desktop/launcher.ts)、[mounts](../src/hosts/desktop/mounts.ts)、[说明](desktop.md) |
| Worker 正式入口 / 持久发布 | [service](../src/hosts/worker/service.ts)、[changes](../src/hosts/worker/changes.ts)、[publisher](../src/hosts/worker/publisher.ts)、[说明](worker.md) |
| QQ 来源认证、目录和音频 | [QQ 插件说明](../plugins/qq/README.md) |
| 网易云来源认证、目录和音频 | [网易云插件说明](../plugins/netease/README.md) |
| 无账号、歌单或音质设置的来源 | [sample](../plugins/sample/index.ts) |

安装器已实现配置/私有状态schema候选转换和全部实例整体激活，失败保留当前安装；QQ私有状态v1→v2复用同一机制。桌面仍保留不可变修订文件，后续补齐必要回收。按需续期协调已本地验证，真实来源自然到期/重登、云端和目标系统仍按[台账](verification.md)收口。SQLite 使用七份顺序迁移，D1 正式模板和探针按文件名应用相同 SQL；不要修改已应用的历史迁移来补新字段。

变更后的检查以实际职责为准；本地 Worker、真实 Cloudflare、桌面二进制和目标系统挂载分别记录证据，不相互替代。结果见[插件基础](verification/p0-plugin-foundation.md)及[目录/DAV/管理链路](verification/p0-library-dav.md)。
