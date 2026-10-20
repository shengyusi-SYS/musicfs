# MusicFS 当前交付物

应用`0.1.0-dev.0`、插件API`0.1.5`、数据库schema7。当前为开发预览；原生系统、真实会话与免费环境的剩余验收仍见[台账](verification.md#当前有限剩余清单)。本页提供实际产物和使用入口，不代替验收结果。

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

Linux发行程序已在WSL完成解压运行、FUSE本地/远程挂载及恢复验证；Windows/macOS当前只有交叉构建，原生Linux图形入口也待验。Worker已在付费账号完成有限真实旅程，免费计划与大目录资源仍未确认。

## 开始使用

桌面解压完整归档后打开对应入口，保留程序与随包资源的位置，不需要安装Bun、Node.js或rclone。在WebUI安装插件、创建实例并授权，准备需要的内容源，再发布目录布局。连接播放器、OpenList或挂载的完整步骤见[使用说明](user-guide.md)；当前系统挂载条件见[桌面说明](desktop.md#使用旅程)。

三个独立插件为sample`0.1.3`、QQ`0.1.0-alpha.10`、网易云`0.1.0-alpha.8`，位于发行目录的`plugins/`；桌面包内也有`plugins/`，Worker包内为`plugin-packages/`。通过WebUI按需安装，没有自动激活。QQ、网易云是使用公开合同的示例，来源设置按实例保存。

Worker首次部署按包内`WORKER.md`或[部署说明](worker.md#首次部署)操作。已有部署升级核心/WebUI时，使用同版本源码中的组装工具保留实际云端插件和配置；不要直接上传新包初始注册表。插件自身的安装和更新从WebUI完成。

## 本轮包含的变化

- 共用目录预览按50项分页，避免一次渲染数千条目。
- 核心/WebUI升级工具保留云端实际插件模块与注册表。
- Worker随包提供详细部署/升级说明；首次部署一次写入四项Secrets，关闭Cron后的续步行为有明确说明。
- 已记录双示例云端有限内容、多目标音质/回退/合并、代表音频以及实际发布切换。切换中页面可用，更新来源的目录曾短暂503后恢复，不承诺无中断。

项目自有代码、接口和工具为GPL-3.0-only，第三方保留原许可；对应源码单独归档。已收集的运行时资料和尚缺范围见[第三方说明](../third-party/README.md)，不把本页当作全部发行验收通过。
