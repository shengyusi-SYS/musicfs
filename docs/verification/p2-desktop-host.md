# 桌面启动、后台与挂载接线

日期：2026-10-20。记录 FR10—FR12、FR14、FR16 的桌面实现和限定证据；完整需求仍以[统一方案](../../outputs/musicfs-requirements-and-technical-design.md)为准。操作说明与流程图见[桌面说明](../desktop.md)。本记录不宣告四个目标系统或发布验收完成。

## 当前实现

| 能力 | 正式路径与当前行为 |
|---|---|
| 点击启动与后台 | `src/desktop.ts` 调用 `launcher.ts`；前台使用 Node 原生进程接口分离后台，由后台装配现有 `createDesktopService`。静态页面、管理路由、DAV、SQLite 与外置插件均复用现有模块 |
| 重复启动 | 以 `proper-lockfile@4.1.2` 保持后台存续期间的独占锁；已运行实例经管理凭据、实例 ID、PID 和地址握手后复用，不只检查端口是否开放 |
| 凭据和目录 | `env-paths@4.0.0` 决定用户数据目录；首次在锁内生成管理令牌与独立 DAV 密码。后续读取持久凭据，Unix 私有文件为 `0600`；浏览器由 `open@11.0.4` 打开，令牌通过 fragment 交给共用页面 |
| 挂载合同 | `src/contracts/mounts.ts`；桌面管理 API 为 `GET/POST /api/mounts`、`DELETE /api/mounts/:id`。输入中保留独立凭据，返回只有名称、来源、路径、状态及可展示错误 |
| rclone 生命周期 | `mounts.ts` 协调定义和串行操作，`rclone-control.ts` 使用随包 `rclone v1.75.2` 的私有认证 RC。实际调用 `config/create`、`operations/list`、`mount/types`、`mount/mount`、`mount/listmounts` 以及正常卸载；挂载后还检查根目录可读 |
| 本地／远程 | 本地连接使用当前后台 DAV 与持久读取凭据；远程允许 HTTP 和 HTTPS，包括局域网地址，不要求用户配置 rclone remote。URL 中嵌入的用户名／密码被拒绝，凭据另填 |
| 端口恢复 | 同实例残留 `runtime.json` 的回环端口优先复用；端口被占用时分配新端口并保留管理入口。对仍存活的本地挂载，调用 rclone `config/get` 核对实际 URL；与当前本机 DAV 不同则显示 `remount_required`，保留正常卸载，不误报恢复。远端连接不依赖本机端口 |
| 正常卸载与退出 | 路径操作按确切挂载点和自身 remote 身份核对。忙卸载拒绝后不终止挂载进程；`POST /api/desktop/quit` 先卸载，失败返回 409。共用页面已接退出按钮，关闭网页本身不退出后台 |
| 平台挂载 | Linux `mount`，Windows `cmount`，macOS 优先 `nfsmount`。固定 rclone 的 NFS 卸载内含强制调用，macOS 因此先使用系统正常 `umount` 并等待确认；真实平台行为待验 |
| 启动错误 | 前台错误先尽力写 `startup.log`，再由宿主薄适配使用已有 OS 弹窗；动态内容经环境变量／参数传递。后台不弹窗。参数解析已纳入同一错误边界；图形失败时仍有 stderr 与日志。该补充仅完成代码及类型核查 |

源码入口：[launcher](../../src/hosts/desktop/launcher.ts)、[mounts](../../src/hosts/desktop/mounts.ts)、[rclone-control](../../src/hosts/desktop/rclone-control.ts)、[notifications](../../src/hosts/desktop/notifications.ts)、[管理 API](../../src/transport/http/index.ts)、[共用挂载页面](../../src/web/pages/mounts.tsx)。

## 已执行的定向验证

环境为 Linux x64、Bun 1.4.3，真实 RC 使用开发目录中已校验的 rclone v1.75.2。受限沙箱首次拒绝回环监听；允许本地监听后，仅以下定向命令重跑：

```sh
bun test tests/desktop-launcher.test.ts tests/desktop-mounts.test.ts
```

结果：**7 项通过、0 失败、52 次断言**，最后一次约 3.18 秒。源码和夹具见[启动器测试](../../tests/desktop-launcher.test.ts)与[挂载测试](../../tests/desktop-mounts.test.ts)。局部严格 TypeScript 检查及文件格式检查通过，未在此记录中重复全套检查或构建。

