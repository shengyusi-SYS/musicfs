# 管理页面登录：选型结论

2026-10-22。已采用固定版本 Better Auth 1.7.12，为 MusicFS 单管理员提供密码校验、数据库会话、Cookie、记住登录和撤销。桌面与 Worker 共用认证模块；现行合同、入口图和存储见[管理访问架构](../architecture/management-access.md)，实际证据见[定向核对](../verification/desktop-access.md)。

## 为什么采用

用户需要账号密码、记住登录和设备独立会话，同时保留桌面直接进入与手机扫码。完整认证依赖能减少自己组合密码存储、会话续期与撤销的维护成本。接受认证专用的 user/account/session/verification 表；它们留在认证边界，不要求音乐库迁移 ORM，也不向用户增加邮箱、注册或第三方身份服务。

Better Auth 的 Web Request/Response 接线适配现有 Hono，固定版本支持 Bun SQLite 与 D1 binding。桌面独立 auth.sqlite；Worker 使用部署迁移 0011.sql。库内部数据库抽象不外泄到来源、目录或 DAV。

## 替代与取舍

| 路线 | 实际能力与取舍 |
|---|---|
| Hono Cookie / 会话组件 | 能减少表模型，但不是完整账号密码系统，仍需 MusicFS 维护密码、账号、撤销及扫码桥接。部分组件异步存储写入没有 await，不直接包装成 D1 适配。 |
| Auth.js Credentials | 不替应用保存账号密码；没有 SSO 需求，未比当前路线更贴合。 |
| Better Auth OTT | 文档说明兑换关联会话，不能据此假定会新建手机独立会话。当前使用库的 verification 存储消费 ticket，再走正常会话签发。 |
| Device Authorization | 发码、确认与轮询增加步骤，不符合从已登录电脑扫码直接进入的场景。 |

## 已解决的接缝

- 首次桌面无密码要求；启动器验证后台后签发一次使用、3 分钟有效的 ticket。网页兑换后删除 fragment。
- 手机在自己的 LAN 主机地址兑换，获得独立 Cookie 会话；不是复制电脑 Cookie。局域网仍需用户手动开启。
- HTTP/IP 与 HTTPS 分别配置 Cookie；浏览器和 API 同源。长期管理令牌继续作为部署/bootstrap 和脚本 Bearer 凭据。
- 只暴露本产品端点；单管理员内置标识映射隐藏内部 email 模型，不安装 username 插件或增加邮箱表单。
- Worker 构建选择 workerd 条件，使用依赖原生 scrypt；Bun、本地 workerd/D1 及正式多模块构建接线已通过定向验证。

免费 Worker 的真实计费 CPU 尚未测量。本地原生 scrypt 通过只证明路径能运行，不证明免费请求额度；本轮没有为此新增云端部署、降低密码成本或引入外部服务。常规已登录会话不重新计算密码哈希。

## 第一方参考

[Better Auth 固定版本](https://github.com/better-auth/better-auth/tree/v1.7.12)、[Hono 接线](https://better-auth.com/docs/integrations/hono)、[SQLite](https://better-auth.com/docs/adapters/sqlite)、[数据库模型](https://better-auth.com/docs/concepts/database)、[会话](https://better-auth.com/docs/concepts/session-management)、[Cookie](https://better-auth.com/docs/concepts/cookies)。

[密码修复 PR](https://github.com/better-auth/better-auth/pull/8685)、[历史 Worker issue](https://github.com/better-auth/better-auth/issues/8860)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)。历史 JS scrypt 问题不能直接套用到本轮已选择的原生路径。

[Hono Cookie helper](https://hono.dev/docs/helpers/cookie)、[Hono session 源码](https://github.com/honojs/middleware/tree/main/packages/session)、[hono-sessions](https://github.com/jcs224/hono_sessions)、[Auth.js Credentials](https://authjs.dev/getting-started/authentication/credentials)、[OTT](https://better-auth.com/docs/plugins/one-time-token)、[Device Authorization](https://better-auth.com/docs/plugins/device-authorization)。
