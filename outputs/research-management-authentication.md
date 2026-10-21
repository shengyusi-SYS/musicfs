# 管理页面登录：依赖调查与取舍

日期：2026-10-22。范围仅为 MusicFS 管理 WebUI 登录；不涉及音乐平台授权、DAV Basic 凭据或启动器身份探测。本轮只研究与澄清，未安装依赖、修改产品代码或连接云端/VM。

## 已确认的用户效果

- 单管理员，无第三方登录、多用户或邮件功能需求。
- 提供账号密码、记住登录；桌面启动自动进入；手机扫码进入。
- 首次桌面直接进入，账号密码按需在设置创建；手机扫码不要求先设密码。
- 云端首次使用现有部署凭据进入，再设置账号。
- 手机访问需用户先在设置开启局域网；当前允许 HTTP/IP，不以新增 HTTPS、Passkey 或 OAuth 服务作为本轮前提。

## 两条可行路线

| | Better Auth 完整认证 | Hono 会话组件 + 单管理员应用模块 |
| --- | --- | --- |
| 实际成熟能力 | 密码存储/校验、账号操作、记住登录、数据库会话、退出与撤销；官方 Hono/Bun SQLite 接入。 | `hono/cookie`、`@hono/session` 或 `hono-sessions` 处理 Cookie/会话格式与期限；它们**不提供**完整账号密码系统。 |
| 数据/依赖成本 | 常规密码模式包含 user、account、session、verification 等模型；username 插件仍以 email/password 模型为底。可不提供注册/邮件界面，但内部模型仍存在。 | 可以只有单管理员凭据与必要会话记录，不强加 email/account 模型；密码校验、设置、登录、退出及扫码交换由 MusicFS 应用模块负责，不能当成“库已经包办”。 |
| 双宿主适配 | 官方支持 `bun:sqlite`；固定版本源码识别 D1 binding，不必因为示例用了 Drizzle/Neon 就加整套 ORM/数据库。现有 `openSqlite` 只返回窄领域 store，仍要由桌面宿主组合独立认证 adapter；不能直接塞入现有 store。 | Hono Cookie helper 已在依赖内；会话库使用 WebCrypto。`hono-sessions` 作者明确测试 Bun/Workers，并提供 Bun SQLite store；D1 adapter 需核实/补薄实现。`@hono/session` 的当前 Storage 写/删接口未 await，不宜直接接异步 D1。 |
| 桌面/手机免密码进入 | 普通密码登录不覆盖这两个入口，需要新增本机凭据→浏览器会话、二维码→手机会话的桥接。OTT 插件可复用一次性凭据，但不能据文档就说它会新建独立手机会话。 | 同样需要两种桥接；可以直接汇入同一个会话签发接口。应用自有逻辑更多，但与实际单管理员流程贴合。 |
| 估算与 ROI | 约 3—5 人日完成双宿主认证与现有入口整合，再加最终 Worker 密码 CPU 验证。维护收益在于不用自行维护完整密码/会话行为；单管理员免密码入口仍需做。 | 约 2—4 人日，初始模型更少；长期须维护自己组合的账号与会话应用逻辑。节省几张表不能单独证明更划算。 |

以上为基于仓库接缝的工程估算，不是运行测量。没有必要同时接两套认证体系。

## 第一方核查结果

