# MusicFS 当前交付物

应用`0.1.0-dev.0`、插件API`0.1.5`、数据库schema7。本次按用户2026-10-20“直接进入最终发行收口，其它验证跳过”的决定，交付当前已实现的开发预览。下面列出实际产物、使用入口和未验证范围；原有完整验收目标保留为历史范围，不再阻塞本次打包交付。

## 本次发行范围

共用核心、管理页面、四个桌面目标、Worker、三个来源插件、独立作者工具包与对应项目源码统一交付。已有证据包括Linux/WSL实际运行与FUSE挂载、真实付费Worker生命周期和升级、双示例有限内容/音质、代表客户端，以及本地/云端四次真实退出重登。完整记录见[验收台账](verification.md)。

| 本次跳过 | 当前事实 |
|---|---|
| QQ正常窗口内的真实续期 | 协调、持久化和SDK轮换已有回归，未实际等到正常续期窗口；网易云扫码Cookie不支持login/refresh |
| 其他系统原生运行 | Windows x64、macOS Intel/Apple Silicon只有构建产物；原生Linux图形入口未验。WSL运行与挂载结果沿用 |
| 免费Worker和大目录资源 | 现有真实结果来自付费账号；免费计划适用性及相应大目录开销未确认 |
| Bun运行时资料完整性核查 | 随包保留既有固定原始声明、正文、NOTICE及来源索引，`complete:false`不变；完整性与对应上游材料缺口见[第三方说明](../third-party/README.md)，本次不继续上游源码/依赖闭包调查 |

上述项目记录为本次跳过或未确认，不记作实测通过。项目自有代码的GPL-3.0-only正文、同版本项目源码及已有第三方材料随包交付；本次收口不构成对全部第三方资料完整性的确认。

## 选择发行包

本仓库生成的文件位于`dist/releases/`。完整源码/页面/插件身份与摘要以[release-manifest.json](../dist/releases/release-manifest.json)为准，校验文件为[SHA256SUMS](../dist/releases/SHA256SUMS)。

| 用途 | 归档 | 解压后的入口 |
|---|---|---|
| Linux x64 | [Linux ZIP](../dist/releases/musicfs-0.1.0-dev.0-linux-x64.zip) | `musicfs` |
| Windows x64 | [Windows ZIP](../dist/releases/musicfs-0.1.0-dev.0-windows-x64.zip) | `MusicFS.exe` |
| macOS Intel | [macOS x64 ZIP](../dist/releases/musicfs-0.1.0-dev.0-macos-x64.zip) | `MusicFS.app` |
| macOS Apple Silicon | [macOS arm64 ZIP](../dist/releases/musicfs-0.1.0-dev.0-macos-arm64.zip) | `MusicFS.app` |
| 独立云端部署 | [Worker ZIP](../dist/releases/musicfs-0.1.0-dev.0-worker.zip) | `README.md`、`WORKER.md`、`wrangler.jsonc` |
| 开发自己的来源插件 | [作者包 ZIP](../dist/releases/musicfs-0.1.0-dev.0-plugin-author-kit.zip) | 包内`README.md` |
| 从源码构建 | [源码 ZIP](../dist/releases/musicfs-0.1.0-dev.0-source.zip) | `SOURCE.md` |

Linux发行程序已在WSL完成解压运行、FUSE本地/远程挂载及恢复验证。其余系统与免费环境的本次跳过范围见上表。

## 开始使用

桌面解压完整归档后打开对应入口，保留程序与随包资源的位置，不需要安装Bun、Node.js或rclone。在WebUI安装插件、创建实例并授权，准备需要的内容源，再发布目录布局。连接播放器、OpenList或挂载的完整步骤见[使用说明](user-guide.md)；当前系统挂载条件见[桌面说明](desktop.md#使用旅程)。

三个独立插件为sample`0.1.3`、QQ`0.1.0-alpha.10`、网易云`0.1.0-alpha.8`，位于发行目录的`plugins/`；桌面包内也有`plugins/`，Worker包内为`plugin-packages/`。通过WebUI按需安装，没有自动激活。QQ、网易云是使用公开合同的示例，来源设置按实例保存。

Worker首次部署按包内`WORKER.md`或[部署说明](worker.md#首次部署)操作。已有部署升级核心/WebUI时，使用同版本源码中的组装工具保留实际云端插件和配置；不要直接上传新包初始注册表。插件自身的安装和更新从WebUI完成。

## 本轮包含的变化

- 共用目录预览按50项分页，避免一次渲染数千条目。
- 核心/WebUI升级工具保留云端实际插件模块与注册表。
- Worker随包提供详细部署/升级说明；首次部署一次写入四项Secrets，关闭Cron后的续步行为有明确说明。
- 已记录双示例云端有限内容、多目标音质/回退/合并、代表音频以及实际发布切换。切换中页面可用，更新来源的目录曾短暂503后恢复，不承诺无中断。
- 两示例本地/云端均完成退出后新扫码，后续根内容入口恢复，实例配置与布局保留。
- 随包使用说明与Worker指南同步本次交付范围；最终归档与校验和统一生成，复用既有运行证据。

项目自有代码、接口和工具为GPL-3.0-only，第三方保留原许可；对应源码单独归档。已收集的运行时资料和尚缺范围见[第三方说明](../third-party/README.md)。
