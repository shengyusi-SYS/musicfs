# MusicFS 开发与验证

当前是 P0 插件、目录及协议实现，尚无面向用户的完整应用。主线和验收见[目标](codex-goal.md)与[台账](verification.md)；下面的程序和命令用于开发验证，不是产品要求用户操作的 CLI。

## 环境与入口

使用 `package.json` 指定的 Bun 版本；依赖以 `bun.lock` 为准。依赖图工具通过 Node 运行，本轮实际验证 Node v24.19.0。先安装依赖：

```sh
bun install --frozen-lockfile --ignore-scripts
```

从仓库根目录执行：

| 命令 | 验证内容 |
|---|---|
| `bun run check` | 构建最小/QQ 插件、严格类型检查、导入图检查、自动化测试；任一步失败即停止 |
| `bun run build:sample` | 同一 JSON Schema 生成 Ajv standalone 校验，构建浏览器兼容 ESM 并生成 ZIP |
| `bun run build:qq` | 构建 QQ 开发预览与必要许可，生成固定 SDK 原始读取入口、固定日志设置以消除 process 依赖；生成 dist/plugins/org.musicfs.qq.zip |
| `bun run probe:worker:qq` | 将实际 QQ 打包模块放入本地 workerd/D1，无 Node 兼容开关；检查状态隔离，可显式选择真实开发会话 |
| `bun run build:web` | 构建共用 React/Vite 页面至 dist/web |
| `bun run build:auth-fixture` | 开发专用的“非真实音源”认证测试包，生成至 dist/p0/authentication-fixture.zip |
| `bun run dev:service` | 用显式测试凭据启动 127.0.0.1:8787 的开发服务，状态保存在 dist/dev-data，同时提供已构建页面 |
| `bun run dev:web` | 127.0.0.1:5173 的 Vite 开发服务器，管理/DAV 请求代理到开发服务 |
| `bun run probe:compiled` | 构建当前宿主的独立二进制，在临时目录安装外置插件、持久化双实例，再启动第二个进程读回 |
| `bun run probe:worker` | 构建固定模块集合，在本地 Miniflare/workerd 中验证 ZIP、校验、插件流、D1 条件更新与重启；需要本地回环端口 |
| `bun run probe:worker:dav` | 同一 Fetch DAV 在本地 workerd/D1 读取真实样本字节，验证 XML、HEAD、固定长度及范围 |
| `bun run probe:worker:authentication` | 同一正式管理路由在本地 workerd/D1 验证认证恢复、实例隔离、输入失败和真实延迟上游在取消后的旧结果拒绝 |
| `bun run fetch:rclone:linux` | 从官方地址取得固定 Linux 探针版本并核对已固定 SHA-256，仅写入 dist/tools，需要网络 |
| `bun run probe:rclone` | 已核验 rclone 经临时真实 HTTP 服务列目录、完整/随机读取；可用 MUSICFS_RCLONE 指定其他已验证二进制 |

`dev:service` 需要开发者显式设置 `MUSICFS_ADMIN_TOKEN` 和 `MUSICFS_DAV_PASSWORD`，开发 DAV 用户名为 `musicfs`；不能把测试凭据当作发行默认值。构建前端后可直接打开 8787 服务，或用 Vite 开发；页面手动输入管理令牌，也可由启动入口经 fragment 传入并立即移除。最终用户的凭据初始化和可点击启动器另行实现。

最小插件包输出到 `dist/plugins/org.musicfs.sample.zip`，QQ 开发预览输出到 `dist/plugins/org.musicfs.qq.zip`；编译探针与 Worker 探针输出到 `dist/p0/`。这些目录不进入版本控制。插件生成的校验代码在构建时产生；其 `.d.mts` 类型声明随源码保存。

各正式探针正常结束时清理临时数据库及安装文件。默认仅使用本地测试状态，不要求 Cloudflare 账号或音乐账号；QQ 探针的可选真实会话模式例外，见下文。Worker 探针固定兼容日期和显式模块清单，不执行线上部署，也不证明免费配额适用。`check` 中的 HTTP 测试也需回环端口；`probe-nephele-dav` 和 `probe-http-bridge` 仅是未采用方案的诊断，不属于通过门槛。