**Better Auth 当前稳定版为 1.7.12，MIT。** 1.8 文档标记为 beta，不将 beta 能力算入本轮可用承诺。它的 Hono handler 可直接挂接 Web `Request/Response`；Bun SQLite 是官方示例；1.7.12 的 Kysely dialect 源码有 D1 识别和接入。库内部使用 Kysely，不等于 MusicFS 来源/目录核心需要迁移 ORM。[正式发布](https://github.com/better-auth/better-auth/releases)、[版本与许可](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.12/packages/better-auth/package.json)、[Hono 接入](https://better-auth.com/docs/integrations/hono)、[Bun SQLite](https://better-auth.com/docs/adapters/sqlite)、[固定版本 dialect](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.12/packages/kysely-adapter/src/dialect.ts)

账号密码、`rememberMe`、退出、会话过期/更新和撤销属于现成功能。可以关闭公开注册，不要求接邮件发送服务；但 username 插件的标准创建接口仍要求 email/name，不能描述为原生“只有用户名/密码且完全无 email 模型”。若采用它，需要明确内部管理员标识映射，界面无需增加用户没有要求的邮箱字段。[密码认证](https://better-auth.com/docs/authentication/email-password)、[username 插件](https://better-auth.com/docs/plugins/username)、[核心表](https://better-auth.com/docs/concepts/database)、[会话](https://better-auth.com/docs/concepts/session-management)

**免费 Worker 的密码成本是两条路线共同问题。** 当前 HTTP CPU 额度为每次 10ms；PBKDF2/node:crypto API 可调用并不证明指定参数的密码验证在这个额度内。Better Auth 的历史 issue #8860 针对 1.4.18 的 JS scrypt，已被 2026-04-01 合并的 #8685 关闭；1.7.12 源码已委托 `@better-auth/utils/password`，node 条件选择原生 scrypt，其他环境回退 JS。因此不能宣称当前版必然失败，也不能宣称已保证免费可用。最终 Wrangler 产物选择哪条路径、一次登录的实际 CPU 仍未测量；会话请求无需每次重新计算密码哈希。[Worker 限制](https://developers.cloudflare.com/workers/platform/limits/)、[WebCrypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[node:crypto 支持](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)、[历史问题](https://github.com/better-auth/better-auth/issues/8860)、[合并修复](https://github.com/better-auth/better-auth/pull/8685)、[1.7.12 密码源码](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.12/packages/better-auth/src/crypto/password.ts)

**HTTP/IP 不强制排除 Cookie 登录。** Better Auth 支持配置 Cookie 属性和多个允许来源；桌面本机地址、LAN IP 和随机端口需要由宿主提供真实可用来源，HTTP 设置不能误套生产 HTTPS 的 Secure Cookie 默认值。保持 WebUI/API 同源即可，无需引入跨域登录服务。手机浏览器访问 LAN IP 与电脑访问 127.0.0.1 是不同 Cookie 主机，所以扫码要在手机目标地址完成会话签发，不能期望桌面 Cookie 自动共享。[Cookie 配置](https://better-auth.com/docs/concepts/cookies)、[baseURL 配置](https://better-auth.com/docs/reference/options)、[Hono Cookie helper](https://hono.dev/docs/helpers/cookie)

**OTT 并非已核实的独立手机会话签发器。** 官方文档说从当前会话生成默认 3 分钟的一次性 token，verify 返回关联 session；文档不足以证明它给手机设置 Cookie、创建独立 session 或具备独立退出语义。本轮未成功取得其固定版本实现，暂只把它视为一次性凭据候选。二维码显示可继续用已有 Ant Design；“新手机会话”仍需清楚的宿主整合。Device Authorization 插件面向 CLI/电视等设备授权，有额外发码/确认/轮询流程，不符合当前手机扫码直接进入的简化目标。[OTT 文档](https://better-auth.com/docs/plugins/one-time-token)、[设备授权文档](https://better-auth.com/docs/plugins/device-authorization)

**轻量会话方案的真实边界：**

- `@hono/session 0.2.1`，MIT，位于 honojs/middleware，依赖 jose 6，提供加密 JWE Cookie 与期限/刷新。它比较新；密码、账号、配对不在其功能内。当前 Storage.get 允许 Promise，但 set/delete 未 await，不能把 D1 存储包装成同步接口后就算完成适配。[README](https://raw.githubusercontent.com/honojs/middleware/main/packages/session/README.md)、[包信息](https://raw.githubusercontent.com/honojs/middleware/main/packages/session/package.json)、[Storage 接口](https://raw.githubusercontent.com/honojs/middleware/main/packages/session/src/index.ts)、[写入实现](https://raw.githubusercontent.com/honojs/middleware/main/packages/session/src/session.ts)
- `hono-sessions 0.8.1`，MIT，作者说明测试 Bun/Workers，提供 CookieStore、MemoryStore、BunSqliteStore、失活期限与自定义存储。没有本次已核实的内置 D1 adapter；CookieStore 无服务端逐会话撤销能力，不能把删除当前 Cookie 当作撤销所有副本。[作者仓库](https://github.com/jcs224/hono_sessions)、[正式包元数据](https://www.npmjs.com/package/hono-sessions?activeTab=code)
- Hono 自带 Cookie helper 已支持 HMAC 签名，无需自行实现 Cookie 编解码。若选择轻量路线，应复用这些现成部件，明确哪些账号/会话逻辑仍由 MusicFS 承担。[官方 helper](https://hono.dev/docs/helpers/cookie)

Auth.js 没有成为第三条推荐：虽然有 Hono 接入和 D1 adapter，但 Credentials provider 明确不替应用保存账号密码，仍要自己实现验证/持久化，未比前两条更贴合本轮需求；其 D1 adapter 也有 users/accounts/sessions/verification_tokens 四表。没有 SSO 要求，不因它支持很多 OAuth provider 而新增这套体系。[Credentials](https://authjs.dev/getting-started/authentication/credentials)、[D1 adapter](https://authjs.dev/getting-started/adapters/d1)、[Hono 接入](https://hono.dev/examples/hono-authjs)

## 推荐与有限未决

**优先考虑 Better Auth 1.7.12 的最小配置**，理由是已经确定需要密码、记住登录和设备会话，现有完整实现的维护收益比自行组合更明确。接受其认证专用表，单独留在管理认证模块；不增加公开注册、邮箱设置、组织/角色或第三方服务。使用它不代表其它核心模块跟着更换数据库抽象。

落定前只需解决三项实际接缝：

1. Worker 最终构建的密码路径与免费 CPU 是否可用；本轮未运行验证，不先降低哈希成本或加外部服务。
2. 桌面自动进入与二维码如何签发正确主机下的独立 Cookie 会话；OTT 的完整效果尚未证实，不把“返回 session”当实现完成。
3. 现有部署凭据/桌面凭据作为首次进入与桥接凭据，和设置后账号密码如何共存；保持 DAV、插件授权与启动器身份探测独立。

如果第一项或内部 email/account 模型确实带来不合比例的成本，再采用 Hono 成熟会话部件加单管理员模块；这是明确缩小功能后的替代，而非“会话库已经是完整认证系统”。
