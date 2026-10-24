# 依赖说明与取舍

[English](en/dependencies.md)

MusicFS 复用现成库处理表单、认证、归档、标签和系统集成；插件、快照、文件表示和刷新规则由项目自身定义。版本以各包的 `package.json`、`bun.lock` 和原生辅助程序的 `Cargo.lock` 为准。

## 表单与校验

**RJSF** 将插件声明的 JSON Schema 变成表单，Ant Design 主题负责控件外观。这样新插件只需描述字段，不必给主程序新增专用页面。手写每个平台的表单会让插件与前端耦合；更轻的表单库则仍需自己实现 Schema 到控件的映射。

**Ajv** 校验 JSON Schema。示例插件在构建时生成 standalone 校验代码，运行时直接调用，适合 Worker 的执行环境。RJSF 使用对应的 Ajv 适配器；`ajv-i18n` 翻译校验错误。Zod 负责项目自有的管理 API 输入，两者分别对应插件的声明式配置与本体合同。

## 归档与版本

**zip.js** 用于产品中的插件 ZIP 和发行归档，支持流式读写、条目校验和文件权限信息。**fflate** 仅用于开发和测试中的独立 ZIP 编码，检查归档互操作性，不参与产品安装路径。JSZip 也能处理普通 ZIP；当前工具链复用 zip.js，避免大归档整体驻留内存。

**semver** 解析版本和兼容范围，例如 `^0.1.0`。它负责版本规则，MusicFS 负责判断某个插件是否能安装及如何切换实例。自行比较版本字符串会误判预发布版和范围表达式。

## 时间、命名与缓存

| 依赖 | 用途与选择理由 |
|---|---|
| Croner | 计算带时区的日历更新时间；持久任务、重试与完成后的下一次安排仍归刷新模块 |
| Mustache | 将插件提供的资料填入文件名模板；语法成熟，预览和实际导出使用同一渲染结果 |
| sanitize-filename | 处理文件系统不接受的名称；同名分配和稳定身份仍归 MusicFS |
| lru-cache | 限制进程内目录索引等缓存；持久音频片段由 rclone VFS 管理 |
| rclone | WebDAV 客户端、系统挂载与稀疏读取缓存，复用其成熟文件系统适配能力 |
| node-taglib-sharp | 可选音频工具中的标签编码；MusicFS 组合标签与原音频区段，保持音频编码不变 |

字段、范围、大小与内容身份的关系不能交给一个通用缓存库推断。相关合同见[缓存设计](architecture/cache-policy.md)和[标签工具](../packages/audio-tags/README.md)。

## 页面、访问与运行

| 依赖 | 用途 |
|---|---|
| React、Vite、Ant Design | 共用管理页面、构建和组件 |
| TanStack Query | 页面请求、查询复用、状态更新与失效 |
| Pragmatic Drag and Drop | 音乐库拖拽操作；目录草稿和保存仍由页面状态管理 |
| i18next、react-i18next | 中英文文案、插值和浏览器语言偏好 |
| Hono | 桌面与 Worker 共用的 HTTP 路由 |
| Better Auth | 单管理员的密码与浏览器会话，接入桌面免手输和扫码入口 |
| LogTape | 桌面和 Worker 共用结构化日志，桌面文件轮转及高频限制 |
| xmldom、range-parser | DAV XML 与 HTTP Range 解析；MusicFS 维护只读文件合同 |
| Cloudflare 官方 SDK、Wrangler | Worker 代码发布、资源和部署工具 |
| Bun SQLite、D1 | 两类宿主的持久状态，复用共同 SQL 与条件提交 |

来源 SDK 由各插件持有并固定版本，参见[网易云](../plugins/netease/README.md)和[QQ](../plugins/qq/README.md)。桌面托盘与自启的原生依赖见[系统集成取舍](research/desktop-integration.md)，管理登录选型见[认证取舍](research/management-authentication.md)。

## 依赖方向与发行材料

**dependency-cruiser** 扫描导入关系，检查领域核心不能导入 UI、来源 SDK 或宿主实现等规则。TypeScript 检查类型，它检查模块边界；二者解决不同问题。

第三方许可按实际参与构建的依赖收集。固定运行时资料保存在 `third-party/`，包内许可与源码交付方式见[第三方说明](../third-party/README.md)。
