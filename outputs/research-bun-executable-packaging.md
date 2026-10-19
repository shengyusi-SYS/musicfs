# Bun 可执行程序发行边界核查

核查日期：2026-10-18。范围：MusicFS 桌面后台、WebUI、rclone 与本地持久化。仅查阅官方文档、官方源码及依赖作者文档，未安装 Bun、编译应用或实测挂载。

方案修订说明：本报告中的 HTML import 是 Bun 能力核查；当前产品方案保留 React + Vite。桌面打包收录 Vite 已生成的静态文件，不因此改用 Bun 编译前端源码，详见 [Bun 桌面评估](musicfs-bun-desktop-evaluation.md)。

2026-10-20 插件修订：来源能力通过可安装插件提供，示例平台的静态收录仅发生在各自插件产物内部。桌面核心编译后还须验证外置插件加载、资源和更新生命周期；原文关于平台模块随包的调查不能替代这项验证。Worker 插件变更允许后台自动部署，详见 [统一方案](musicfs-requirements-and-technical-design.md)。本报告保留原发行证据，不据此宣称插件兼容已通过。

## 结论

Bun 适合把原方案中的“Node 运行时 + 后端 JS + WebUI 静态文件”收敛为一个可执行程序。用户不需要另装 Node 或 Bun。rclone 仍作为原生子进程；系统挂载依赖沿用 rclone 的要求。

这能简化交付、启动和静态资源定位，但不会自动消除平台接口适配、rclone 生命周期或三端挂载验证。

## 已确认的发行能力

| 项目 | 官方能力及本项目含义 |
|---|---|
| 目标平台 | `bun build --compile --target=…` 支持 Windows、macOS、Linux 的 x64 / arm64；Linux 同时提供 glibc / musl 目标。每个目标仍分别产出文件。 |
| 前后端合包 | HTML import 可将页面及其 JS / CSS 与后端、运行时一起编入程序。也能通过文件 loader 嵌入二进制资产。 |
| Windows 启动体验 | `--windows-hide-console` 可隐藏主程序控制台；图标、产品版本、发布者等元信息也有内置选项。除隐藏控制台外，这些 Windows 元信息选项要求在 Windows 上构建。 |
| macOS 签名 | 编译结果可通过 `codesign` 签名；Bun 文档列出 JIT entitlement 处理方式。签名是发行步骤，编译本身不替代它。 |

依据：[Bun 单文件可执行程序文档](https://bun.sh/docs/bundler/executables)。以上按当前文档核查；实际选用版本应固定，并据该版本建立构建矩阵。

`.app` 与可执行文件是不同包装层。若希望 Finder 中显示应用图标并按应用方式启动，可把 Bun 产物放入一个小型 `.app` bundle；Apple 规定 bundle 包含 `Info.plist`、`Contents/MacOS` 等结构。当前需求不需要据此引入 Electron 或完整桌面窗口框架。[Apple Bundle Structures](https://developer.apple.com/library/archive/documentation/CoreFoundation/Conceptual/CFBundles/BundleTypes/BundleTypes.html#//apple_ref/doc/uid/10000123i-CH101-SW13)

## 内嵌资源与执行 rclone 的区别

`type: "file"` 导入在编译后指向 Bun 的内部虚拟路径；官方承诺可通过 `Bun.file()` 和兼容的 `fs` API 读取。源码也将这些路径明确标记为虚拟路径；Windows 内部前缀与 Unix 不同，业务不应硬编码前缀。[Bun 源码：虚拟路径定义](https://github.com/oven-sh/bun/blob/017b2439a7a75c82c7a86a294badd8ef2fc30e28/src/standalone_graph/StandaloneModuleGraph.rs#L86)

因此，静态页面可以直接由应用读取和响应；把 rclone 字节放进包里，也不等于操作系统已得到一个可执行文件。当前查阅的官方文档没有明确保证可把内部资源路径直接交给 `Bun.spawn()` 执行。所查子进程路径处理最终进入原生 spawn 流程，未看到该路径上自动释放内嵌文件的步骤。[Bun 子进程绑定源码](https://github.com/oven-sh/bun/blob/017b2439a7a75c82c7a86a294badd8ef2fc30e28/src/runtime/api/bun/js_bun_spawn_bindings.rs#L87)

**建议先采用可预测的发行方式：**

- 如果优先“下载一个文件”：将对应平台的 rclone 当作资产内嵌；第一次挂载前写入应用数据目录下的版本化 `bin/` 路径，设置 Unix 执行权限，然后从真实路径启动。后续复用同一版本。
- 如果优先最少运行时代码：发行目录中并列提供 MusicFS 与 rclone；macOS 可共同放在 `.app` 内部。这仍然满足用户不用另装、配置 rclone。

“先释放再执行”是本项目建议，并非已经实测得到的“所有平台绝对不能直接执行内嵌程序”结论。无需为此研发内存执行方案。

`Bun.spawn()` 已提供参数数组、环境变量、输出流、退出状态、终止及 Windows 隐藏子进程窗口等能力，可直接管理 rclone；挂载成功判断、卸载和异常处理仍属于应用逻辑。[Bun Spawn](https://bun.sh/docs/runtime/child-process)

## 数据库、设置与缓存

应用包内的页面、默认配置和模板按只读发行资源使用。账号、设置、目录布局和缓存应写到用户目录中的真实文件，避免依赖启动时工作目录。特别是 Bun 内嵌 SQLite 使用内存中的数据库，修改不会在退出后保存；不应用它保存用户状态。桌面可使用 `bun:sqlite` 打开外部 `state.db`。[Bun SQLite](https://bun.sh/docs/runtime/sqlite)、[Bun 内嵌 SQLite 说明](https://github.com/oven-sh/bun/blob/017b2439a7a75c82c7a86a294badd8ef2fc30e28/docs/bundler/executables.mdx#L864)

建议复用 `env-paths` 生成 `data`、`cache` 和 `log` 路径，应用只负责建目录；不再手写平台路径判断。以下为位置示意，最终名称由依赖配置决定。

| 系统 | 状态数据库与释放的 rclone | 可清除缓存 |
|---|---|---|
| Windows | `%LOCALAPPDATA%` 下的应用数据目录 | `%LOCALAPPDATA%` 下的应用缓存目录 |
| macOS | `~/Library/Application Support/…` | `~/Library/Caches/…` |
| Linux | `$XDG_DATA_HOME/…`，缺省 `~/.local/share/…` | `$XDG_CACHE_HOME/…`，缺省 `~/.cache/…` |

依据：[env-paths 作者文档](https://github.com/sindresorhus/env-paths#api)。音频缓存继续由 rclone 管理，应用给它一个确定的真实缓存目录，无需增加第二套音频磁盘缓存。

## 尚需验证的最小集合

1. 固定 Bun 版本后，在三端运行编译产物：启动本地服务、打开页面、读写外部数据库，再退出重启确认状态保留。
2. 现有平台 API 的动态文件加载、原生 addon 和资源路径是否能够随包正确工作；编译成功不等于业务已兼容。
3. 对应平台 rclone 的打包、释放、执行、挂载与卸载；Windows 检查主程序和子进程均无意外控制台。
4. macOS 检查所选发行包装与签名；挂载继续验证 nfsmount / 选定的 FUSE 路径。Windows 的 WinFsp、Linux 的 FUSE 要求由挂载方案决定，Bun 单文件不会替代它们。[rclone mount](https://rclone.org/commands/rclone_mount/)

这份核查不要求增加安装器、自动更新、托盘或新后台服务；这些均不属于当前为采用 Bun 而必须新增的功能。
