# P0 目录、DAV 与管理链路验证

日期：2026-10-20。范围：首轮插件基础之上的 library、SQLite/D1 快照/布局、共用只读 DAV 与管理 HTTP 入口。真实平台、WebUI、云端发布和系统挂载仍未验收。

## 可复现入口与依赖

- `bun run check`：样本包、Bun/Worker 分别类型检查、源码图及自动化测试。HTTP 测试需要回环端口。
- `bun run probe:worker:dav`：无 Node HTTP 桥接的本地 workerd、D1、共享 Fetch DAV，检查 XML、HEAD、完整与范围字节。
- `bun run probe:rclone`：真实 rclone 客户端的列目录、读取和偏移访问；通过 `MUSICFS_RCLONE` 指定二进制，或先运行 `bun run fetch:rclone:linux` 取得已校验的 Linux 开发探针依赖。
- `bun run probe:compiled` / `bun run probe:worker`：继续保留前轮外置插件与实例状态的回归。

环境继续为 Linux x86_64、Bun 1.4.3、Node v24.19.0、Miniflare 4.20260730.0（workerd 1.20260730.1）。新增运行依赖：`@xmldom/xmldom` 0.9.12、`range-parser` 1.3.0、`sanitize-filename` 1.6.4。具体版本及传递依赖以锁文件为准。

本轮顺序执行 `check → probe:compiled → probe:worker → probe:worker:dav → probe:rclone` 全部成功；自动化测试为 43 项，导入图扫描 50 个 Module、138 条依赖，无违规。编译产物在仓库外重启时，也经共用管理路由和 DAV 返回正确范围字节；该探针不是完整桌面发行包。

## 实际通过范围

| 路径 | 结果与限定 |
|---|---|
| 目录和快照 | 完整分页、空中间页、顺序/重复位置、循环游标拒绝、失败保留上一快照、过期刷新/配置代际拒绝发布 |
| 布局与名字 | 用户布局独立保存、修订 CAS、缺失来源引用保留；中文/保留名/重复名/重排及 255 UTF-8 字节与扩展名保留 |
| 持久化 | SQLite v1→v2 迁移与重启保留实例；D1 初始迁移后实际保存并读取来源与目录快照 |
| HTTP 管理 | 上传包/发布 URL 安装、Schema 校验、两个实例、配置/布局/刷新、重启、移除/重装与单独删除 |
| 访问边界 | DAV Basic 凭据无法调用管理 API；Bearer 由 Hono 验证，错误认证方案返回其标准 400 challenge；坏 JSON/无效设置明确拒绝 |
| DAV XML | Depth 0/1、特殊字符路径、请求属性、未知/外部命名空间属性 404、finite-depth 拒绝和坏 XML 拒绝 |
| 读取 | HEAD、完整 GET、首/中/尾、后缀/开放尾部/超大后缀、206/416 和条件验证器；字节与样本逐段对比 |
| 真实上游 HTTP | 请求范围到达上游；5 GiB 表示中超过 4 GiB 的偏移只取得目标 1,025 字节；忽略范围返回 502、截断产生失败传输、客户端取消到达上游流 |
| 内容换版 | 返回不同表示身份时取消流，按内容变化失败，不拼接或冒用旧元数据 |
| 本地 Worker | 同一 Fetch DAV 在 workerd 中返回 207、HEAD 16,044、完整 WAV 和逐段相同的部分字节，官方 FixedLengthStream 的 Content-Length 正确 |

截断测试有意触发流错误；Bun 会输出来源长度检查的异常，测试确认客户端得到失败传输，这不是未捕获的业务成功结果。Bun 对多块 Web Stream 可能使用 chunked framing；测试检查实际字节，并要求存在的 Content-Length 正确。Worker 已验证固定长度流，不以 Bun 响应头推断其行为。

## 真实 rclone

从[官方发布目录](https://downloads.rclone.org/v1.75.2/)取得 Linux amd64 v1.75.2，并与官方 SHA256SUMS 核对。ZIP 的固定 SHA-256 为 `349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702`，可复现获取脚本将它固定校验，不做系统安装。

通过真实管理 API 安装最小插件及创建实例后，rclone `lsjson --recursive --files-only` 得到中文与 `& #` 路径、正确 16,044 字节；`cat` 完整读取及多次首部/中部/尾部/回退偏移访问均与样本一致。没有调用 mount，因此不证明 FUSE、WinFsp、macOS 挂载、WebUI 挂载管理或播放器实播。

## 候选淘汰与尚未覆盖

Nephele 的 Bun 基础探针曾通过，但本地 Worker Node 桥接完整取流失败。最小反馈环路、试验边界和采用 Fetch 备选的原因见 [ADR 0004](../adr/0004-shared-fetch-readonly-dav.md)。候选探针只作调查用途，不是第二套产品 DAV 实现，也不在正常检查中运行已知失败路径。

尚需 WebUI 和真实网易云/QQ 来源、认证生命周期、所有客户端/目标系统、真实 Cloudflare 免费部署/切换和绑定恢复、系统挂载与发行验证。目录大规模/并发/内存表现及元数据请求成本仍需测量；本轮正确性样本不证明其资源预算。
