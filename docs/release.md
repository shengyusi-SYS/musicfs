# MusicFS 当前交付物

## dev.5 性能优化更新

2026-10-21，应用`0.1.0-dev.5`、API`0.1.7`、schema9；网易云仍`alpha.10`，QQ更新为`alpha.13`。提供[Windows x64](../dist/releases/musicfs-0.1.0-dev.5-windows-x64.zip)、[Worker构建包](../dist/releases/musicfs-0.1.0-dev.5-worker.zip)、[对应源码](../dist/releases/musicfs-0.1.0-dev.5-source.zip)与[校验和](../dist/releases/musicfs-0.1.0-dev.5-checksums.txt)。较早归档及其统一清单保留原样；本次没有云部署或Windows宿主操作。

先正常退出旧后台，再解压完整新目录启动，沿用原数据和授权。已有网易云alpha.10可保留，无需为本轮核心优化重新安装；使用QQ时再在插件页安装随包alpha.13。QQ升级使该实例旧缓存冷失效，第一次仍需准备，后续才能复用新索引。schema9无需再迁移；来自schema8仍自动升至9。

主要改进是共用目录索引、已发布描述/ETag复用、原样保存配置不重建、暂时失败原进度续试、QQ热准备与读取路由复用，以及刷新SQL索引和桌面检查点让步。4,000条离线热检查点由约7.5秒降至47ms、前台排队约4ms；冷元数据分段约380→6ms，整次列目录还需输出约2MB XML。这些数值不等于真实平台整库耗时；完整效果、ROI停止理由和验证范围见[性能设计](architecture/refresh-performance.md)与[实施计划](../outputs/musicfs-implementation-plan.md)。

受影响集成126项通过，三套类型与导入边界通过；实际本地workerd验证生产入口、原生SHA256与打包网易云SDK预算/音频Range。Worker按免费约束组织工作，但真实免费CPU和4k整层响应额度仍未确认。Windows为WSL交叉构建，本次不重跑已跳过的原生矩阵，也不将历史VM验收改记为dev.5通过。

## dev.4 刷新性能更新

2026-10-21，应用`0.1.0-dev.4`、API`0.1.7`、schema9；网易云`alpha.10`，QQ`alpha.12`（共用音频准备窗口更新）。本轮单独提供[Windows x64更新包](../dist/releases/musicfs-0.1.0-dev.4-windows-x64.zip)、[对应源码](../dist/releases/musicfs-0.1.0-dev.4-source.zip)与[校验和](../dist/releases/musicfs-0.1.0-dev.4-checksums.txt)；下方dev.3整套归档及其统一清单保持原样，没有重打其他目标或部署云端。

先正常退出旧后台，再解压完整新目录启动；沿用原用户数据，schema8自动升级为9。随后在插件页安装包内`plugins/org.musicfs.netease.zip`（alpha.10），保留原实例与授权。只更新插件而保持旧核心仍有兼容回退，但批量缓存和新进度需要新版核心。插件代码修订会使该实例旧缓存失效，升级后的第一次准备可能仍是冷扫描，后续才直接复用。

完整离线4,000首扫描在缓存有效时为40页、3次基础调用，基本资料与播放信息到期时为83次；只增删少量歌曲复用旧歌准备结果。文件修改时间不再跟随目录刷新时间。本地实际workerd/D1热24首为一页、24条SQL。封面、歌词、实际音频及Range保留，源码与[性能说明](architecture/refresh-performance.md)同步。本包在WSL交叉构建，没有调用Windows宿主、追加真实平台压力测试，或把dev.3的原生挂载验收改记为dev.4通过。

## dev.3 完整发行记录

应用`0.1.0-dev.3`、插件API`0.1.6`、数据库schema8。2026-10-21按用户要求打包最新实现，包含可选音乐资料补全、挂载项管理、WinFsp安装引导、本机HTTPS及Windows原生映射文件上限设置与恢复。下面列出产物、使用入口及未验证范围；既有记录保留各自版本边界，本次仅补现有Windows虚拟机的必要验收，不追加音乐平台请求。

## dev.3 发行范围

共用核心、管理页面、四个桌面目标、Worker、三个来源插件、独立作者工具包与对应项目源码统一交付。已有证据包括Linux/WSL实际运行与FUSE挂载、真实付费Worker生命周期和升级、双示例有限内容/音质、代表客户端，以及本地/云端四次真实退出重登。完整记录见[验收台账](verification.md)。

| 本次跳过 | 当前事实 |
|---|---|
| QQ正常窗口内的真实续期 | 协调、持久化和SDK轮换已有回归，未实际等到正常续期窗口；网易云扫码Cookie不支持login/refresh |
| 其他系统原生运行 | dev.2 Windows 程序已在现有 VM 验证 sample 挂载/重挂/移除及本机自签名 HTTPS；dev.3 已实测原生映射在 50,000,000 字节上限下报文件过大，App 提高上限后完整读取 64MiB 并校验摘要、随后准确恢复原值。未重装已有 WinFsp，未验普通用户桌面中的 UAC 点击。macOS仍只有交叉构建，原生Linux图形入口未验 |
| 免费Worker和大目录资源 | 现有真实结果来自付费账号；免费计划适用性及相应大目录开销未确认 |
| Bun运行时资料完整性核查 | 随包保留既有固定原始声明、正文、NOTICE及来源索引，`complete:false`不变；完整性与对应上游材料缺口见[第三方说明](../third-party/README.md)，本次不继续上游源码/依赖闭包调查 |