## 可选真实来源复测

QQ 的真实授权/字节验证见[首条链路](verification/p1-qq-source.md)，原始分类、SDK 适配和当前缺口见[后续记录](verification/p2-qq-catalog.md)。本地 workerd 复测已有开发会话时，显式设置 `MUSICFS_QQ_TEST_STATE_DB`（开发 SQLite 的绝对路径）及 `MUSICFS_QQ_TEST_INSTANCE_ID`，再运行 `bun run probe:worker:qq`。脚本只读所选 QQ 实例的私有状态，在临时 D1 恢复后校验真实账号、每日推荐、自建/收藏和有限推荐集合，最后清理；不输出凭据，不执行云部署或重新扫码。

通用真实 DAV 字节复测入口为：

```sh
bun scripts/probe-real-dav.ts --path-file /tmp/selected-library-path.txt
```

路径文件只保存一个已发布的绝对 library 文件路径，例如 `/分组/文件.mp3`。先显式设置 `MUSICFS_DAV_ORIGIN`、`MUSICFS_DAV_USERNAME`、`MUSICFS_DAV_PASSWORD`；不要在文档或命令示例中写真实凭据。脚本检查 HEAD/完整 GET/五种范围/416，最多读取 64 MiB，输出计数和 SHA-256，不打印路径。`--save /tmp/audio.mp3` 可供本地媒体格式检查；提供 `MUSICFS_RCLONE` 时，还验证该已校验二进制的列表、完整下载与前后偏移。脚本不执行系统挂载，也不等同于普通播放器实播。

## 实现入口

| 职责 | 源码 |
|---|---|
| 独立公开类型 | [plugin-api](../packages/plugin-api/src/index.ts) |
| 包清单/兼容与基础安装策略 | [extensions](../src/core/extensions/index.ts) |
| 实例调用、配置及状态条件写入协调 | [sources](../src/core/sources/index.ts) |
| 完整快照、布局、路径与内容核对 | [library](../src/core/library/index.ts) |
| 管理 API / 共用只读 DAV | [HTTP](../src/transport/http/index.ts)、[DAV](../src/transport/dav/index.ts)、[接口说明](management-api.md) |
| 共用页面 / 独立管理 DTO | [WebUI](../src/web/shell.tsx)、[合同](../src/contracts/management.ts)、[界面说明](architecture/web-ui.md) |
| 实际 ZIP 解析与预算 | [archives](../src/infrastructure/archives/index.ts) |
| SQLite / D1 Adapter | [SQLite](../src/infrastructure/persistence/sqlite.ts)、[D1](../src/infrastructure/persistence/d1.ts) |
| 桌面不可变外置模块 / Worker 注册集合 | [desktop](../src/hosts/desktop/plugins.ts)、[worker](../src/hosts/worker/plugins.ts) |
| QQ 来源认证、目录和音频 | [QQ 插件说明](../plugins/qq/README.md) |
| 无账号、歌单或音质设置的来源 | [sample](../plugins/sample/index.ts) |

安装器目前拒绝配置/私有状态 schema 版本变化，直到候选迁移与统一激活实现；失败候选保留当前安装。桌面仍保留不可变修订文件，后续补齐回收与中断恢复。基础管理 UI 和通用交互认证已接线，QQ 首条真实链路已有[限定证据](verification/p1-qq-source.md)，完整示例、续期合并、挂载和发行入口仍按计划推进。范围见[首轮 WebUI](verification/p1-webui.md)及[通用认证](verification/p1-authentication.md)。SQLite 使用三份顺序迁移，D1 探针执行相同 SQL；不要修改已应用的历史迁移来补新字段。

变更后的检查以实际职责为准；本地 Worker、真实 Cloudflare、桌面二进制和目标系统挂载分别记录证据，不相互替代。结果见[插件基础](verification/p0-plugin-foundation.md)及[目录/DAV/管理链路](verification/p0-library-dav.md)。
