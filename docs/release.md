# MusicFS 当前交付物

## dev.26 音乐库操作简化

展开来源树时保留当前浏览位置，设置页签保留未保存的输入。「添加到…」可直接新建目标文件夹，并与加入歌单一起撤销；拖拽悬停可展开文件夹，手机添加后直接显示整理结果和保存按钮。

[Windows x64](../dist/releases/0.1.0-dev.26/musicfs-0.1.0-dev.26-windows-x64.zip)、[离线 Worker](../dist/releases/0.1.0-dev.26/musicfs-0.1.0-dev.26-worker.zip)、[源码](../dist/releases/0.1.0-dev.26/musicfs-0.1.0-dev.26-source.zip)、[插件作者包](../dist/releases/0.1.0-dev.26/musicfs-0.1.0-dev.26-plugin-author-kit.zip)、[清单](../dist/releases/0.1.0-dev.26/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.26/SHA256SUMS)。退出旧后台，解压完整新版启动即可；插件、授权和数据库沿用现有版本，无需重新安装或清缓存。

功能证据沿用本轮内置浏览器桌面/手机走查、9项导航/布局回归、前端类型检查及页面构建，见[工作区记录](verification/music-workspace.md#dev26-操作断点修正)。Windows 在 WSL 交叉构建，Worker 为离线包，本次没有新增目标系统运行或云端部署。

## dev.25 音乐库工作区

来源树并入左侧导航，中央专注浏览内容，右侧播放器目录按需打开并记住宽度。支持拖拽整理单张歌单，保存并连接，并在切换页面后保留导航、搜索和浏览位置；手机上用抽屉展开两侧目录。

[Windows x64](../dist/releases/0.1.0-dev.25/musicfs-0.1.0-dev.25-windows-x64.zip)、[离线 Worker](../dist/releases/0.1.0-dev.25/musicfs-0.1.0-dev.25-worker.zip)、[源码](../dist/releases/0.1.0-dev.25/musicfs-0.1.0-dev.25-source.zip)、[插件作者包](../dist/releases/0.1.0-dev.25/musicfs-0.1.0-dev.25-plugin-author-kit.zip)、[清单](../dist/releases/0.1.0-dev.25/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.25/SHA256SUMS)。正常退出旧后台，换完整新版启动即可；无需重装插件、重新授权或清理缓存，数据库无需新迁移。

源码回归、类型检查及内置浏览器的桌面与手机流程核对见[工作区记录](verification/music-workspace.md)。Windows 在 WSL 交叉构建，Worker 为离线部署包；本轮不新增目标系统运行或云端部署结论。

## dev.24 自动更新编辑简化

按来源和范围直接载入已有时间安排，没有规则时才新建；切换范围保留原规则，启停可在表单内修改。移除重复范围警告、跳转编辑按钮和额外规则选择框，修正规则范围重复时误报“状态已变化”的问题。

[Windows x64](../dist/releases/0.1.0-dev.24/musicfs-0.1.0-dev.24-windows-x64.zip)、[离线 Worker](../dist/releases/0.1.0-dev.24/musicfs-0.1.0-dev.24-worker.zip)、[源码](../dist/releases/0.1.0-dev.24/musicfs-0.1.0-dev.24-source.zip)、[清单](../dist/releases/0.1.0-dev.24/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.24/SHA256SUMS)。正常退出旧后台、换完整新版启动即可；本次修正无需重装插件或重新授权，API、插件版本及数据库结构保持 dev.23。

16项定向离线调度测试、三套类型检查、界面构建、依赖边界及8项发行校验和通过。源码与各运行包输入一致，构建提交 `0476651`；本轮未新增 Windows 运行验收或云端部署。[验证记录](verification/updates-and-naming.md#dev24-规则编辑修正)

## dev.23 自动更新与文件命名模板

应用`0.1.0-dev.23`、插件API`0.1.11`，网易云`alpha.20`、QQ`alpha.19`。新增每天/每周/自定义间隔的自动更新，明确单目录、完整子树及整个来源范围；支持自由命名模板、字段插入、条件块和预览。音乐库迁移0013保留旧规则范围与首次触发点，0014保存独立命名策略，旧实例仍使用原名。

[Windows x64](../dist/releases/0.1.0-dev.23/musicfs-0.1.0-dev.23-windows-x64.zip)、[离线Worker](../dist/releases/0.1.0-dev.23/musicfs-0.1.0-dev.23-worker.zip)、[源码](../dist/releases/0.1.0-dev.23/musicfs-0.1.0-dev.23-source.zip)、[插件作者包](../dist/releases/0.1.0-dev.23/musicfs-0.1.0-dev.23-plugin-author-kit.zip)、[清单](../dist/releases/0.1.0-dev.23/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.23/SHA256SUMS)。正常退出旧后台，换完整新版启动，再安装随包`plugins/`中的新版来源插件；更新目录取得命名字段后即可预览模板。实例和授权保留，模板由用户应用后改名。

本次在WSL构建Windows与离线Worker，源码、页面和插件身份一致，8项文件摘要检查全部通过；包内Worker包含迁移0013/0014。功能核对见[记录](verification/updates-and-naming.md)。没有重复平台请求、调用Windows宿主或升级云端，也没有新增Windows运行时验收结论。

## dev.22 小幅更新时减少额外工作

应用 `0.1.0-dev.22`：变化目录的新索引进入缓存时及时移除旧版本，避免挤掉其他目录；直接WebDAV共享音频桶新增文件键时保留同桶既有节点，只标记清单过期。没有新增依赖或数据库迁移，API及示例插件版本不变。

[Windows x64](../dist/releases/0.1.0-dev.22/musicfs-0.1.0-dev.22-windows-x64.zip)、[离线Worker](../dist/releases/0.1.0-dev.22/musicfs-0.1.0-dev.22-worker.zip)、[源码](../dist/releases/0.1.0-dev.22/musicfs-0.1.0-dev.22-source.zip)、[清单](../dist/releases/0.1.0-dev.22/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.22/SHA256SUMS)。退出旧后台、换完整新版启动即可，无需重装插件、清缓存或重刷整库。

完整索引重建保留。序号改名仍可能影响App或播放器的按路径缓存；没有稳定文件时间的第三方插件仍使用目录时间回退。收益和必要离线验证见[评估](verification/partial-directory-update.md)，本次未新增平台、云端或Windows GUI验收。

## dev.21 无变化刷新复用内容版本

应用 `0.1.0-dev.21`：目录内容不变时保留原快照指针、路径索引、已计算的文件ETag和挂载清单，只更新最近成功刷新时间与统计。缺少来源修改时间的文件也保持原时间，重启后一致；条目或来源身份变化仍正常发布。桌面与Worker共用同一事务，不再额外执行桌面全量比较。

[Windows x64](../dist/releases/0.1.0-dev.21/musicfs-0.1.0-dev.21-windows-x64.zip)、[离线Worker](../dist/releases/0.1.0-dev.21/musicfs-0.1.0-dev.21-worker.zip)、[源码](../dist/releases/0.1.0-dev.21/musicfs-0.1.0-dev.21-source.zip)、[清单](../dist/releases/0.1.0-dev.21/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.21/SHA256SUMS)。退出旧后台，解压完整新版启动即可；API0.1.10、插件版本及数据库迁移不变，无需重新安装插件、清缓存或重刷整库。

无变化索引复用、旧行升级、分页/空目录/候选回收、来源变化及周期挂载通知已作SQLite/本地D1定向检查，类型与依赖边界通过。Windows与Worker在WSL构建，未追加平台请求、Windows宿主操作或云端部署。发布比较仍需读取数据库内的候选与旧条目，不等于跳过来源确认。

## dev.20 定向失效与主动更新音乐资料

应用 `0.1.0-dev.20`、插件API `0.1.10`，网易云 `alpha.19`、QQ `alpha.18`。本机目录变化只更新对应挂载路径，覆盖自定义分组、多个入口与嵌套目录；无关目录继续复用缓存。只改两示例的音乐资料保留天数时，保留授权、目录及缓存，新期限用于后续取得的资料。

歌曲目录的「更新」旁新增更多菜单「重新获取音乐资料」，显式绕过旧资料缓存、分页更新封面和歌词等资料；同一任务跨页复用本轮共用资料，沿用原限流、取消与完整发布机制。旧文件引用保持原字节，普通更新与按需读取不变；范围为当前目录，不自动递归或定时执行。

[Windows x64](../dist/releases/0.1.0-dev.20/musicfs-0.1.0-dev.20-windows-x64.zip)、[离线Worker](../dist/releases/0.1.0-dev.20/musicfs-0.1.0-dev.20-worker.zip)、[源码](../dist/releases/0.1.0-dev.20/musicfs-0.1.0-dev.20-source.zip)、[清单](../dist/releases/0.1.0-dev.20/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.20/SHA256SUMS)。正常退出旧后台，解压完整新版启动，再在插件页安装随包网易云/QQ新版插件，保留原实例与授权；两插件现要求API0.1.10，先升级核心。数据库无需新迁移。

定向路径、持久刷新与HTTP入口、两示例新旧歌词/文件引用、SQLite/D1配置保存及重启保留、类型和依赖边界已作离线检查。Windows更新与Worker均在WSL构建，未追加平台整库请求、Windows宿主操作或云端部署。顺序文件名、跨插件修订缓存隔离、Worker音频流式读取保持原方案。

## dev.19 长期缓存与刷新复用

应用 `0.1.0-dev.19`：本机挂载目录默认保留365天、远程挂载30天，挂载及直接 WebDAV 的已读音频缓存保留365天，容量上限不变。缓存设置增加一个月、一年、长期保留及自定义选项。升级时一次性延长旧默认值，保留其他设置；内容相同的目录刷新不再清除本机挂载清单缓存。

网易云 `alpha.18`、QQ `alpha.17` 将封面、歌词等音乐资料默认延长至365天，缺失资料最多缓存30天；网易云稳定歌曲详情也按资料期限跨扫描复用。播放地址与会话期限保持原策略，API0.1.9及音乐库schema10不变。

[Windows x64](../dist/releases/0.1.0-dev.19/musicfs-0.1.0-dev.19-windows-x64.zip)、[源码](../dist/releases/0.1.0-dev.19/musicfs-0.1.0-dev.19-source.zip)、[清单](../dist/releases/0.1.0-dev.19/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.19/SHA256SUMS)。正常退出旧后台后解压完整新版启动，并在插件页安装随包的两个新版插件，保留原实例与授权。挂载在下一次正常挂载时采用新参数；插件更新遵循原有修订隔离，无需清空数据或重新登录。

旧默认迁移及重启保留、无变化发布、网易云长期资料复用和直接 DAV 缓存的定向离线检查通过。仅在 WSL 构建 Windows 更新，未重复请求音乐平台、操作 Windows 宿主或部署云端；缓存所有权与流程见[缓存设计](architecture/cache-policy.md)。

## dev.18 挂载冷目录自动加载

应用 `0.1.0-dev.18`：修复 App 磁盘挂载首次访问未更新内容源时，刷新任务已排队却未唤醒桌面后台、需要打开 Web「浏览内容」才继续的问题。桌面宿主在持久任务写入成功后统一通知后台，移除对 HTTP 入口的调度依赖；分页刷新也让其他实例获得执行机会，不增加平台请求并发。

[Windows x64](../dist/releases/0.1.0-dev.18/musicfs-0.1.0-dev.18-windows-x64.zip)、[源码](../dist/releases/0.1.0-dev.18/musicfs-0.1.0-dev.18-source.zip)、[清单](../dist/releases/0.1.0-dev.18/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.18/SHA256SUMS)。退出旧后台后解压完整新版启动，重新挂载即可；无需重装插件或刷新整库。内部与公开 DAV 冷目录、分页轮转、周期调度、限流、取消、重启和插件迁移的离线测试通过；本次未重复 Windows VM 或真实平台测试。

## dev.17 WebDAV 连接设置

应用 `0.1.0-dev.17`：WebDAV 支持自定义用户名和密码，保存后立即生效、重启保留；连接页提供明文携带凭据的通用导入二维码，桌面可选择局域网地址。

[Windows x64](../dist/releases/0.1.0-dev.17/musicfs-0.1.0-dev.17-windows-x64.zip)、[源码](../dist/releases/0.1.0-dev.17/musicfs-0.1.0-dev.17-source.zip)、[清单](../dist/releases/0.1.0-dev.17/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.17/SHA256SUMS)。正常退出旧后台后，解压完整新版再启动；无需重装插件或刷新音乐目录。本次仅打包 Windows，未升级云端。凭据与 URL 编码已通过本地定向测试，具体播放器的扫码导入取决于其支持。

## dev.16 Windows 托盘交互

应用 `0.1.0-dev.16`：Windows 托盘改为左键双击打开管理页，单击不打开，右键菜单保持。浏览器打开复用 GUI 辅助程序调用系统 URL 处理程序，移除中间 PowerShell，覆盖启动器、托盘和手机入口。

[Windows x64](../dist/releases/0.1.0-dev.16/musicfs-0.1.0-dev.16-windows-x64.zip)、[离线 Worker](../dist/releases/0.1.0-dev.16/musicfs-0.1.0-dev.16-worker.zip)、[源码](../dist/releases/0.1.0-dev.16/musicfs-0.1.0-dev.16-source.zip)、[作者包](../dist/releases/0.1.0-dev.16/musicfs-0.1.0-dev.16-plugin-author-kit.zip)、[清单](../dist/releases/0.1.0-dev.16/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.16/SHA256SUMS)。正常退出旧后台后，解压完整新版再启动。无需重装插件或刷新音乐目录，未升级云端。核对范围见[托盘交互](verification/tray-interaction.md)。

## dev.15 挂载名称

应用 `0.1.0-dev.15`：挂载默认显示 MusicFS，添加时可自定义，已有项可在更多菜单重命名。保存已挂载项会正常重挂，保留 ID、来源和缓存；旧项重新挂载后采用新卷标。自动挂载仍在后台执行，管理页与托盘先可用。

[Windows x64](../dist/releases/0.1.0-dev.15/musicfs-0.1.0-dev.15-windows-x64.zip)、[离线 Worker](../dist/releases/0.1.0-dev.15/musicfs-0.1.0-dev.15-worker.zip)、[源码](../dist/releases/0.1.0-dev.15/musicfs-0.1.0-dev.15-source.zip)、[作者包](../dist/releases/0.1.0-dev.15/musicfs-0.1.0-dev.15-plugin-author-kit.zip)、[清单](../dist/releases/0.1.0-dev.15/release-manifest.json)与[校验和](../dist/releases/0.1.0-dev.15/SHA256SUMS)。本次集中提供 Windows 更新，Linux 可使用相同源码构建；平台插件、公开API和音乐库 schema不变，未升级云端。具体核对见[挂载名称与启动](verification/mount-names.md)。

## dev.14 桌面常驻与管理登录

2026-10-22：应用 `0.1.0-dev.14`，新增托盘入口、登录自启、分开的手动/自启打开页面选项、全局与逐项自动挂载和有限后台重试。管理页支持账号密码、记住登录与退出；桌面自动进入，手机通过短期二维码进入，局域网由用户在设置手动开启并即时生效。

交付位于 `dist/releases/0.1.0-dev.14/`：[Windows x64](../dist/releases/0.1.0-dev.14/musicfs-0.1.0-dev.14-windows-x64.zip)、[Linux x64](../dist/releases/0.1.0-dev.14/musicfs-0.1.0-dev.14-linux-x64.zip)、[离线 Worker](../dist/releases/0.1.0-dev.14/musicfs-0.1.0-dev.14-worker.zip)、[源码](../dist/releases/0.1.0-dev.14/musicfs-0.1.0-dev.14-source.zip)、[作者包](../dist/releases/0.1.0-dev.14/musicfs-0.1.0-dev.14-plugin-author-kit.zip)、[版本清单](../dist/releases/0.1.0-dev.14/release-manifest.json)、[校验和](../dist/releases/0.1.0-dev.14/SHA256SUMS)。桌面包包含原生 helper。

正常退出旧后台，解压完整新版后启动。默认登录自启、自动挂载开启，手动启动打开页面，自启静默；均可在设置调整。首次桌面无需设密码，按需创建账号。公开 API0.1.9、音乐库 schema10、网易云 alpha.17 与 QQ alpha.16 不变，无需重装插件或刷新整库。桌面认证单独存储 auth.sqlite；部署 Worker 时应用新增 D1 迁移0011，现有云端本轮未升级。

本地会话、自动恢复、监听切换和浏览器旅程已定向核对。正式 Windows 包已在现有 VM 通过托盘、当前用户自启注册及命令执行、自动挂载和管理登录的必要验收，测试后恢复原自启值并清理；macOS 适配代码完成编译检查，但缺 Apple SDK，尚无新版可运行包；免费 Worker 密码 CPU 尚未实测。证据见[桌面访问核对](verification/desktop-access.md)。

## dev.13 界面与目录整理

2026-10-22：应用 `0.1.0-dev.13`，包含来源添加与登录流程、插件安装、播放器连接和目录浏览的界面重构，以及新的目录整理工作区。支持批量添加、原位改名、拖动与明确移动、搜索、撤销和重做；自动目录可直接开始整理，统一保存后发布。

交付位于 `dist/releases/0.1.0-dev.13/`：[Windows x64](../dist/releases/0.1.0-dev.13/musicfs-0.1.0-dev.13-windows-x64.zip)、[Linux x64](../dist/releases/0.1.0-dev.13/musicfs-0.1.0-dev.13-linux-x64.zip)、[离线 Worker](../dist/releases/0.1.0-dev.13/musicfs-0.1.0-dev.13-worker.zip)、[源码](../dist/releases/0.1.0-dev.13/musicfs-0.1.0-dev.13-source.zip)、[作者包](../dist/releases/0.1.0-dev.13/musicfs-0.1.0-dev.13-plugin-author-kit.zip)、[版本清单](../dist/releases/0.1.0-dev.13/release-manifest.json)、[校验和](../dist/releases/0.1.0-dev.13/SHA256SUMS)。三个独立插件在同目录的 `plugins/` 中。

正常退出旧后台，解压完整新版后启动。API 0.1.9、schema10、网易云 alpha.17 和 QQ alpha.16 不变；此次界面更新无需重装插件或刷新整库。云端使用需另行部署 Worker 包。

本地示例已走通主要界面流程与目录整理，33 项定向回归、三套类型、模块边界和正式页面构建通过；见[界面走查](verification/ui-redesign.md)及[目录整理记录](verification/directory-workspace.md)。本次在 WSL 构建并核对归档与校验和，未重新进行目标系统验收或部署云端。

## dev.12 应用场景性能优化

2026-10-22：应用`0.1.0-dev.12`，API0.1.9/schema10不变，网易云alpha.17、QQ alpha.16。包含无变化挂载状态写盘减法、桌面32MiB路径索引与紧凑保留、单曲资料等待优化，以及本轮应用场景修正：未读文件身份在资料期限内稳定、纯音频Range跳过无关共享封面、复用有效播放版本定位、关闭缓存时仍跟踪在途读取。顺序文件名和已接受的1MiB预留不变。

交付位于`dist/releases/0.1.0-dev.12/`：[Windows x64](../dist/releases/0.1.0-dev.12/musicfs-0.1.0-dev.12-windows-x64.zip)、[Linux x64](../dist/releases/0.1.0-dev.12/musicfs-0.1.0-dev.12-linux-x64.zip)、[离线Worker](../dist/releases/0.1.0-dev.12/musicfs-0.1.0-dev.12-worker.zip)、[源码](../dist/releases/0.1.0-dev.12/musicfs-0.1.0-dev.12-source.zip)、[作者包](../dist/releases/0.1.0-dev.12/musicfs-0.1.0-dev.12-plugin-author-kit.zip)、[版本清单](../dist/releases/0.1.0-dev.12/release-manifest.json)、[校验和](../dist/releases/0.1.0-dev.12/SHA256SUMS)。统一构建输入为干净提交`ecbc151`；独立插件在该版本目录的`plugins/`中，避免混用旧发行物。

Linux正式程序以临时数据、示例插件完成一次页面/插件安装/目录与状态/HEAD/准确Range/重复启动复用/正常退出的离线冒烟；未启用系统挂载、崩溃恢复或音乐平台。Windows为WSL交叉构建，未重跑VM；Worker只构建、不部署或重测免费CPU。定向模块回归及限制见[局部核对](verification/performance-local-2026-10-22.md)，候选停止/重开条件见[ROI复评](../outputs/musicfs-performance-review.md#当前roi停止决定)。

正常退出旧后台，解压完整新版并重新挂载；安装随包最新示例插件，再刷新相应歌曲目录以采用新的引用策略。插件升级沿现有修订隔离，不能承诺复用旧修订缓存。更新核心本身不要求为了轮询/索引改动重刷整库；不部署云端、不重建macOS，旧归档保持原身份。

## dev.11 直接WebDAV共享读取缓存

应用`0.1.0-dev.11`，API0.1.9/schema10及插件alpha.15保持。桌面直接DAV新增rclone服务端VFS稀疏缓存，默认16GiB软上限/7天，可查询实际状态、配置或清理；App本机挂载走内部直读，避免同次读取重复落盘，批量元数据路径保留。已有挂载的8GiB设置不自动更改，正常重新挂载即可采用内部路径，无需重装插件或刷新整库。

正式模块的有限范围、重叠、原生VFS重建后头尾重读0次源请求；同路径/大小/mtime的新内容身份、旧来源拒绝、活动读取、清理/关闭及退出准备通过。有界FFprobe开放GET会因取消时机不同补读新增范围，不承诺第二次零网络或真实4000首固定耗时。Worker保持流式，不重建/部署云端。[设计、证据及容量取舍](architecture/shared-read-cache.md)

最终Windows包已在现有VM通过直接DAV重复范围、整个App正常重启后的缓存复用、清理后重新取源及App本机挂载绕过共享落盘；正常退出。未测真实整库或新增平台请求，Worker未重建或部署。

产物：[Windows x64](../dist/releases/0.1.0-dev.11/musicfs-0.1.0-dev.11-windows-x64.zip)、[对应源码](../dist/releases/0.1.0-dev.11/musicfs-0.1.0-dev.11-source.zip)、[版本清单](../dist/releases/0.1.0-dev.11/release-manifest.json)、[校验和](../dist/releases/0.1.0-dev.11/SHA256SUMS)。构建输入为干净提交`103d7e8`；正常退出旧后台、解压完整新版并重新挂载即可，原数据/授权/插件保留。本轮接入不新增第三方依赖，也未替换为自制分块框架。

## dev.10 缓存管理与播放范围调整

应用`0.1.0-dev.10`，API0.1.9/schema10及插件alpha.15保持。新增挂载缓存管理，可查询实际VFS模式、原生路径和占用，定向清理后正常重挂；原生统计可能滞后。初始读取块从256KiB调至1MiB，受控播放SDK/CDN调用7次降至4次，预留标签文件头小读仍无需源音频。已有挂载正常重挂即可使用新参数，无需刷新整库或重装插件。

定向回归15项/140断言、三套类型和依赖边界通过；实际FFprobe调查显示直接DAV开放GET仍重复读取源音频，因此本轮未新增覆盖不足的局部服务端缓存。[消费证据与限制](verification/cache-consumption-2026-10-21.md)。最终Windows包已在现有VM通过原生Shell/FileStream消费、正常重挂零GET、定向清理后重新取源和正常退出。原生占用采样会滞后；未重新测真实4000首GUI目录总耗时。不重建或部署Worker。

产物位于`dist/releases/0.1.0-dev.10/`：[Windows x64](../dist/releases/0.1.0-dev.10/musicfs-0.1.0-dev.10-windows-x64.zip)、[对应源码](../dist/releases/0.1.0-dev.10/musicfs-0.1.0-dev.10-source.zip)、[版本清单](../dist/releases/0.1.0-dev.10/release-manifest.json)、[校验和](../dist/releases/0.1.0-dev.10/SHA256SUMS)。Windows、源码和清单三项摘要校验通过。构建输入为干净提交`a69ffbf`，目标系统验收仅覆盖上述有界消费行为，不代表恢复历史全矩阵。

## dev.9 App挂载读取缓存

应用`0.1.0-dev.9`，API0.1.9/schema10和插件alpha.15保持。App挂载启用rclone原生稀疏读取缓存，可设置容量与未访问保留时间（默认每挂载8GiB/7天）；同时限制初始预读，防止扫描文件头时预取大量音频。实际WSL/FUSE+HTTP离线对照：跨真实卸载/重挂的头尾重读0次GET，同路径同大小正常更新后读取新字节，完整65MiB顺序读取正确。挂载测试12项/111断言、三套类型及依赖边界通过。

本次仅生成Windows更新及对应源码，不重建或部署Worker。正常退出旧后台，解压完整新版启动，在App中重新挂载；已有网易云/QQ alpha.15无需重新安装或刷新整库。这不等于Windows资源管理器整体十多秒等待已经重新实测。直接DAV客户端仍依赖其自身音频缓存，共用资料/标签与字节缓存的区别见[挂载设计](architecture/desktop-mounts.md#直接webdav与播放器)。

产物位于`dist/releases/0.1.0-dev.9/`：[Windows x64](../dist/releases/0.1.0-dev.9/musicfs-0.1.0-dev.9-windows-x64.zip)、[对应源码](../dist/releases/0.1.0-dev.9/musicfs-0.1.0-dev.9-source.zip)、[版本清单](../dist/releases/0.1.0-dev.9/release-manifest.json)、[校验和](../dist/releases/0.1.0-dev.9/SHA256SUMS)。仅复用既有运行时/工具做WSL交叉构建，不调用Windows宿主，不新增平台请求。源码构建身份`459621b`；三个文件摘要已校验，Windows目标系统运行仍未在本轮重验。

## dev.8 缓存策略与目录自动更新

应用`0.1.0-dev.8`、API`0.1.9`、schema10，网易云与QQ均`alpha.15`。产物位于`dist/releases/0.1.0-dev.8/`：[Windows x64](../dist/releases/0.1.0-dev.8/musicfs-0.1.0-dev.8-windows-x64.zip)、[Linux x64](../dist/releases/0.1.0-dev.8/musicfs-0.1.0-dev.8-linux-x64.zip)、[Worker](../dist/releases/0.1.0-dev.8/musicfs-0.1.0-dev.8-worker.zip)、[源码](../dist/releases/0.1.0-dev.8/musicfs-0.1.0-dev.8-source.zip)、[校验和](../dist/releases/0.1.0-dev.8/SHA256SUMS)。

- 挂载目录缓存从5秒改为默认5分钟，每挂载可配置秒数，0不自动过期；支持设置/正常重挂及“刷新挂载目录”。本机目录完整发布、来源/布局/插件成功变化后主动通知rclone失效，远程挂载仍按期限或手动刷新。
- 网易云/QQ实例可设置稳定音乐资料缓存天数，0长期保留。旧配置默认7天/1天，空或缺失结果仍1天后重试；既有歌曲详情、播放地址和授权机制不被全局延长。
- 内容源与已发布目录的“更新策略”可选择手动、15分钟、小时、6小时、每天或每周；默认手动。更新只处理指定目录，后台分页更新期间继续使用上次成功快照，失败保留；桌面网页关闭后继续，Worker沿用已有Cron，不保证准点完成大目录。
- rclone子进程增加`windowsHide: true`，日志仍写入文件。未为此新建启动包装脚本或后台程序。

正常退出旧后台，解压完整新版启动；已有挂载重新挂载后采用新设置。安装随包alpha.15可获得实例资料保留配置。SQLite自动升级schema10，已有数据/授权保持；部署Worker先应用新增0010迁移。本轮不部署云端，不重刷真实歌单，不重复原生格式全矩阵。

真实WSL/FUSE离线4k目录跨6秒再入从3次PROPFIND变0次，约119ms降至8ms；手动保留模式刷新后能读到新发布的第4001项。它不是Windows资源管理器十多秒等待的完整实测，尚不能排除资源管理器额外读取标签。现有Windows VM SSH本轮超时，窗口隐藏尚无新VM运行回执。缓存、定时器、重启与旧快照的必要离线回归、类型和依赖边界通过；五个归档、三个插件与版本清单的九项校验均通过。构建输入为干净提交`9c1a31b`，源码摘要`ef0cd654b6be72c653edc5420c5879ea61b765fc95d1b43a636d89b6d530ee63`。[设计与流程](architecture/cache-policy.md)


## dev.7 真正按需挂载更新

2026-10-21，应用 `0.1.0-dev.7`、API `0.1.9`、schema9；网易云与 QQ 均为 `0.1.0-alpha.14`。本版按版本建立发行目录 `dist/releases/0.1.0-dev.7/`，包含 [Windows x64](../dist/releases/0.1.0-dev.7/musicfs-0.1.0-dev.7-windows-x64.zip)、[Linux x64](../dist/releases/0.1.0-dev.7/musicfs-0.1.0-dev.7-linux-x64.zip)、[Worker](../dist/releases/0.1.0-dev.7/musicfs-0.1.0-dev.7-worker.zip)、[作者包](../dist/releases/0.1.0-dev.7/musicfs-0.1.0-dev.7-plugin-author-kit.zip)、[对应源码](../dist/releases/0.1.0-dev.7/musicfs-0.1.0-dev.7-source.zip)、`plugins/` 中的三个独立插件，以及 [版本清单](../dist/releases/0.1.0-dev.7/release-manifest.json)和 [SHA256SUMS](../dist/releases/0.1.0-dev.7/SHA256SUMS)。历史归档保持原链接；重新打包仅替换同版本目录，不覆盖其它版本。

网易云 alpha.14 默认对 MP3、FLAC、M4A 发布“上游准确大小 + 1MiB”的最终文件描述。列目录、PROPFIND 和 HEAD 不再为这些文件准备整库标签，首次 GET 才补齐所读单曲的资料、封面和歌词；播放器或 Windows 的预读也可能触发这次单曲准备。填充使用格式合法的空白区段，持久计划仅记录区段长度，读取时生成，不在数据库逐首保存 1MiB 空白。音频编码和原音频字节保持不变。

第一次成功准备通过 API 0.1.9 的可选原子缓存写入固定同一文件版本，后续读取及资料 TTL 到期不会悄悄改变该版本的字节。ready 索引的 TTL 只决定未来目录刷新是否复用旧版本。若单曲资料超过 1MiB 预算，则保存该曲准确的非预留表示，当前读取返回 `content_changed` 并提示刷新目录；不截断歌词、缩减封面或按旧大小输出更长文件。刷新后使用该单曲准确描述，其余歌曲仍按需读取。

QQ alpha.14 因共用音频工具更新而重建，目录准备策略不变；APE 不默认采用预留表示。旧插件的 `deferredInfo` 与持久“准备文件”任务继续兼容，不能把本版网易云的冷目录能力推及所有来源。

先正常退出旧后台，解压完整新目录启动，沿用原数据；在插件页安装随包网易云 alpha.14，再刷新相关内容源生成新描述，保留实例与授权。只更新核心不会自动替换现有插件或旧目录。schema9 不变，无额外数据库迁移。

用户已接受的限制仍然存在：完整下载或缓存每首预留文件会额外占用 1MiB；播放器逐首读取标签时仍要处理对应歌曲；歌词与多歌手的显示取决于播放器；M4A 需读取完整 `moov`，分片 MP4 不在当前方案内。此前 Windows VM 与 WSL 的实际 App 挂载原型已覆盖 MP3/FLAC/M4A；这些证据不等于 dev.7 正式发行物的目标系统验收。[格式证据与限制](verification/lazy-mount-feasibility.md)

本轮网易云离线集成 5 项／168 断言及音频工具 23 项回归已通过。正式打包 SDK 经本地 workerd/D1 以受控响应验证200首：冷清单1页26SQL且0标签计划，HEAD及完整allprop均0上游请求；首次GET仅准备1首、32SQL、5次传输，持久计划1,044B，完整标签与尾Range通过。热刷新25SQL、3次成员/歌单请求并复用已读曲版本。这些是离线计数，不是平台耗时或免费云端CPU证据。[接线回执](verification/lazy-mount-feasibility.md#dev7-正式接线与本地-worker-验证) Linux正式编译App已通过启动、独立后台、外置sample安装、管理API、HEAD/Range及重复启动复用的离线冒烟；本版五个归档、三个插件和清单的九项校验全部通过。发行输入为干净源码`82ef7fd`，摘要`b566c7bab40b6cdf5f69aacbd99cf55e0e597d61dd523b096c789ef909a9522c`。新Windows二进制本轮未重跑VM矩阵，macOS未重建。没有为本轮再次请求音乐平台、部署云端或重跑原生系统全矩阵。

## dev.6 按需文件准备更新

2026-10-21，应用`0.1.0-dev.6`、API`0.1.8`、schema9；网易云`alpha.13`、QQ`alpha.13`。提供[Windows x64](../dist/releases/musicfs-0.1.0-dev.6-windows-x64.zip)、[Linux x64](../dist/releases/musicfs-0.1.0-dev.6-linux-x64.zip)、[Worker](../dist/releases/musicfs-0.1.0-dev.6-worker.zip)、[作者包](../dist/releases/musicfs-0.1.0-dev.6-plugin-author-kit.zip)、[对应源码](../dist/releases/musicfs-0.1.0-dev.6-source.zip)与[本版校验和](../dist/releases/musicfs-0.1.0-dev.6-checksums.txt)。旧归档保留自身身份，本轮不重新打包macOS或部署云端。

先正常退出旧后台，解压完整新目录启动，沿用原数据。随后在插件页安装随包网易云alpha.13，保留原实例与授权；仅更新核心不会自动替换现有插件。alpha.13要求新API，旧宿主会拒绝；插件修订更新会使派生缓存失效。schema9不变，没有额外迁移。

网易云先发布完整清单，单文件首次读取按需补标签；需要App挂载或全库扫描时，先在内容源/已发布目录点击“准备文件”，完成后连接客户端。未完成的全属性请求快速503，复用现有持久后台任务，避免长同步请求和错误大小；客户端有限重试不保证等完大目录。旧插件的实时stat保持兼容，补标签仍由来源插件选择。

真实本机空缓存4,159首在alpha.12的100首批次下，完整清单24.945秒、87次请求，上版同规模首次可见约13分钟；首曲HEAD约307ms，热HEAD约3ms。alpha.13随后验证200首真批量，离线4k为20页、43次基础调用，未为新耗时再重刷真实整库；MP3头尾合并、富详情减少专辑查询、共享封面继续保留。[范围与匿名证据](verification/deferred-catalogue.md)

公共改动155项受影响回归通过，最终200首调整后网易云52项回归、三套类型与依赖边界通过；真实rclone离线小样本准备后准确大小/完整读取/Range通过。实际packed SDK的本地workerd/D1 200首最多38SQL/准备步，完整属性与标签/Range正确。这些不代表真实全库播放器入库、免费云端CPU或本版Windows原生运行通过；Windows为WSL交叉构建，历史VM验收范围保持原样。

发行输入为干净源码`e2b36bb`，源码摘要`67f5b5f2557e8885cf2e15f1001ebf659847a58a01e4725bc330bead5ae4839d`；详细修订见[本版清单](../dist/releases/musicfs-0.1.0-dev.6-manifest.json)。五个归档、三个插件与版本清单校验均通过。Linux编译发行物另经启动、独立后台、安装外置sample、管理API、HEAD/Range及重复启动复用的离线冒烟。

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

本仓库生成的文件位于`dist/releases/`。dev.3完整源码/页面/插件身份与摘要保存在[版本清单](../dist/releases/musicfs-0.1.0-dev.3-manifest.json)，校验文件为[版本校验和](../dist/releases/musicfs-0.1.0-dev.3-checksums.txt)；无版本前缀的清单现在指向最新发行。

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

桌面解压完整归档后打开对应入口，保留程序与随包资源的位置，不需要安装Bun、Node.js或rclone。在WebUI安装插件、创建实例并授权，准备需要的内容源，再发布目录布局。连接播放器、OpenList或挂载的完整步骤见[使用说明](user-guide.md)；当前系统挂载条件见[桌面说明](desktop.md#打开常驻和退出)。

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