上述项目记录为本次跳过或未确认，不记作实测通过。项目自有代码的GPL-3.0-only正文、同版本项目源码及已有第三方材料随包交付；本次收口不构成对全部第三方资料完整性的确认。

## dev.3 整套发行包

本仓库生成的文件位于`dist/releases/`。完整源码/页面/插件身份与摘要以[release-manifest.json](../dist/releases/release-manifest.json)为准，校验文件为[SHA256SUMS](../dist/releases/SHA256SUMS)。

| 用途 | 归档 | 解压后的入口 |
|---|---|---|
| Linux x64 | [Linux ZIP](../dist/releases/musicfs-0.1.0-dev.3-linux-x64.zip) | `musicfs` |
| Windows x64 | [Windows ZIP](../dist/releases/musicfs-0.1.0-dev.3-windows-x64.zip) | `MusicFS.exe` |
| macOS Intel | [macOS x64 ZIP](../dist/releases/musicfs-0.1.0-dev.3-macos-x64.zip) | `MusicFS.app` |
| macOS Apple Silicon | [macOS arm64 ZIP](../dist/releases/musicfs-0.1.0-dev.3-macos-arm64.zip) | `MusicFS.app` |
| 独立云端部署 | [Worker ZIP](../dist/releases/musicfs-0.1.0-dev.3-worker.zip) | `README.md`、`WORKER.md`、`wrangler.jsonc` |
| 开发自己的来源插件 | [作者包 ZIP](../dist/releases/musicfs-0.1.0-dev.3-plugin-author-kit.zip) | 包内`README.md` |
| 从源码构建 | [源码 ZIP](../dist/releases/musicfs-0.1.0-dev.3-source.zip) | `SOURCE.md` |

Linux发行程序在此前版本已有WSL解压运行、FUSE本地/远程挂载及恢复验证，本次仅检查新归档，不重复该旅程。必要原生验收只在现有 Windows VM 执行；其他系统与免费环境边界见上表。

## 开始使用

桌面解压完整归档后打开对应入口，保留程序与随包资源的位置，不需要安装Bun、Node.js或rclone。在WebUI安装插件、创建实例并授权，准备需要的内容源，再发布目录布局。连接播放器、OpenList或挂载的完整步骤见[使用说明](user-guide.md)；当前系统挂载条件见[桌面说明](desktop.md#使用旅程)。

三个独立插件为sample`0.1.3`、QQ`0.1.0-alpha.11`、网易云`0.1.0-alpha.9`，位于发行目录的`plugins/`；桌面包内也有`plugins/`，Worker包内为`plugin-packages/`。通过WebUI按需安装，没有自动激活。QQ、网易云是使用公开合同的示例，来源设置按实例保存。

Worker首次部署按包内`WORKER.md`或[部署说明](worker.md#首次部署)操作。已有部署升级核心/WebUI时，使用同版本源码中的组装工具保留实际云端插件和配置；不要直接上传新包初始注册表。插件自身的安装和更新从WebUI完成。

## dev.3 包含的变化

- API 0.1.6 提供可选插件JSON缓存，SQLite/D1新增schema8缓存表。
- QQ、网易云示例可补全音乐资料、封面和歌词；MP3/FLAC/APE/M4A按标签和原音频区段读取，保持音频编码。格式和真实样本边界见[实现记录](verification/metadata-implementation.md)。
- Windows修复裸盘符规范化和挂载根目录就绪检查，沿用已验证的rclone/WinFsp路径。
- 挂载项支持重新挂载、卸载和移除；重挂复用保存的连接与凭据，移除清理对应保存记录和 rclone 配置。
- Windows 包附带固定官方 WinFsp 运行时安装器，App 检测后按需引导安装；已有组件复用。
- 可选本机 HTTPS WebDAV 复用专用自签名证书；App 经正常系统权限确认完成系统证书信任及启动现有 WebClient，不放宽全局 Basic 认证策略。dev.3 在同一明确操作中将原生映射单文件上限提高到 4GiB−1，并记录原值以供恢复；修改/恢复会重启运行中的 WebClient，短暂中断本机所有原生 WebDAV 连接。更大的文件使用 App 的 WinFsp 挂载。
- 共用目录预览按50项分页，避免一次渲染数千条目。
- 核心/WebUI升级工具保留云端实际插件模块与注册表。
- Worker随包提供详细部署/升级说明；首次部署一次写入四项Secrets，关闭Cron后的续步行为有明确说明。
- 已记录双示例云端有限内容、多目标音质/回退/合并、代表音频以及实际发布切换。切换中页面可用，更新来源的目录曾短暂503后恢复，不承诺无中断。
- 两示例本地/云端均完成退出后新扫码，后续根内容入口恢复，实例配置与布局保留。
- 随包使用说明与Worker指南同步本次交付范围；最终归档与校验和统一生成，复用既有运行证据。

当前已知限制：现有云端关闭Cron，后续分页主要由管理页面推进；已观察到任务停在运行中但未继续提交页，原因尚未修复。新版首次目录准备有额外来源请求成本，播放器歌词同步仍取决于其支持。

项目自有代码、接口和工具为GPL-3.0-only，第三方保留原许可；对应源码单独归档。已收集的运行时资料和尚缺范围见[第三方说明](../third-party/README.md)。
