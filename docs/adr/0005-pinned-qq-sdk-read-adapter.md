# QQ 插件复用固定 SDK 的原始读取能力

日期：2026-10-20。状态：已采用，适用于 QQ 开发预览 alpha.3 起，当前 alpha.10。依据：[来源职责](0001-installable-source-plugins.md)、[独立插件合同](0003-independent-plugin-interface.md)、[QQ 实测](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p2-qq-catalog.md)及[音质批量验证](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p2-qq-quality.md)。

## 问题

SDK 3.3.3 的公共 `/user/playlist` 将自建和收藏合并，并按歌单 ID 去重。合并之后无法保留“同一歌单同时属于两个集合”的角色，也不能从名称或所有者猜回类别。MusicFS 的 FR03 要求分别提供两个完整集合；只适配这个公共 HTTP 响应不能满足要求。

SDK 已有可复用的 sealed 会话解析和 Musicu 请求客户端，能注入 Fetch 和取消信号；其纯 ESM 实现在发布包内，但这些原始能力没有列入 npm 的公开子入口。复制整个 SDK、另部署服务或重写签名/加密/传输都会增加维护面。

## 决定

在 **QQ 插件的作者构建** 中生成一个仅含明确导出的入口，指向固定 3.3.3 发布包内的 ESM 文件。该入口只供插件实现使用，打包时随依赖闭包进入安装 ESM；用户安装 ZIP 时无需解析 npm 私有路径、安装依赖或编译核心。

生成入口复用 sealed resolver、实例设备派生、session Musicu 客户端、账号标识转换和 SDK 错误类型。`client.rpc` 统一处理当前实例会话、宿主 Fetch、取消、禁用额外重试及错误翻译；`collections` 请求两个原始集合，`catalog` 决定目录和分页，公开 `SourcePlugin` 合同保持不变。密码、会话、临时地址及数据库对象不跨入核心或前端。

不修改依赖源码，不注入全局 Fetch/process，不把 SDK 类型加入公开插件合同。SDK 的两份发布树分别提供 ESM 实现和类型声明；生成模块与配套 `.d.mts` 使用匹配导出，严格类型检查和实际 workerd 安装模块共同验证它们。

音质适配继续使用这条作者导出路径：复用 SDK 的文件类型映射、APE 文件存在规则与 StreamCdnSelector，并由 session Musicu 的 executeBatch 处理原生请求。公共播放 facade 只能为同一请求提供一个 mediaId，逐曲调用还会重复分发探测；插件改用明确的原生 vkey 批量，保留各曲 mediaId。平台目标/实际格式、回退、去重和出现位置在 `playback/catalog`，字节合同在 `media`，会话/传输/错误在 `client`。CDN selector 只在本次调用内存在，其 promise 不跨请求或实例共享；宿主 Fetch 负责真正的范围与取消。没有新增通用核心播放框架或另写平台加密。

## 代价与约束

alpha.8沿用同一路线复用 SDK 的 `resolver.rotate`、`refreshLoginCredential` 和 Fetch transport。插件只将该续期RPC所需的JSON POST与宿主Fetch/取消信号接线，不重写凭据刷新、加密或登录重定向。QQ/微信渠道取自实际凭据，来源的六小时提前窗口、五分钟失败间隔和原登录有效期限制由固定SDK决定。插件私有状态v2保存下一检查时间，由公开迁移合同保留v1已有账号。

SDK进程内的 in-flight/retry 表不提供跨 Worker isolate 保证；实例互斥和持久失败合并由 `sources` 的可选续期合同及SQLite/D1完成。SDK认证HTTP facade没有实例Fetch/取消注入口，alpha.10因此在插件内装配五个既有SDK登录操作及可注入的QR/device/sealed/session服务，原始平台协议和登录交换仍由SDK执行。固定SDK已安装的Axios1.20.0 Fetch adapter传递本次ctx.fetch/signal；SDK jar helpers恢复封存微信Cookie并保留重定向更新/删除，避免复制Cookie算法或改全局Fetch。workerd实测拒绝Axios默认cache模式，因此认证显式使用no-store。证据见[会话记录](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p2-session-lifecycle.md)。

alpha.9将SDK已签发凭据的本地确认作为扫码完成点；昵称可直接取凭据字段，不为它额外调用状态facade。后续内容读取处理资料错误，核心到期/CAS合同保持原样；没有复制SDK登录交换逻辑或增加新的认证步骤。

私有文件路径不是 SDK 的稳定承诺。因此依赖与 lock 固定为 3.3.3，构建入口检查版本及文件存在性，升级须显式复核导出、类型和行为。SDK 将来提供合适的公共入口时，应替换生成入口，保留插件内部职责和行为测试。

验证必须包含原始角色不合并、系统目录按身份排除、收藏与歌曲分页、截断/变化失败、实例凭据隔离、取消，以及实际打包模块的 Worker 执行。真实自建/收藏非空数据、云端限制及更大集合仍分别验收。当前自建接口返回整份集合；若报告的总数或完成标志显示截断，拒绝发布，不能把错误包装为完整空目录。这条保护不能代替尚未验证的大集合续读能力。
