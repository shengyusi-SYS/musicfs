# MusicFS 桌面后台与挂载

桌面入口复用共享服务、管理页面、SQLite 与插件安装器。当前实现与适用目标的验证统一见[桌面宿主记录](verification/p2-desktop-host.md)，本页说明使用与运行关系；交叉编译不替代目标系统运行。

## 使用旅程

从对应系统的完整发行目录启动：Windows 点击 `MusicFS.exe`，Linux 运行有执行权限的 `musicfs`，macOS 打开对应架构的 `MusicFS.app`。启动器打开默认浏览器；重复启动会验证并打开同一后台。关闭页面后，后台与挂载继续运行。管理页面使用独立随机凭据，启动器经 URL fragment 传入，页面立即移除 fragment。

“本机挂载”页面提供“退出 MusicFS 后台”，调用受管理凭据保护的退出入口；文件仍被占用时显示失败并保留后台。占用时先关闭使用挂载文件的程序，再重试。

“服务连接 → 桌面网络”保存本机/局域网访问和监听端口，写入当前数据目录的 `network.json`，正常退出并重新打开后生效。默认 `local/0`，只绑定 `127.0.0.1` 并自动分配端口；`lan` 绑定 IPv4 的 `0.0.0.0`，页面列出非回环网卡的实际 DAV 地址。启动器身份验证和本地挂载始终使用 `127.0.0.1`，不把通配地址写成客户端 URL。固定端口占用时仍回退到可用管理端口，页面分别显示已保存设置和当前生效状态。保存设置不会中断现有挂载；Worker没有此本机设置。

在页面安装来源插件、配置目录后，可选择本地 DAV 或填写远程 HTTP/HTTPS DAV 的地址、用户名、密码及本机挂载位置。挂载只读。rclone 确认实际挂载后，后台还要能读取挂载根目录，才报告成功；进程存在不等于挂载可用。卸载和退出后台采用正常卸载，路径忙时保留后台和错误状态，关闭占用文件的程序后再试。系统注销后的自动恢复不在当前范围。

挂载项可分别“重新挂载”“卸载”“移除”。重新挂载复用保存的连接和凭据；活动挂载先正常卸载，本机连接使用当前后台地址。卸载保留定义；移除在正常卸载后删除定义及对应 rclone 连接配置，失败或已停止的条目也能移除。它们不会删除音乐平台上的歌曲，也不会删除挂载点的父目录。

Windows 挂载前会检测 WinFsp 的实际运行组件。缺失时页面提供“安装挂载组件”，调用 Windows 包内固定版本的官方 MSI，仅安装运行组件并按需请求系统权限；已有组件直接复用。安装完成后继续使用 MusicFS 普通用户进程，不把全部后台提升为管理员。

## 本机 HTTPS 与资源管理器原生映射

“服务连接 → 本机 HTTPS WebDAV”提供可选的回环 HTTPS 入口。点击启用后生成此数据目录专用的自签名证书，再点击“完成 Windows 连接设置”：一次标准系统权限确认，将此证书加入系统信任并启动现有 WebClient 服务，不改变服务启动类型。已就绪的设置直接复用。复制显示的 HTTPS 地址和相同读取凭据到资源管理器。地址只供这台运行后台的电脑使用；它不覆盖局域网地址或云端证书。证书和端口会保留，重启恢复入口；停用会断开此 HTTPS 入口，证书材料保留以便再启用。

dev.3 起，同一连接设置还会将 Windows 原生映射的单文件上限提高到 4,294,967,295 字节（4GiB−1）。页面显示当前值；WebClient 已运行且需要修改上限时，按钮为“应用设置并重连”。修改影响这台电脑所有原生 WebDAV 连接，并重启正在运行的 WebClient，现有连接会短暂断开；原本停止的服务设置后直接启动。证书、原上限及新上限已经就绪时直接复用，不重复提权或重启。App 管理的 rclone/WinFsp 挂载不受该参数约束。

