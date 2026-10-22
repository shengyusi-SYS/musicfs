# MusicFS 实现与验收台账

文档整理：2026-10-23。这里索引版本证据，不另定义需求或待办。产品范围见[统一需求](../outputs/musicfs-requirements-and-technical-design.md)，执行决定见[实施计划](../outputs/musicfs-implementation-plan.md)，可复用教训见[工程经验](engineering-lessons.md)。

## 当前事实

Windows 托盘双击与无命令行浏览器入口的 dev.16 核对范围见[托盘交互](verification/tray-interaction.md)。dev.15 的默认卷标、中文自定义与管理页重命名已通过现有 VM 必要验收，见[名称与启动核对](verification/mount-names.md)。核心桌面体验沿用已验收的 dev.14，Windows自启注册命令、自动挂载和登录见[实机证据](verification/desktop-access.md)。API0.1.9、音乐库 schema10 和平台插件版本不变；Worker 管理认证使用迁移0011。macOS原生产物与免费CPU仍未验，产物身份统一见[发行页](release.md)。

dev.17 Windows 包新增 WebDAV 自定义凭据与通用导入二维码：桌面 HTTP 验证修改即时生效、旧密码失效和重启恢复；正式 Worker 本地 workerd/D1 验证跨请求保存与认证，新增迁移为 `0012.sql`；URL 测试覆盖中文、空格、冒号及 `@/#?%+`，类型检查、依赖边界与 WebUI 构建通过。二维码复用现有 Ant Design；具体播放器扫码导入和真实云端升级尚未验，本次未重复 Windows VM 验收。

dev.18 修复挂载冷目录等待：离线正式桌面装配在空队列下，内部请求原停在 `queued`、公开请求正常；最终由持久写入统一唤醒后台，两条入口均无需管理页即可完成来源入口和目标目录加载。`tests/desktop-dav-background.test.ts` 保留该对照；另复现并修复无 HTTP 的周期策略变更未重排唤醒、旧任务连续占用全部页的问题。后台、SQLite/本地 D1 分页、限流、取消、周期与重启、插件迁移的 36 项测试、类型检查与依赖边界通过。使用真实回环监听器和离线 sample，不将其记为 Windows GUI 或真实平台验收。

dev.19 的定向离线测试覆盖挂载/共享读取旧默认只迁移一次、自定义期限重启保留、两示例配置升级保留私有会话；小样本验证网易云歌曲详情跨临时扫描过期后复用。SQLite 对照已暂存页与末页，内容不变保留挂载缓存，修改条目或来源身份仍失效；周期刷新重启用例通过。三套类型、依赖边界与 WebUI 构建通过，未重复平台整库请求或 Windows VM 测试。现行默认及不同客户端的缓存归属见[缓存设计](architecture/cache-policy.md)。

dev.20 离线检查覆盖：已有快照定位默认布局、全部别名及嵌套目录，挂载只接收这些路径；两示例只改保留策略不变更内容身份，SQLite与本地D1重启后仍保留授权/缓存，并拒绝旧私有状态写入。HTTP资料更新使用持久分页任务，同一操作ID跨页保留；网易云和QQ确认新歌词可读、旧文件字节不变，共用资料在本轮只取得一次。未请求真实平台或重复Windows VM验收。API0.1.10新增可选配置身份及资料更新能力，数据库无需迁移。

dev.21 修正无变化刷新仍重建内部索引及改变缺省文件修改时间。先用正式library/SQLite复现，随后定向34项回归通过：暖索引与已计算ETag不重建，冷控制器时间一致；SQLite/本地D1覆盖分页边界改变、旧行缺少内容时间、失败后相同内容恢复、统计/检查时间推进、候选回收、空目录及来源代际变化。查询计划确认候选按attempt_id、旧条目按attempt_id/ordinal索引读取；桌面周期刷新仍正常推进且不通知挂载失效。没有真实平台、免费云端性能或Windows GUI新增结论。

