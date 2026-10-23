# 桌面共享读取缓存：限定验证

记录日期：2026-10-21。正式模块及最终 Windows dev.11，API0.1.9/schema10、示例插件 alpha.15 不变。设计见[共享读取](../architecture/shared-read-cache.md)，精确构建输入和归档身份见[发行页](../release-history.md#dev11-直接webdav共享读取缓存)。本页整理已有结果，未新增产品验证。

## 入口与证据

| 范围 | 方法与已有结果 | 原始记录 |
|---|---|---|
| WSL 正式模块 | `scripts/probe-shared-dav-cache.ts`，Library/DAV/SQLite、标签工具、生成有效 MP3 与 FFprobe；相同/重叠已缓存范围、原生 VFS 重建后的头尾重读为零源请求 | [匿名计数](data/shared-dav-cache-2026-10-21.json) |
| 正常版本更新 | 同路径、大小与 mtime 的新 contentId 取得新标签；旧来源代际被拒绝 | 同上及相关自动化回归 |
| 生命周期 | 活动读取不清理；退出准备拒绝新增读取，失败可恢复；未使用不启动；内部直读保留批量元数据路径 | `tests/desktop-read-cache.test.ts`、`tests/desktop-read-cache-http.test.ts` |
| 最终 Windows 包 | 现有 VM 中代理生成音频的离线插件；首次头尾读取后同范围零源 GET，正常退出并重启整个 App 后仍复用 | [Windows 匿名结果](data/windows-shared-dav-cache-2026-10-21.json) |
| 清理与 App 挂载 | 清理后重新取源；本机 WinFsp 挂载字节正确且共享层保持 inactive，随后正常退出 | 同上 |
| 预读负结果 | 128KiB 与零内存缓冲对照均有额外源请求，零缓冲未显示足够净收益，保留原设置 | [缓冲对照](data/shared-dav-buffer-2026-10-21.json) |

三套 TypeScript、依赖方向及相关桌面基础/管理回归通过。默认受限执行环境的回环监听曾返回 EPERM，换用允许回环的执行环境后验证；没有为此修改产品行为。

## 结果解释与停止边界

- 开放 GET 会在客户端决定的时刻取消，重复打开可能读到新尾端；原生对齐和有限预读也存在。证明已缓存同范围可复用，不承诺第二次 FFprobe 全程零网络。
- 源 HTTP 排队、读取器实际消费及 VFS 实存分别计算，不能把发送量当精确公网下载量。
- Windows 单曲 Shell 样本读取约 3MiB 最终范围；外推数千首的扫描工作集可超过原挂载默认容量。这只是容量模型，不是用户全库实际占用或卡顿根因证明。[原 Shell 证据](data/windows-shell-cache-2026-10-21.json)
- 原生 VFS 复用验证不等于真实 SDK/平台限流已复测；未做真实全库刷新、平台压力或 Worker 部署。Windows 只使用已授权 VM，未操作物理宿主。
- 生成音频证明对应字节与消费行为，不证明真实 4000 首 GUI 耗时、所有格式或所有第三方客户端已验证。

dev.9 的扫描预读对照与 dev.10 的播放/Windows 消费结果继续保留在[缓存消费记录](cache-consumption-2026-10-21.md)，不改写成 dev.11 新运行。
