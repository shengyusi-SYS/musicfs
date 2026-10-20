# 来源会话续期与失效判断

日期：2026-10-20。环境：Linux x86_64、Bun1.4.3、Nodev24.19.0、本地 workerd/D1。公开合同0.1.5-dev.0、数据库schema7；首检查点为QQ alpha.8/网易云alpha.6，随后认证边界收敛为alpha.9/alpha.7，私有状态版本仍为2/1。真实平台自然续期、完整失效重登、云端和其他目标系统仍分别待验。

## 实现与职责

来源有效期、登录渠道、重试间隔和无效凭据判断属于插件。核心只提供可选 `renewal.needed/renew`：先纯本地判断，必要时按实例协调一次续期，保存后才执行普通内容读取。没有能力的来源不必增加认证概念，也不增加定时登录。

- [sources/renewal](../../src/core/sources/renewal.ts)拥有等待、取消和协调次序；普通内容操作及音频流不持租约。配置检查与交互认证使用原入口。
- [共同SQL计划](../../src/infrastructure/persistence/renewal-sql.ts)由SQLite事务/D1 batch执行。领取时预留状态修订，普通保存拒绝占用有效续期修订；完成时保存可选状态、短期公开失败和重试时间并释放。其他控制器复用结果，新实例/插件代际阻止旧结果写回。
- QQ复用固定SDK3.3.3的sealed resolver、rotate、refreshLoginCredential与Fetch transport；六小时窗口、五分钟间隔和原登录30天限制不在核心复制。续期JSON POST适配传递宿主Fetch/信号，新的 `renewAfter` 在插件状态v2保存；v1通过已有整体迁移激活保留账号。
- 网易云继续由tough-cookie处理有效期和同次调用Cookie更新。缺失/过期MUSIC_U、明确未登录或profile:null要求重登；畸形账号资料/临时故障保留会话。已收到Cookie即使随后业务失败仍提出保存。