| 主题 | 已有证据入口 | 适用边界 |
|---|---|---|
| 桌面常驻与管理访问 | [本轮核对](verification/desktop-access.md) | 本地会话、恢复与监听；Windows 正式包与用户协助菜单点击通过，其他目标环境边界单列 |
| 界面与使用流程重构 | [真实页面走查](verification/ui-redesign.md)、[目录整理工作区](verification/directory-workspace.md) | 独立本地服务走查；源码与界面已进入 dev.13 发行归档 |
| 局部性能优化 | [O2/O1/O3与应用场景核对](verification/performance-local-2026-10-22.md) | 正式模块、有界样本和Linux发行冒烟；未重测Windows或真实整库 |
| 冷刷新与 SDK 请求减法 | [真实冷基线](verification/real-netease-cold-dev5.md)、[请求减法](verification/netease-cold-request-reduction.md)、[两阶段清单](verification/deferred-catalogue.md) | 完整清单、全库标签和全库入库是不同工作范围 |
| 真正按需挂载与格式 | [Windows / WSL 可行性及生产接线](verification/lazy-mount-feasibility.md) | MP3/FLAC/M4A 的具体预留方案；APE 与容器/播放器限制分别记录 |
| 挂载缓存与播放成本 | [dev.9—dev.10 消费记录](verification/cache-consumption-2026-10-21.md) | WSL/FUSE、有效生成音频、Windows Shell/FileStream；非真实整库 GUI 计时 |
| 直接 DAV 共享读取 | [dev.11 验证](verification/shared-read-cache.md) | 相同范围、重启、清理、更新身份与本机挂载绕过；未重跑平台或云端 |
| 大目录索引保留预算 | [场景复评](../outputs/musicfs-performance-review.md#有界核对与证据等级)、[匿名结果](verification/data/published-view-budget-2026-10-22.json) | 正式Module与合成条目，证明超预算大项不保留；不是实际用户目录、SQL或GUI计时 |
| 补标签 | [原文件标签检查](verification/metadata-current-file-tags.md)、[格式可行性](verification/metadata-tagging-feasibility.md)、[实现](verification/metadata-implementation.md) | 工具格式支持与真实来源样本覆盖分别说明 |
| 桌面与 Windows 连接 | [桌面](verification/p2-desktop-host.md)、[Windows](verification/p2-windows-mount.md) | 实际 WinFsp、本机 HTTPS、跨原生上限读取/恢复已有记录；不等于全部 GUI/恢复通过 |
| 云端部署、升级与有限来源 | [真实 Worker](verification/p4-worker-cloud.md) | 已用付费账号；不代替免费 CPU/配额证据 |
| 原始交付与作者接入 | [发行验证](verification/p4-release-artifacts.md) | 各检查点归档、源码/插件身份、仓库外构建；最新归档以发行页为准 |

## 当前有限剩余清单

这些是明确保留的证据边界，不自动成为新一轮测试任务。用户跳过的范围不记为通过，也不持续阻塞已完成的开发预览发行。

| 范围 | 仍未覆盖的结论 |
|---|---|
| 真实性能 | 最新方案下真实数千首的整库 GUI 扫描/再次进入总耗时；不能由单曲回环样本推定 |
| 免费 Worker | 真实免费环境大目录 CPU、资源和最终体验；本地 workerd 与付费账号均不能替代 |
| 来源会话 | QQ 适用真实自然续期窗口；退出后新扫码与本地机制已有证据，不重复要求重登 |
| 目标系统 | macOS 原生运行、原生 Linux 图形入口，以及未覆盖的 Windows GUI、忙路径/异常恢复等；按主题记录，不展开全排列 |
| 发行材料 | 历史运行时资料仍保留未核实范围；不继续把上游源码重建或完整依赖闭包扩成产品开发任务 |

## 需求覆盖

以下保留原开发预览 FR01—FR25 基线，其数字、产物与系统边界属于对应检查点。后续元数据、按需挂载和缓存能力以上述主题记录补充；不能将基线的旧“待验”或旧包身份当成当前交付，也不能反向把新功能的单项证据升级为整行全平台通过。


编号和名称来自统一需求；具体行为以该文档为准。“已实现”与“部分通过”可以并存，避免把缺云账号/原生环境误计为缺实现。每行只承担本合同的缺口：最终资料/归档归FR16，免费预算/切换影响归FR25，原生挂载归FR10—12。FR15磁盘不足错误映射已实现并经正式边界验证；目标OS实际提示本次跳过／未验证。

| 需求 | 功能 | 实现 | 验证 | 代码/产物/证据与剩余缺口 |
|---|---|---|---|---|
| FR01 | WebUI 认证 | 已实现 | 通过 | 通用输入及QQ/微信、网易云真实扫码通过；[两示例本地/真云退出后新扫码](verification/p2-session-lifecycle.md#双示例真实退出与重新扫码)均完成并恢复5个内容入口，本地从失效提示直达重新授权；不另找登录渠道，不冒充平台自然到期 |
| FR02 | 会话保存 | 已实现 | 部分通过 | SQLite/D1交互步骤/重启、按需续期合并与失败保存已验；QQ实际包受控SDK轮换和两实例v1→v2保留账号通过；两示例凭据就绪即完成、资料故障独立重试已验；两示例本地/真云真实退出重登后保存及后续根读取通过，配置/布局保留；QQ适用真实续期本次跳过／未验证；网易云二维码Cookie不支持login/refresh |
| FR03 | 示例歌单分类 | 已实现 | 通过 | QQ角色/收藏分页/同ID双角色及完整性回归通过，微信非空自建及owner内容已验；网易云桌面service与本地workerd/D1自建23/收藏26完整；真实Worker两示例自建/收藏分别1/0和23/26，均1页完整发布。QQ空收藏符合账号实际，不要求制造非空集合 |
| FR04 | 示例喜欢的音乐 | 已实现 | 通过 | QQ真云喜欢完整1曲/0文件，曲目/文件分开；网易云完整喜欢沿用既有真实42页及D1分页证据，真云分类/推荐歌单覆盖相同定位/曲目路径，不冒充本轮云端重刷42页。大目录免费资源仅归FR25 |
| FR05 | 示例发现 | 已实现 | 通过 | QQ本地每日/推荐25张及102曲歌单、网易云本地/workerd推荐7张及35曲/66文件通过；两示例真云每日各30曲、推荐25/7张列表完整，真云网易云35曲歌单已发布。不展开其余推荐歌单 |
| FR06 | 内容与顺序 | 已实现 | 通过 | 共同分页、空中间页、顺序/重复位置和截断拒绝回归，真实42页、QQ102曲与有限云端内容已覆盖实际路径；不按宿主重造同名/重复歌曲样本 |
| FR07 | 音频读取 | 已实现 | 通过 | 双宿主已知字节的流式/HEAD/206/416/取消/忽略Range及真实来源MP3/M4A/FLAC证据齐全；真云两路代表HEAD/Range、QQ全文/挂载偏移和OpenList/mpv定位通过。其他OS启动/挂载归FR10—12/16，不重复字节合同 |
| FR08 | 示例音质模式 | 已实现 | 通过 | 单/多模式、Schema表单与实例隔离已有本地/workerd真实证据；真云单M4A/单标准已验，现多目标QQ导出128k/M4A两个文件，网易云33个曲序各极高/标准两个文件，实际标签/扩展名及代表HEAD/Range通过 |
| FR09 | WebDAV 与 OpenList | 已实现 | 通过 | 双宿主共用DAV、rclone真实完整/范围、Linux双来源MP3/M4A/FLAC的OpenList/mpv播放与双向seek已验；真云HTTPS挂载及代表OpenList/mpv定位通过。WSL Pulse限制和实际延迟保留；其他OS原生挂载仅归FR10—12/16 |
| FR10 | 一键挂载 | 已实现 | 部分通过 | 正式启动器/页面/随包rclone已接线，Linux发行物真实FUSE全文/偏移读取通过；Windows VM正式程序/sample与实际WinFsp盘符读取已有[证据](verification/p2-windows-mount.md)，Windows默认图形启动和托盘另见[dev.14续验](verification/desktop-access.md#windows-vm-续验)，macOS及原生Linux图形启动仍未验证 |
| FR11 | 挂载管理 | 已实现 | 部分通过 | 并发合并/端口恢复回归通过；Linux实际就绪/忙时保留/关闭句柄后退出及两种活动恢复通过；Windows VM本机挂载、真实读取、正常卸载与dev.14启动自动恢复已验；Windows忙路径/异常恢复与其他OS仍未验证 |
| FR12 | 远程挂载 | 已实现 | 部分通过 | Linux页面连接独立HTTP服务并FUSE读取真实网易云MP3全文/前后偏移通过；WSL现成发行物经正式API/随包rclone挂载真实云端HTTPS DAV，QQ M4A头/尾/中定位与全文一致、正常卸载退出；其他系统本次跳过／未验证 |
| FR13 | 刷新与失败 | 已实现 | 通过 | [实例/单目录刷新](verification/p1-instance-refresh.md)、失败保留/过期状态、取消/代际和实例隔离通过；workerd/D1、浏览器真实刷新、[42页恢复](verification/p2-durable-refresh.md)及真云每日/分类发布已验；目录独立失败持久展示、重建后保留、成功才清除通过。云CPU/免费预算仅归FR25，不重做交错全排列 |
| FR14 | 基本访问控制 | 已实现 | 通过 | 独立读取/管理凭据、配置/认证私有状态过滤及越权拒绝通过；正式桌面生成/恢复凭据已有证据；真实Worker读取凭据被管理入口拒绝，Secrets在插件发布后保留 |
| FR15 | 状态诊断 | 已实现 | 部分通过 | 插件缺失/不兼容、需认证、限流/网络/部署失败已有错误链路；通用字段错误、步骤、计数及成功时间已有页面；磁盘不足经RC/私有JSON返回disk_full，受控RC→正式HTTP及busy/缺依赖分类已验；目标OS实际提示本次跳过／未验证 |
| FR16 | 发布 | 已交付 | 部分通过 | 本次开发预览发行收口完成：4b72505统一七ZIP/三个插件，11项校验及实际归档说明/许可/身份检查通过；四桌面程序及Worker核心不变，沿用已有运行结果。其他原生系统跳过，运行时材料complete:false及未核实范围保留，不声称原始完整验收全部通过 |
| FR17 | 拖拽目录布局 | 已实现 | 通过 | 草稿/添加源/命名/保存、浏览器实际拖拽、修订冲突/重启及刷新不覆盖布局已验；真云插件发布后保留布局/继续读取，新增分类组保留原4组已核对，不追加状态交错全排列 |
| FR18 | 示例音质缺失策略 | 已实现 | 通过 | 两示例单版本隐藏、本地真实回退及实际引用/试听排除/错误不回退回归已验；真云QQ hidden29/fallback1/dedup1，网易云hidden2/fallback66/dedup33，实际标签无目标音质误标，同曲序多版本/合并符合合同 |
| FR19 | 安装与更新插件 | 已实现 | 通过 | WebUI上传/发布地址安装及主动更新已验；[结构升级](verification/p2-plugin-migration.md)整体激活/失败保留、正式桌面重启/本地Worker接棒通过；浏览器URL生命周期和真实云端sample安装/更新/失败保留、双示例ZIP自行发布后认证/读取已验。最终发行仅归FR16，免费/切换归FR25 |
| FR20 | 多个来源实例 | 已实现 | 通过 | SQLite/workerd-D1的配置、认证/缓存/内容隔离、重启及浏览器已验；两个真实QQ/微信实例不同配置/授权/内容见[记录](verification/p2-qq-quality.md)；真实Worker sample及独立作者双实例通过。共用隔离机制不追加真云同平台多账号全矩阵 |
| FR21 | 插件配置与认证界面 | 已实现 | 通过 | RJSF配置/认证输入、字段校验、二维码/链接/验证码通用承载有回归；无认证独立插件不需专用页面；QQ/微信与网易云真实二维码及双示例Worker内置浏览器扫码通过。失效重登归FR01/02，不要求额外登录渠道 |
| FR22 | 插件兼容 | 已实现 | 通过 | 安装前API/宿主兼容预览、清单/版本拒绝及缺失运行修订拒绝通过；API0.1.4迁移及0.1.5可选续期已验；公开作者包/源码已交付；真实Worker作者包检查兼容并安装后读取通过，拒绝行为复用本地合同/界面证据 |
| FR23 | 移除与恢复 | 已实现 | 通过 | 后台回归、本地浏览器和真实Worker均已验证移除标记缺失/禁读、保留配置/布局、兼容重装恢复及独立删除；旧写拒绝有共同SQL回归。部署在途影响归FR25，历史模块物理回收不作为本需求门禁 |
| FR24 | 公开插件合同 | 已实现 | 通过 | 当前API0.1.5的公开类型/合同/作者指南与独立作者包已交付；仓库外锁定构建/类型检查、现成Linux安装/双实例及真实Worker自行安装/双实例/字节读取通过，核心和WebUI无需重编译；自有代码GPL-3.0-only及源码已交付 |
| FR25 | Worker 自动部署 | 已实现 | 部分通过 | 真云自动安装/更新/一次失败保留/移除重装、绑定/状态保留及核心升级已验；响应丢失恢复沿用D1+SDK。正式sample归位时页面200，合成文件短暂503/Retry-After:2后恢复200，实际切换已记录。免费环境/大目录资源本次跳过／未验证 |

## 验证记录

| 领域 | 详细记录 |
|---|---|
| 插件与协议基础 | [插件基础](verification/p0-plugin-foundation.md)、[目录/DAV](verification/p0-library-dav.md) |
| 页面与认证 | [首轮 WebUI](verification/p1-webui.md)、[交互认证](verification/p1-authentication.md)、[本地 UX](verification/p3-local-ux.md) |
| 来源与音质 | [QQ 首链路](verification/p1-qq-source.md)、[QQ 分类](verification/p2-qq-catalog.md)、[QQ 音质](verification/p2-qq-quality.md)、[网易云](verification/p2-netease-source.md) |
| 刷新与描述 | [实例刷新](verification/p1-instance-refresh.md)、[持久分页](verification/p2-durable-refresh.md)、[批量描述](verification/p2-listing-metadata.md)、[读取 CPU](verification/p2-read-cpu.md) |
| 生命周期与客户端 | [插件迁移](verification/p2-plugin-migration.md)、[来源会话](verification/p2-session-lifecycle.md)、[OpenList / mpv](verification/p2-clients.md) |

## 记录规则

- 区分已实现、实测通过、部分通过、失败、环境待验及用户跳过；不以构建或测试数量推导全局完成百分比。
- 记录实际版本/构建输入、环境、入口、预期/结果与未覆盖范围；凭据和私有媒体地址不进入证据。
- 一项需求只承担自身缺口，免费资源、原生挂载和发行资料不复制成全部功能的共同待办。
- 没有相关代码变化或新失败时复用已有结果；选择能改变决定的样本，不展开真实平台压力或理论故障矩阵。
- 设计与经验只链接证据；本台账保留索引与必要状态，不重复逐轮运行日志。
