# MusicFS 发行历史

按版本记录主要变化。当前下载、升级和构建身份见[发行页](release.md)；各版本的实测范围见[验收台账](verification.md)。旧归档已从本地清理，历史细节保留在 Git 与对应验证记录中。

## 0.1.2 过期读取缓存修复

来源代际变化后，旧内部缓存地址返回 404，新状态使用独立缓存键读取，不清空其他有效磁盘缓存。同代际的会话状态并发冲突保留可重试地址。修正响应头返回前主动取消被记录为服务故障的问题，超时仍保留诊断。

挂载缓存仍有一个已确认限制：同路径、大小和修改时间的内容变化可能继续命中旧片段；本版未修复该问题，详见[验证范围](verification.md#读取缓存边界)。

## 0.1.1 云端部署与网页更新

修正 Cloudflare 一键部署已创建占位 Worker 时首次安装失败的问题。新增「更新 MusicFS / Update MusicFS」工作流，默认选择正式版，检查后生成更新请求；合并后沿用现有资源部署。补齐旧仓库接入、中英文更新说明，以及构建令牌与插件发布令牌的用途说明。

## dev.31 中英文与完整文档

中英文界面覆盖页面、插件显示、表单校验、错误提示、终端和托盘；无桌面启动提供可用入口。桌面、Worker、源码和作者包携带对应双语指南，README 加入工具定位声明。 [中英文记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/i18n.md)、[无桌面记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/headless-access.md)。

## dev.30 独立端口消费链路收口

播放器扫码沿用连接页选定的局域网地址；手机管理与播放器二维码打开时读取当前本机端口和网卡。核对本机挂载持续使用内部读取入口，修改公开端口不重挂载，重启后的自动挂载重新取得本轮内部地址。 [消费链路记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/network-access.md#dev30-消费链路核查)。

## dev.29 管理与 WebDAV 独立端口

管理页面与 WebDAV 分别监听不同端口，各自设置访问范围。管理端口只提供管理页面与接口，WebDAV 端口只供播放器读取；修改其中一项不移动另一项。端口填0自动选择，正常重启后尽量复用已分配地址。本机 HTTPS 映射也只提供 WebDAV。 [双端口记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/network-access.md#dev29-独立监听端口)。

## dev.28 WebDAV 设置回归播放器页面

「设置 → 管理页面访问」只管理页面访问；WebDAV 的访问设备、地址、账号密码和扫码导入集中在「连接与挂载 → WebDAV 播放器」。多网卡可直接选择连接地址，服务端口按需展开；两页独立保存，不覆盖另一项的访问范围。 [入口拆分证据](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/network-access.md#dev28-入口拆分)。

## dev.27 管理与 WebDAV 独立访问

设置中可分别选择管理页面和 WebDAV 仅本机访问或开放到局域网，共用原有端口。管理扫码与播放器导入各自显示对应地址；只开放 WebDAV 时，管理页面仍仅本机可用。 [网络访问证据](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/network-access.md)。

## dev.26 音乐库操作简化

展开来源树时保留当前浏览位置，设置页签保留未保存的输入。「添加到…」可直接新建目标文件夹，并与加入歌单一起撤销；拖拽悬停可展开文件夹，手机添加后直接显示整理结果和保存按钮。 [工作区记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/music-workspace.md#dev26-操作断点修正)。

## dev.25 音乐库工作区

来源树并入左侧导航，中央专注浏览内容，右侧播放器目录按需打开并记住宽度。支持拖拽整理单张歌单，保存并连接，并在切换页面后保留导航、搜索和浏览位置；手机上用抽屉展开两侧目录。 [工作区记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/music-workspace.md)。

## dev.24 自动更新编辑简化

按来源和范围直接载入已有时间安排，没有规则时才新建；切换范围保留原规则，启停可在表单内修改。移除重复范围警告、跳转编辑按钮和额外规则选择框，修正规则范围重复时误报“状态已变化”的问题。 [验证记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/updates-and-naming.md#dev24-规则编辑修正)。

## dev.23 自动更新与文件命名模板

应用`0.1.0-dev.23`、插件API`0.1.11`，网易云`alpha.20`、QQ`alpha.19`。新增每天/每周/自定义间隔的自动更新，明确单目录、完整子树及整个来源范围；支持自由命名模板、字段插入、条件块和预览。音乐库迁移0013保留旧规则范围与首次触发点，0014保存独立命名策略，旧实例仍使用原名。 [记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/updates-and-naming.md)。

## dev.22 小幅更新时减少额外工作

变化目录的新索引进入缓存时及时移除旧版本，避免挤掉其他目录；直接WebDAV共享音频桶新增文件键时保留同桶既有节点，只标记清单过期。没有新增依赖或数据库迁移，API及示例插件版本不变。 [评估](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/partial-directory-update.md)。

## dev.21 无变化刷新复用内容版本

目录内容不变时保留原快照指针、路径索引、已计算的文件ETag和挂载清单，只更新最近成功刷新时间与统计。缺少来源修改时间的文件也保持原时间，重启后一致；条目或来源身份变化仍正常发布。桌面与Worker共用同一事务，不再额外执行桌面全量比较。 [缓存设计](architecture/cache-policy.md)。

## dev.20 定向失效与主动更新音乐资料

应用 `0.1.0-dev.20`、插件API `0.1.10`，网易云 `alpha.19`、QQ `alpha.18`。本机目录变化只更新对应挂载路径，覆盖自定义分组、多个入口与嵌套目录；无关目录继续复用缓存。只改两示例的音乐资料保留天数时，保留授权、目录及缓存，新期限用于后续取得的资料。 [缓存设计](architecture/cache-policy.md)。

## dev.19 长期缓存与刷新复用

本机挂载目录默认保留365天、远程挂载30天，挂载及直接 WebDAV 的已读音频缓存保留365天，容量上限不变。缓存设置增加一个月、一年、长期保留及自定义选项。升级时一次性延长旧默认值，保留其他设置；内容相同的目录刷新不再清除本机挂载清单缓存。 [缓存设计](architecture/cache-policy.md)。

## dev.18 挂载冷目录自动加载

修复 App 磁盘挂载首次访问未更新内容源时，刷新任务已排队却未唤醒桌面后台、需要打开 Web「浏览内容」才继续的问题。桌面宿主在持久任务写入成功后统一通知后台，移除对 HTTP 入口的调度依赖；分页刷新也让其他实例获得执行机会，不增加平台请求并发。 [后台刷新设计](architecture/refresh-performance.md)。

## dev.17 WebDAV 连接设置

WebDAV 支持自定义用户名和密码，保存后立即生效、重启保留；连接页提供明文携带凭据的通用导入二维码，桌面可选择局域网地址。 [播放器连接](clients.md)。

## dev.16 Windows 托盘交互

Windows 托盘改为左键双击打开管理页，单击不打开，右键菜单保持。浏览器打开复用 GUI 辅助程序调用系统 URL 处理程序，移除中间 PowerShell，覆盖启动器、托盘和手机入口。 [托盘交互](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/tray-interaction.md)。

## dev.15 挂载名称

挂载默认显示 MusicFS，添加时可自定义，已有项可在更多菜单重命名。保存已挂载项会正常重挂，保留 ID、来源和缓存；旧项重新挂载后采用新卷标。自动挂载仍在后台执行，管理页与托盘先可用。 [挂载名称与启动](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/mount-names.md)。

## dev.14 桌面常驻与管理登录

新增托盘入口、登录自启、分开的手动/自启打开页面选项、全局与逐项自动挂载和有限后台重试。管理页支持账号密码、记住登录与退出；桌面自动进入，手机通过短期二维码进入，局域网由用户在设置手动开启并即时生效。 [桌面访问核对](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/desktop-access.md)。

## dev.13 界面与目录整理

包含来源添加与登录流程、插件安装、播放器连接和目录浏览的界面重构，以及新的目录整理工作区。支持批量添加、原位改名、拖动与明确移动、搜索、撤销和重做；自动目录可直接开始整理，统一保存后发布。 [界面走查](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/ui-redesign.md)、[目录整理记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/directory-workspace.md)。

## dev.12 应用场景性能优化

API0.1.9/schema10不变，网易云alpha.17、QQ alpha.16。包含无变化挂载状态写盘减法、桌面32MiB路径索引与紧凑保留、单曲资料等待优化，以及本轮应用场景修正：未读文件身份在资料期限内稳定、纯音频Range跳过无关共享封面、复用有效播放版本定位、关闭缓存时仍跟踪在途读取。顺序文件名和已接受的1MiB预留不变。 [局部核对](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/performance-local-2026-10-22.md)。

## dev.11 直接WebDAV共享读取缓存

API0.1.9/schema10及插件alpha.15保持。桌面直接DAV新增rclone服务端VFS稀疏缓存，默认16GiB软上限/7天，可查询实际状态、配置或清理；App本机挂载走内部直读，避免同次读取重复落盘，批量元数据路径保留。已有挂载的8GiB设置不自动更改，正常重新挂载即可采用内部路径，无需重装插件或刷新整库。 [共享读取记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/shared-read-cache.md)。

## dev.10 缓存管理与播放范围调整

API0.1.9/schema10及插件alpha.15保持。新增挂载缓存管理，可查询实际VFS模式、原生路径和占用，定向清理后正常重挂；原生统计可能滞后。初始读取块从256KiB调至1MiB，受控播放SDK/CDN调用7次降至4次，预留标签文件头小读仍无需源音频。已有挂载正常重挂即可使用新参数，无需刷新整库或重装插件。 [消费证据与限制](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/cache-consumption-2026-10-21.md)。

## dev.9 App挂载读取缓存

API0.1.9/schema10和插件alpha.15保持。App挂载启用rclone原生稀疏读取缓存，可设置容量与未访问保留时间（默认每挂载8GiB/7天）；同时限制初始预读，防止扫描文件头时预取大量音频。实际WSL/FUSE+HTTP离线对照：跨真实卸载/重挂的头尾重读0次GET，同路径同大小正常更新后读取新字节，完整65MiB顺序读取正确。挂载测试12项/111断言、三套类型及依赖边界通过。 [挂载缓存记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/cache-consumption-2026-10-21.md)。

## dev.8 缓存策略与目录自动更新

新增分层缓存配置和目录周期更新，允许保留旧快照并在后台更新。 [缓存设计](architecture/cache-policy.md)。

## dev.7 真正按需挂载更新

网易云 MP3、FLAC、M4A 使用准确预留表示，目录与 HEAD 无需逐曲补标签，首次读取才准备单个文件；发行包开始按版本归档。 [格式证据与限制](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/lazy-mount-feasibility.md)、[接线回执](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/lazy-mount-feasibility.md#dev7-正式接线与本地-worker-验证)。

## dev.6 按需文件准备更新

先发布歌曲清单，再按文件准备标签与准确描述；提供显式文件准备入口和持久后台任务。 [范围与匿名证据](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/deferred-catalogue.md)。

## dev.5 性能优化更新

复用共用目录索引、已发布描述与 ETag，保存等价配置不触发重建；减少 SQL 和前台排队，QQ 复用热计划与读取路由。 [刷新性能设计](architecture/refresh-performance.md)。

## dev.4 刷新性能更新

批量取得来源详情与播放信息，复用名单和单曲准备结果；少量增删无需重新准备全部歌曲，文件修改时间不再随刷新变化。 [刷新性能设计](architecture/refresh-performance.md)。

## dev.3 完整发行记录

加入可选音乐资料补全、挂载项管理、WinFsp 安装引导和本机 HTTPS；App 支持调整并恢复 Windows 原生 WebDAV 的单文件上限。 [元数据记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/metadata-implementation.md)。

## dev.3 发行范围

当时的整套交付包含四个桌面构建目标、Worker、三个示例插件、作者包和源码。Windows 原生映射的 64MiB 读取与系统原值恢复已有实测；其他系统原生运行、免费 Worker 资源及运行时资料完整性的边界保留在[发行验收记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p4-release-artifacts.md)与[第三方资料](../third-party/README.md)中。