固定[网易云4.32.0随包文档](https://unpkg.com/NeteaseCloudMusicApi@4.32.0/public/docs/home.md)“刷新登录”段明确login/refresh不支持二维码登录Cookie。当前只有扫码登录，因此不增加无效刷新或另一套登录方式。SDK源码有该端点不等于当前会话适用。

## 自动化与实际包证据

```sh
bun run check
bun run probe:worker:qq
bun run probe:worker:service
bun scripts/build-desktop.ts --target linux-x64 --skip-web
bun scripts/probe-desktop-product.ts
bun run build:worker dist/plugins/org.musicfs.sample.zip dist/plugins/org.musicfs.qq.zip dist/netease/org.musicfs.netease.zip
```

完整检查为 **209 pass、0 fail、2,489次断言**；三组TypeScript与 **151模块/527依赖**边界通过。QQ探针扩充后又通过三组类型与边界检查；未修改页面，不重复页面构建和已通过的所有媒体/挂载矩阵。

| 范围 | 证据 |
|---|---|
| 核心协调 | 6项SQLite整合测试，两个独立sources控制器；按需判断、内容并发、一次续期、旧完整状态隔离、成功凭据不随业务失败丢失、失败合并、等待者取消及配置代际变化 |
| 持久化 | 同一行为在SQLite/真实本地D1各5项；状态修订预留、租约到期接管、短期失败跨控制器保存、新代际、实例隔离；历史schema1—6迁至7并重开保留 |
| QQ插件 | 新增9项受控SDK测试；QQ/微信真实登录类型、密文轮换后恢复、临时失败保留旧令牌与检查间隔、失效清理/保留独立挑战、插件内部confirmed恢复及实际Fetch取消 |
| 网易云插件 | 当前20项，新增会话到期/明确失效、临时资料保留、正常及后续失败响应的Cookie保存回归；真实SDK回调/加密和受控传输 |
| 实际QQ安装包 | 无Node兼容开关的本地workerd/D1执行打包ESM和SDK；两个HTTP控制器只发1次受控Login续期RPC，新密文在Bun SDK恢复到新凭据，状态修订+2/实例代际不变；再次请求无额外续期 |
| 正式Worker入口 | schema7下页面/API/DAV、D1重启保留、缺发布凭据诊断及坏插件初始化拒绝通过；不是云部署 |
| Linux发行物 | 正式二进制的分离后台、共用页面、sample外置安装、16,044字节HEAD、RIFF范围、重复启动复用、挂载入口与正常退出通过；本轮未重复FUSE |

Linux二进制SHA-256：`9b26c94bd9e70e8bdac62ac46116512083ad9919f83b24d1531d77a389cb0f0d`。最终Worker构建含三个插件、18个模块、共用页面和七份迁移。其他桌面目标仍是之前构建检查点，不据此声称原生运行通过。

## 已有开发实例的正式更新

先停止8787服务并保留私有SQLite备份，再由新服务启动迁移schema6→7。4条安装、6个实例和布局的逐行摘要与迁移前相同；备份与原始数据不进入Git。

随后通过正式HTTP安装入口更新网易云alpha.6，返回201；QQ alpha.8返回202，后台完成两实例的v1→v2整体迁移。账号密钥、密文、账号名和挑战原字段均保留，ID/名称/布局不变；缺省audio配置按既有插件规则补为单版本128k/隐藏，已有配置值不丢失。实例代际和状态修订按迁移合同各+1。

两份QQ密文经固定SDK本地恢复有效，剩余约67/68小时，未进入六小时续期窗口，未人为改时钟或强行续期。两个QQ实例及一个网易云实例各只准备根入口：首次503携带原冷准备操作，后续200/5个入口；不重复整份4,158曲目录。该结果证明当前包的既有真实账号恢复，不能算自然续期成功。

## 保留的缺口与下一步

- 真实QQ/微信自然续期、最终失效重登，以及网易云真实自然到期后的重登尚未验。普通业务失效可返回needs_auth；共用认证历史步骤与当前会话状态的完整诊断仍需收口。
- 早先confirmed/资料补全边界已按下节收敛。宿主仍按原期限拒绝扫码本身过期后的迟到结果；没有新增无限期补登录或放宽旧操作规则。
- 此检查点的QQ扫码/状态facade仍有取消缺口；后续alpha.10已按文末收口，不把早先续期证据冒认为当时已经完成。
- 本地workerd不证明真实Cloudflare传播、状态/绑定保留、免费CPU/出口或在途流切换。用户暂时没有Cloudflare账号，继续本地CPU与其他可执行交付；不降低最终验收范围。

本轮没有增加依赖、全局并发队列、ORM、事件总线或通用认证工作流。WebCrypto/原生AbortSignal、现有SDK和tough-cookie处理通用/平台机制，实例代际和条件保存仍是MusicFS自己的业务责任。

## 后续收敛：凭据保存即完成授权

整合复核发现：直接插件测试可恢复confirmed凭据，但Sources在调用前/后都检查旧waiting期限；如果账号资料请求暂时失败并跨过二维码期限，正式操作仍会结束。这个既有缺口来自把凭据获取和资料读取放在同一扫码完成步骤，继续挪动插件分支不能修复宿主旅程。

QQ alpha.9在SDK签发后本地解析有效密文，立即返回现有complete；昵称只取新凭据可用字段，缺失就清旧账号名。网易云alpha.7以有效MUSIC_U完成扫码，清旧UID/昵称；根读取或个人歌单首次需要UID时查询并保存，daily/stat/open不因此增加资料请求。明确失效时通过tough-cookie删除MUSIC_U，保留设备Cookie及另行进行的挑战。既有数据结构允许身份暂缺，不增加schema迁移、核心认证阶段或新依赖。

`tests/source-authentication-completion.test.ts`分别经正式管理API和Sources验证两插件：临近旧QR期限仍可在资料不可用时完成，超过旧期限后GET仍为complete；随后根读取临时失败不丢凭据，资料恢复后读取成功且只消费过一次QR。网易云个人集合按新取得UID分类；插件回归还覆盖换号不会继承旧UID/名称、明确失效后不能继续用旧Cookie。扫码上游本身迟到的原核心回归保持通过，不将该保护与资料补全混淆。

最新完整检查为 **212 pass、0 fail、2,546次断言**，三组类型及 **152模块/541依赖**边界通过。实际QQ安装包在无Node兼容开关的本地workerd/D1中，通过正式认证POST恢复已确认的SDK密文、完成公开步骤并清挑战；不额外消费QR，也没有真实扫码/云端声明。探针起初使用非UUID操作ID得到400，改用正式UUID后通过，未放宽产品接口。

代码冻结后重建Linux与三插件Worker产物；Linux核心二进制摘要与本记录前述值相同，发行目录带alpha.9/alpha.7新ZIP。8787开发服务通过正式兼容安装均返回201，安装前后的全部实例行（含私有状态）和布局相同；两个QQ和一个网易云账号根入口恢复200/5项。不重复自然续期、扫码或完整媒体矩阵。

此认证完成切片不修改核心或页面，继续使用既有可选accountName。当时后续安排为读取CPU与独立推进QQ取消；当前状态以文末和总台账为准。

## 后续收口：QQ alpha.10认证底层取消

固定SDK3.3.3的公共HTTP入口没有请求Fetch/信号注入口，因此`upstream.ts`只装配五个SDK登录操作、原有QR/device/session/sealed助手。SDK的AuthHttpClient继续处理Cookie和重定向，固定SDK已安装的Axios1.20.0 Fetch adapter绑定本次ctx.fetch/AbortSignal；恢复微信封存Cookie时使用SDK jar helpers维护保留、替换和删除。没有改全局Fetch、复制平台签名/加密、另部署API服务或增加依赖。公开插件合同和数据库schema不变。

新增五项真实SDK路径测试：预取消零请求、设备bootstrap在途中止、QQ和微信驱动在途轮询取消、目录账号状态取消且不清凭据、微信封存Cookie经重定向更新/删除及多个Set-Cookie。取消调用不返回可保存状态候选。完整检查为**221 pass/0 fail、2,644断言**，三组类型及**155模块/559依赖**边界通过；最终局部修正后再次通过这五项/30断言及三组类型。

整包本地workerd首次失败在进入宿主Fetch之前。直接构造Request复现`cache: default`抛`Unsupported cache mode: default`，`no-store`通过；Axios默认值因此显式改为认证不缓存的no-store。修正后实际安装ESM在**没有Node兼容开关**的workerd通过bootstrap Fetch取消、无状态候选、D1合并续期和正式管理认证完成。没有用Promise.race替代底层取消。

Bun实际包完成QQ/微信真实二维码创建、未扫码轮询和取消（分别4/6次请求）；开启`MUSICFS_QQ_LIVE_QR_PROBE=1`后，最终包又经本地workerd的正式管理API完成两个渠道的相同旅程。不输出二维码、密文或平台URL，本轮没有请求人重新扫码，不能据此声称新一次人工确认/凭据交换或真实Cloudflare已验。

隔离真实会话实例从alpha.9更新到alpha.10，实例ID/配置保留，真实账号根状态和M4A小目录仍可用，经OpenList/mpv的结果见[客户端记录](p2-clients.md)。自有代码许可按用户决定改为GPL-3.0-only；sample0.1.3、QQalpha.10、网易云alpha.8均保留第三方原许可。真实自然续期/失效重登及云端继续待验。

原8787开发服务通过正式安装入口更新三个包均返回201，安装前后全部6个实例行（含私有状态）及1份布局的摘要一致。随后两个QQ/微信实例及一个网易云实例各自根入口恢复200/5项；没有重跑完整歌曲集合或重新扫码。
