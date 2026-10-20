# 来源会话续期与失效判断

日期：2026-10-20。环境：Linux x86_64、Bun1.4.3、Nodev24.19.0、本地 workerd/D1。公开合同0.1.5-dev.0、数据库schema7、QQ alpha.8/私有状态v2、网易云alpha.6/私有状态v1。真实平台自然续期、完整失效重登、云端和其他目标系统仍分别待验。

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
- confirmed凭据的插件内部恢复已有回归，但宿主公开waiting步骤本身仍有到期合同；跨旧QR期限的端到端恢复不能只据插件单测宣称通过。
- QQ扫码/状态的SDK HTTP facade仍未完全传递底层取消。现有续期、原始内容、推荐、音质和媒体Fetch接线不代表全部认证取消已验。
- 本地workerd不证明真实Cloudflare传播、状态/绑定保留、免费CPU/出口或在途流切换。用户暂时没有Cloudflare账号，继续本地CPU与其他可执行交付；不降低最终验收范围。

本轮没有增加依赖、全局并发队列、ORM、事件总线或通用认证工作流。WebCrypto/原生AbortSignal、现有SDK和tough-cookie处理通用/平台机制，实例代际和条件保存仍是MusicFS自己的业务责任。