| 检查 | 实际证明 | 限界 |
|---|---|---|
| 两个点击进程并发启动 | 前台进程退出后同一后台仍响应鉴权 HTTP；凭据彼此独立，重复启动复用相同 PID；日志未包含测试令牌／密码 | 使用最小 HTML 页面、`--no-open` 和浏览器回调；没有运行默认浏览器或发行物 |
| 正式管理 HTTP | 无凭据访问被拒绝、桌面状态和挂载列表可读、无效相对挂载路径返回 422；退出后移除后台运行记录 | 缺 FUSE 的 HTTP 分支按宿主条件执行；不能据此宣称本次真实内核挂载或全部页面点击已验 |
| 同实例残留元数据 | 重建崩溃后的持久运行记录，真实 HTTP 服务复用原端口；旧端口占用时换端口，原占用服务不被关闭 | 先正常关闭测试后台再重建记录，没有 SIGKILL、真实残留 FUSE 或锁过期回收 |
| 重复挂载与恢复 | 两个并发请求只调用一次受控挂载；协调器重建后仍识别同一挂载；返回对象不含远端用户名／密码 | RC 为受控替身，根目录是普通测试目录，没有 FUSE/NFS |
| HTTP 局域网与旧端点 | HTTP LAN URL 可通过输入合同；改变本机 DAV 地址后本地挂载显示 `remount_required`、远端保持状态；先正常卸载再挂载后恢复 | LAN 连接和内核挂载为受控执行，没有实际访问该测试 LAN 主机 |
| 忙卸载和缺依赖 | 受控忙卸载保持挂载进程，后台关闭被拒绝；缺依赖可诊断，未真正挂载时仍能退出 | 不是 Windows/Unix 实际文件占用或系统驱动测试 |
| 真实 rclone RC | 实际 RC 进程在协调器重建后保持同一 PID，`mount/types`、空挂载表、remote 创建／`config/get` 与删除、正常退出通过 | 没有调用实际 `mount/mount`，也没有音频或目标系统挂载 |

## 历史发行构建检查点

以下表格保留API0.1.3/schema5时的四目标检查点，不作为当前发行身份。当前版本、字节数及摘要以`dist/releases/release-manifest.json`和各目录`release.json`为准，统一归档证据见[发行记录](p4-release-artifacts.md)。每个目录包含程序、共用页面、校验后的对应rclone、三个插件ZIP、依赖锁与许可；macOS为`.app`。`targetRuntimeVerified: false`表示完整原生验收尚未全部收口。

| 目标 | 当时程序字节数 | 当时SHA-256 | 当时原生结果 |
|---|---:|---|---|
| Linux x64 | 91,297,760 | `614d1a0a4b9810a25a105c21476fdfaba84309537360f14d699dee0da9ea1df8` | 正式程序、页面、外置插件、重复启动、FUSE本地/独立远程DAV及正常退出已有证据 |
| Windows x64 | 96,883,712 | `72bb911999d4e52740d01212c32c6b9ebe44eeb6b2688f2a118a991f5ac91235` | 交叉编译，原生运行/挂载待验 |
| macOS Intel | 79,207,920 | `3a6f3a6b7881040ce3634ca6bb7978c90633e59eca98a79e9cb0ef59b8b09173` | 交叉编译，原生运行/挂载待验 |
| macOS Apple Silicon | 71,357,810 | `071dff9b310cf557cd77cadcfe526d35176e5aae06d0cfda5d3559b416685c70` | 交叉编译，原生运行/挂载待验 |

## 从发行物执行的真实Linux旅程

`bun scripts/probe-desktop-product.ts --mount` 在独立临时数据目录运行生成的程序，不使用源码启动入口或开发服务。验证分离后台、共用页面、从发行目录安装外置sample、真实HEAD/Range、重复启动复用PID和凭据，以及FUSE挂载后16,044字节WAV全文和前后五次偏移。最终版本还保持文件真实打开，经正式HTTP正常卸载得到409 `mount_busy`，后台继续响应；关闭句柄后，finally正常退出并确认HTTP停止、运行记录清除，探针exit0。

实际浏览器另验证本地/远程表单及状态。远程目标是本机另一个独立HTTP DAV服务，使用其独立凭据与网易云实例；挂载文件系统中7,734,765字节真实极高MP3，全文与五次前后偏移均与DAV下载一致，SHA-256 `da3a093aed14f1172f483fa9a5d376fb8069b7ab051cf1158b7b4360dcb8b7a7`。这证明独立连接路径，不等于跨公网或Cloudflare挂载已验。

