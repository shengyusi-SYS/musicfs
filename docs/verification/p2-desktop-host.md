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

## 发行构建当前状态

主线已用 `bun run build:desktop -- --all` 最终构建四个目标。本次纳入持久分页刷新、第五版迁移与最终页面重试/恢复修正；Linux最新二进制已重验冷准备/FUSE/忙卸载及退出。每个目录包含程序、共用页面、校验后的对应 rclone、三个插件ZIP、依赖锁与许可；macOS为`.app`。`release.json` 保持 `targetRuntimeVerified: false`，表示完整原生验收尚未全部收口。

| 目标 | 最终程序字节数 | SHA-256 | 原生结果 |
|---|---:|---|---|
| Linux x64 | 91,297,760 | `175409dc5c5c32ec55ef81d5d998ee720ed7dc27da2fbba95102483c6b80b41e` | 正式程序、页面、外置插件、重复启动、FUSE本地/独立远程DAV及正常退出已有证据 |
| Windows x64 | 96,881,664 | `5b626bf13a3e7fa03b380b8271182b15f00c60170345ae6070a29eb31448e9ed` | 交叉编译，原生运行/挂载待验 |
| macOS Intel | 79,207,920 | `74282317eae3400afcf6aa581852f6b2b6630c91c0ea60caca180583bc00f0bb` | 交叉编译，原生运行/挂载待验 |
| macOS Apple Silicon | 71,357,810 | `8fb9d048a89c4881cdcc5b8ce6eb81a2135a00db7b59b21214d544c1c9a255eb` | 交叉编译，原生运行/挂载待验 |

## 从发行物执行的真实Linux旅程

`bun scripts/probe-desktop-product.ts --mount` 在独立临时数据目录运行生成的程序，不使用源码启动入口或开发服务。验证分离后台、共用页面、从发行目录安装外置sample、真实HEAD/Range、重复启动复用PID和凭据，以及FUSE挂载后16,044字节WAV全文和前后五次偏移。最终版本还保持文件真实打开，经正式HTTP正常卸载得到409 `mount_busy`，后台继续响应；关闭句柄后，finally正常退出并确认HTTP停止、运行记录清除，探针exit0。

实际浏览器另验证本地/远程表单及状态。远程目标是本机另一个独立HTTP DAV服务，使用其独立凭据与网易云实例；挂载文件系统中7,734,765字节真实极高MP3，全文与五次前后偏移均与DAV下载一致，SHA-256 `da3a093aed14f1172f483fa9a5d376fb8069b7ab051cf1158b7b4360dcb8b7a7`。这证明独立连接路径，不等于跨公网或Cloudflare挂载已验。

非空目录挂载失败时页面保留表单和错误，不再提示成功；真实打开本地文件时页面退出返回409并保留运行，释放句柄后退出返回202，页面显示请求已接受，随后实际后台停止、runtime记录移除。实测发现rclone的busy错误含fusermount名称，原分类误报缺依赖；已改为优先busy并由上述最终发行物探针回归。共用错误显示也只对真正状态冲突给出重新载入提示。

早先“无/dev/fuse”的判断来自受限执行视图，允许本地进程的实际宿主存在FUSE；已经补做内核挂载。截图和实际账号/媒体仅留在/tmp，不加入Git。浏览器由自动化打开已有发行入口，尚未验证文件管理器双击和系统默认浏览器自动打开。

## 必须继续收口

1. 验证文件管理器双击、系统默认浏览器和启动错误可见性；必要发行压缩包和干净机器旅程仍需收口。
2. Windows x64、Linux x64、macOS Intel 与 Apple Silicon 原生运行，以及本地／远程 DAV 的实际挂载、播放、拖动、正常卸载与忙路径。
3. 实际异常退出后的锁与挂载恢复。当前 `proper-lockfile` 为 `stale: 30s`、`retries: 0`，前台等待为 `15s`；新启动可能在旧锁尚未过期时退出。现有残留元数据测试没有覆盖该窗口，不宣称即时恢复。
4. 实际 Windows PowerShell／macOS AppleScript／Linux 图形工具的错误弹窗；没有可用图形设施时的日志回退。
5. 实际异常退出后的`remount_required`卸载后重挂；当前已验正常本地/远程、忙时保留和退出，不宣称崩溃恢复已验。

来源规则、示例插件完整性、真实 Worker、OpenList 与普通播放器的其他验收继续按[总台账](../verification.md)推进，本记录不增加产品范围。
