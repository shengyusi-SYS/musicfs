# MusicFS 当前交付物

应用`0.1.0-dev.3`、插件API`0.1.6`、数据库schema8。2026-10-21按用户要求打包最新实现，包含可选音乐资料补全、挂载项管理、WinFsp安装引导、本机HTTPS及Windows原生映射文件上限设置与恢复。下面列出产物、使用入口及未验证范围；既有记录保留各自版本边界，本次仅补现有Windows虚拟机的必要验收，不追加音乐平台请求。

## 本次发行范围

共用核心、管理页面、四个桌面目标、Worker、三个来源插件、独立作者工具包与对应项目源码统一交付。已有证据包括Linux/WSL实际运行与FUSE挂载、真实付费Worker生命周期和升级、双示例有限内容/音质、代表客户端，以及本地/云端四次真实退出重登。完整记录见[验收台账](verification.md)。

| 本次跳过 | 当前事实 |
|---|---|
| QQ正常窗口内的真实续期 | 协调、持久化和SDK轮换已有回归，未实际等到正常续期窗口；网易云扫码Cookie不支持login/refresh |
| 其他系统原生运行 | dev.2 Windows 程序已在现有 VM 验证 sample 挂载/重挂/移除及本机自签名 HTTPS；dev.3 已实测原生映射在 50,000,000 字节上限下报文件过大，App 提高上限后完整读取 64MiB 并校验摘要、随后准确恢复原值。未重装已有 WinFsp，未验普通用户桌面中的 UAC 点击。macOS仍只有交叉构建，原生Linux图形入口未验 |
| 免费Worker和大目录资源 | 现有真实结果来自付费账号；免费计划适用性及相应大目录开销未确认 |
| Bun运行时资料完整性核查 | 随包保留既有固定原始声明、正文、NOTICE及来源索引，`complete:false`不变；完整性与对应上游材料缺口见[第三方说明](../third-party/README.md)，本次不继续上游源码/依赖闭包调查 |

上述项目记录为本次跳过或未确认，不记作实测通过。项目自有代码的GPL-3.0-only正文、同版本项目源码及已有第三方材料随包交付；本次收口不构成对全部第三方资料完整性的确认。

## 选择发行包

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

## 本轮包含的变化

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