非空目录挂载失败时页面保留表单和错误，不再提示成功；真实打开本地文件时页面退出返回409并保留运行，释放句柄后退出返回202，页面显示请求已接受，随后实际后台停止、runtime记录移除。实测发现rclone的busy错误含fusermount名称，原分类误报缺依赖；已改为优先busy并由上述最终发行物探针回归。共用错误显示也只对真正状态冲突给出重新载入提示。

早先“无/dev/fuse”的判断来自受限执行视图，允许本地进程的实际宿主存在FUSE；已经补做内核挂载。截图和实际账号/媒体仅留在/tmp，不加入Git。浏览器由自动化打开已有发行入口，尚未验证文件管理器双击和系统默认浏览器自动打开。

## 必须继续收口

2026-10-20磁盘不足诊断补充：rclone RC明确返回ENOSPC、no space left on device或disk full时，现由现有MountError边界返回disk_full及释放数据/缓存所在磁盘空间后重试的提示；优先于包含fusermount名称的缺依赖匹配。writePrivateJson写入、rename或chmod遇ENOSPC采用同一提示，不建立磁盘预检服务。受控本地RC经实际Fetch和正式管理HTTP的回归通过，原busy/缺依赖分类保持；desktop-mounts整组6项/59断言通过。没有填满真实磁盘，私有JSON写入的真实ENOSPC及各目标OS原生错误仍按环境待验。

2026-10-20 启动恢复补充：已修复后台只试一次锁、前台仅等15秒却需30秒才判陈旧的窗口。锁仍由 proper-lockfile 维护与判定；宿主最多32秒协调接管，前台统一47秒等待上限，竞争启动发现健康后台后尽快退出。源码启动的真实临时后台经 SIGKILL 后立即重开，约32.27秒恢复，保留原凭据/端口、更新PID；健康重复后台3秒内退出。定向3项/35断言通过。此结果没有实际挂载或Windows/macOS运行，也不把“可恢复”描述为即时重启。

2026-10-20 发行物活动挂载补充：在Linux实际FUSE宿主执行以下命令，使用独立临时目录和随包sample，不读取开发账号：

```sh
bun scripts/probe-desktop-product.ts --directory dist/desktop/linux-x64 --mount --crash-recovery
```

运行的应用SHA-256为`c3dbf7130e2786423e3b176c06b1b2965215e27e8a814340f60e7f899385c224`。探针通过正式管理入口安装/配置/准备sample，FUSE全文16,044字节与五次偏移一致。随后只SIGKILL该临时后台：

| 实际路径 | 结果 |
|---|---|
| 原端口可用，立即重新启动 | 29,957ms完成锁接管；后台PID更新，凭据不变；原rclone经私有RC身份核对仍是同一PID，原挂载仍为mounted且全文一致 |
| 再次SIGKILL，临时占用原端口后重开 | 30,679ms完成恢复及重挂；后台改用新端口，原rclone和旧DAV URL保留；正式状态为remount_required；正常卸载并以同一定义重挂后URL更新、全文一致 |
| 后续忙路径与正常退出 | 打开真实文件时正常卸载返回409 mount_busy；关闭句柄后退出返回202，实际HTTP停止并清理临时目录，探针exit0 |

锁接管仍按proper-lockfile的30秒陈旧规则，恢复不是即时的。端口变化时不拿内核可能缓存的字节判断连接已恢复，而核对真实RC配置与管理状态；新连接在正常重挂后验证。此证据仅覆盖Linux本地活动挂载，不替代其他OS、真实云端或桌面图形启动。

1. 验证文件管理器双击、系统默认浏览器和启动错误可见性；统一ZIP系统解压运行已有证据，干净机器旅程仍需收口。
2. Windows x64、Linux x64、macOS Intel 与 Apple Silicon 原生运行，以及本地／远程 DAV 的实际挂载、播放、拖动、正常卸载与忙路径。
3. Windows/macOS异常退出后的活动挂载恢复；Linux正式发行物两种端口恢复路径已有上述证据。
4. 实际 Windows PowerShell／macOS AppleScript／Linux 图形工具的错误弹窗；没有可用图形设施时的日志回退。

来源规则、示例插件完整性、真实 Worker、OpenList 与普通播放器的其他验收继续按[总台账](../verification.md)推进，本记录不增加产品范围。
