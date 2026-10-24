# ADR 0004：共用 Fetch 只读 DAV

日期：2026-10-20。状态：已采用。平台与客户端验证范围见[兼容性说明](../verification.md)。

## 背景与实际证据

原方案优先验证 Nephele 的公开 Resource/Adapter 与官方只读插件，并通过 Worker Node HTTP 桥接复用协议。实际安装锁定 `nephele` / `@nephele/plugin-read-only` 1.0.0-alpha.67 后，Bun 的目录、认证、HEAD 和基础范围读取可运行；超长后缀 Range 需在公开钩子中规范化，HEAD/部分响应长度也需补充接线。

在 Miniflare 4.20260730.0 / workerd 1.20260730.1、compatibility date 2026-07-30 中，补齐显式模块、VFS 中原包 package.json 和 import.meta.url 后，Node 桥接能返回 PROPFIND 和 HEAD，但完整 GET 正文为零字节。重复运行结果相同。进一步的最小反例中，`response.end('RIFF')` 可用，Node/Web Readable `.pipe(response)` 无响应；在 pipe 前直接 `flushHeaders()` 可返回正文，但 pipe 事件和完整 Nephele 路径的流适配仍返回零字节。

这些事实限定于本轮锁定的运行器和构建方式，不证明所有 Node 服务端或真实 Cloudflare 都不可用。它们足以说明当前共同产品路径尚不能靠已验证的公开接线采用 Nephele，继续增加时序兼容层和分发资源规则会扩大维护面。原始候选与最小 `http-bridge` 探针归档于基线提交 `bfee998`，例如 `git show bfee998:tests/probes/nephele-dav.ts`；该提交的锁文件可复现当时依赖。2026-10-20 复盘后从当前工程删除这五份淘汰探针，避免继续维护第二套 DAV 适配。

## 决定

采用原计划的共用薄只读 DAV 备选，由 Hono/标准 Fetch 承载同一实现。XML DOM、命名空间和序列化采用 `@xmldom/xmldom`，Range 解析采用 `range-parser`；核心只提供 `FileView.list/stat/open`，插件仍只实现来源合同。

只维护一套产品 DAV 路径：

- OPTIONS 广告真实方法；PROPFIND 支持 Depth 0/1、allprop/propname/prop/include 与每个属性的状态。infinity 明确返回 finite-depth 错误。
- GET/HEAD 使用真实内容大小、类型和验证器，单范围真正下推到插件；不支持的范围单位和 multipart 请求按 HTTP 允许行为忽略 Range、返回完整 200。
- `range-parser` 对过大 suffix 的拒绝通过一个集中输入规范化处理，不自行实现完整解析器。非法/越界范围保持明确结果。
- 原生 Web Streams 负责背压与取消；library 检查实际表示、范围和字节数。上游忽略范围时拒绝，截断、超长或内容换版不能成为正常 EOF 或假 206。
- Worker 通过官方 `FixedLengthStream` 给音频流绑定真实长度；Bun 可以用合法 chunked framing。存在 Content-Length 时必须与实际字节相符，HEAD 始终提供可靠总长度。
- DAV Basic 凭据与管理 Bearer token 分开；协议层不返回来源私有状态。修改方法拒绝，不扩展锁表、上传和死属性存储。

Nephele、其只读插件及专用 Express 类型依赖随历史探针退出当前依赖树；`fflate` 仍用于独立 ZIP 编码的互操作测试，产品安装器仅使用 zip.js。后续只有新证据能明显减少整体维护成本时再比较成熟服务端，不为两宿主维护两套协议。

## 影响与验收

共用实现已在 Bun 和本地 workerd 上执行；真实上游 HTTP 测试验证范围、取消、截断及超过 4 GiB 的偏移。rclone 的真实 DAV 客户端结果与发布缺口统一记录于[P0 目录与 DAV 证据](https://github.com/shengyusi-SYS/musicfs/blob/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification/p0-library-dav.md)。本决定不改变只读、独立双宿主、免费路线优先或第三方插件的产品合同。