第一次由此数据目录提高上限时记录原值；“恢复原文件上限”恢复原值，原先未设置该注册表值时删除此值，重新使用 Windows 默认值。恢复也需重启正在运行的 WebClient，但保留 HTTPS、证书信任、来源授权与目录。退出 App、关闭 HTTPS 不会自动修改全局上限；系统已有最大上限且并非由此 App 修改时不提供恢复入口。

此入口使用 Bun 原生 TLS，复用同一 DAV 处理链路，不额外运行反向代理。管理页面、启动器身份和 App 管理的 rclone 挂载继续使用既有回环连接。Windows 默认 WebClient 只在 HTTPS 上使用 Basic 认证，故仅生成证书还不够，必须让 Windows 信任；不通过放宽全局 `BasicAuthLevel` 来解决。文件上限通过官方 `FileSizeLimitInBytes` 参数设置，不修改超时、目录属性上限或其他系统策略；更大文件使用 App 管理的挂载。[Microsoft WebDAV 说明](https://learn.microsoft.com/en-us/iis/publish/using-webdav/using-the-webdav-redirector)

具体模块关系见[桌面挂载架构](architecture/desktop-mounts.md)，实际 Windows 结果见[限定验收记录](verification/p2-windows-mount.md)。

## 挂载位置与系统依赖

挂载发生在运行 MusicFS 后台的电脑。用 Windows 浏览器打开 WSL 后台，挂载仍在 WSL；需要 Windows 盘符时，应运行 Windows 发行程序。资源管理器的“映射网络驱动器”则是独立的 Windows WebDAV 客户端，使用它能访问的 DAV 地址和读取凭据，不会调用此页面的 rclone 挂载。

首次安装及数据结构不变的插件更新立即完成。配置/私有状态结构升级会显示后台进度，先准备所有实例的新数据，再同时切换；转换失败保留旧插件和实例。关闭页面不会停止升级，后台重启会恢复原操作。升级期间配置或授权变化会使候选作废，可在原操作失败后重新安装。合同和验证见[插件迁移](verification/p2-plugin-migration.md)。

| 系统 | 挂载实现 | 首次系统依赖 |
|---|---|---|
| Linux x64 | 随包 rclone RC `mount` | `/dev/fuse` 与 `fusermount3` / `fusermount`、相应用户权限 |
| Windows x64 | 随包 rclone RC `cmount` | WinFsp；空闲盘符或尚不存在的目录挂载点 |
| macOS Intel / Apple Silicon | 随包 rclone RC `nfsmount` | 系统 NFS 挂载工具与权限，按目标系统实测确认 |

Windows 的 `*` 表示由 rclone 分配盘符，后台保存其返回的实际盘符。Unix 使用空目录，拒绝非空目录和符号链接。远程连接同时支持 HTTP 与 HTTPS，包括局域网 WebDAV；用户名和密码在独立字段填写。[rclone 挂载文档](https://rclone.org/commands/rclone_mount/)、[RC 接口](https://rclone.org/rc/#mountmount-create-a-new-mount-point)

## 模块与生命周期

```mermaid
sequenceDiagram
    participant Click as 桌面启动器
    participant Background as 独占后台
    participant Browser as 共用 WebUI
    participant RC as 随包 rclone RC
    Click->>Background: 已有凭据 + 实例身份校验
    alt 已有后台
        Click->>Browser: 打开已有入口
    else 尚未运行
        Click->>Background: 启动独立进程
        Background->>Background: proper-lockfile 独占与随机凭据
        Click->>Browser: 就绪后打开入口
    end
    Browser->>Background: 挂载本地或远程 DAV
    Background->>RC: 私有认证的 RC 配置与挂载
    RC-->>Background: 实际挂载点
    Background->>Background: 核对 RC 状态与根目录可读
    Background-->>Browser: 挂载状态
    Browser->>Background: 正常卸载 / 退出
    Background->>RC: 正常卸载并确认
    Background->>Background: 全部成功后关闭服务和释放锁
```

`src/contracts/mounts.ts` 是管理边界的 JSON 合同；返回状态不含连接密码。`mounts.ts` 保存私有定义、串行协调同一路径操作和正常卸载；`rclone-control.ts` 复用真实 RC 进程、校验控制端身份与私有运行记录。进程中断后只依据认证成功且 PID 相符的 RC 握手复用实例，不依据磁盘里的 PID 杀进程。挂载定义保留，未运行的挂载不在启动时自动恢复。

后台异常中断留下同一实例的运行记录时，重启优先复用原本机端口，保持已有本地挂载的 DAV 连接。如果端口被占用，后台可在新端口打开管理页面；读取挂载状态时，将 rclone 实际配置的 URL 与当前本机 DAV 地址核对。旧地址对应的本地挂载显示“需要重新挂载”，保留正常卸载操作，不把 rclone 进程仍存活当作连接已恢复。远程 DAV 挂载不受本机端口变化影响。[固定版本 config/get](https://github.com/rclone/rclone/blob/v1.75.2/fs/config/rc.go)

macOS 的固定 rclone 1.75.2 `nfsmount` 已注册 RC，但其内置卸载调用带强制选项。本项目先调用系统正常 `umount`，再等待 rclone 确认外部卸载；不调用该强制路径。该路径仍需真实 macOS 验收。[固定版本 NFS 实现](https://github.com/rclone/rclone/blob/v1.75.2/cmd/nfsmount/nfsmount.go)、[固定版本 RC 实现](https://github.com/rclone/rclone/blob/v1.75.2/cmd/mountlib/rc.go)

## 数据与浏览器

用户目录由 `env-paths('MusicFS', {suffix: ''})` 决定，包含 SQLite、不可变插件修订、随机凭据、后台身份、挂载定义及诊断日志。Unix 数据目录权限为 `0700`，凭据和挂载配置为 `0600`；Windows 使用当前用户目录及其 ACL。连接凭据不会出现在挂载返回对象、进程命令行或浏览器查询字符串中。私有目录和日志不进入发行包或版本控制。

跨平台浏览器打开交给 `open`，路径选择交给 `env-paths`，单实例文件锁交给 `proper-lockfile`；仅宿主使用这些依赖。Linux 发行环境仍需要桌面的浏览器打开设施，编译产物可以使用 `open` 的系统 `xdg-open` 回退。[open 官方说明](https://github.com/sindresorhus/open)、[env-paths 官方说明](https://github.com/sindresorhus/env-paths)、[proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)

前台启动、参数解析或打开浏览器失败时，先尽力写入本机 `startup.log`，再显示错误与日志位置：Windows 调用系统 PowerShell COM 弹窗，macOS 调用 `osascript`，Linux 使用已安装的 `zenity` 或 `kdialog`。动态消息通过环境变量或独立参数传递；不拼进脚本源码。缺少可用图形设施时保留 stderr 和日志，后台模式只记录错误，不弹窗。`--no-open` 同时关闭开发模式的自动弹窗。这些平台弹窗分支目前仅完成代码和类型检查，实际界面仍待对应系统验证。[AppleScript 环境变量](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_cmds.html)、[KDE 对话框](https://develop.kde.org/docs/administration/kdialog/)

## 构建与开发验证

开发者使用项目锁定的 Bun。普通用户使用发行物，不要求安装 Bun 或 rclone。

```sh
bun run scripts/build-desktop.ts
bun run scripts/build-desktop.ts --target windows-x64
bun run scripts/build-desktop.ts --all
bun run scripts/build-desktop.ts --target linux-x64 --runtime /absolute/path/to/rebuilt-bun
bun test tests/desktop-launcher.test.ts tests/desktop-mounts.test.ts
bun scripts/probe-desktop-product.ts --mount
bun scripts/probe-desktop-product.ts --mount --crash-recovery
```

构建先产出共享 WebUI 和示例插件，再按目标编译。输出在 `dist/desktop/<target>/`，含应用、页面、固定 `rclone v1.75.2`、校验与版本记录、示例插件 ZIP、依赖锁文件与许可。rclone 从官方固定版本下载，核对该发布的 SHA-256；已有缓存复用前核对二进制摘要。`--skip-web` 仅用于复用已构建的页面。跨系统编译不能替代运行验收，`release.json` 保持 `targetRuntimeVerified: false`，实际证据记入验收台账。[Bun 独立可执行程序](https://bun.sh/docs/bundler/executables)

开发者重建Bun/JSC后，可用`--runtime`指定匹配目标的Bun程序；构建器直接使用官方`compile.executablePath`并记录输入SHA-256，不复制一套运行时组装算法。每次只构建一个目标，不能与`--all`合用。固定运行时材料保存在`licenses/bun-runtime/`，当前仍为部分收集；实际源码重建和完整资料边界见[调查](../outputs/research-bun-runtime-distribution.md)及随包材料README。替换入口的Linux标记副本验收不等于JSC源码重建通过。

需要从源码检查启动器时，可显式指定完整资源目录：

```sh
bun src/desktop.ts --resources dist/desktop/linux-x64/resources
```

`--data /tmp/musicfs-desktop-test` 可选择独立测试数据，`--no-open` 避免自动打开浏览器，`--background` 是启动器内部的后台模式。诊断时保留数据目录；不要将含凭据的文件贴入问题记录。后台的 `POST /api/desktop/quit` 需要管理凭据，忙挂载返回409并继续运行；正常卸载后返回202，随后结束在途请求并退出。

## 证据边界

2026-10-20定向测试7项/52断言通过，包含真实后台/RC、端口复用与回退及受控挂载。随后已构建四目标产物，并从实际Linux发行物验证分离后台、外置sample安装、页面、DAV、重复启动和真实FUSE本地挂载；16,044字节WAV全文/前后偏移一致。通过发行物页面又挂载独立HTTP服务，读取网易云真实7,734,765字节MP3及前后五个偏移，与DAV下载逐字节相同。

源码端口恢复先验证了持久记录与锁等待。随后实际Linux发行物在活动FUSE挂载时SIGKILL后台并立即重开：原端口可用时约30秒恢复，保留凭据、原rclone及可读挂载；原端口被占用时切换新端口，明确显示remount_required，正常卸载再挂载后恢复读取。`--crash-recovery`需同时提供`--mount`，两次终止仅作用于探针独立临时后台。详见[桌面记录](verification/p2-desktop-host.md)。

实际浏览器验证了远程表单、两种挂载状态、失败保留表单，以及退出流程：真实打开文件时拒绝正常卸载并保持后台，关闭句柄后可正常退出。真实忙卸载还发现rclone错误含fusermount名称，原映射误报缺依赖；已优先识别busy，并让页面按具体错误显示而非把所有409都提示重新载入。最终原生探针对此作实际回归。

此前“缺少/dev/fuse”的判断来自受限环境视图；允许本地进程的宿主实际具备FUSE，已补做上述挂载。2026-10-21补做Windows VM的正式程序/sample旅程，修复盘符被改写及Bun根目录读取路径，实际WinFsp挂载、16,044字节读取与正常卸载通过。另以已有HTTPS Worker的sample完成Windows原生目录映射和正常断开；本机HTTP原生映射仍未通过，保持默认认证策略。默认图形打开、平台弹窗和Windows异常退出恢复未验，macOS仍只有交叉编译产物。限定证据见[Windows记录](verification/p2-windows-mount.md)、[桌面记录](verification/p2-desktop-host.md)和[总台账](verification.md)。
