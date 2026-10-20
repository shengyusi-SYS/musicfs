# 编写并交付一个数据源插件

这份指南从独立作者包开始，完成修改插件 ID、构建 ZIP、安装和创建两个实例。示例只提供一份 16,044 字节的 WAV，不需要账号、歌单或音质概念。它使用与网易云、QQ 相同的公开合同。

**作者需要 Bun，使用插件的人不需要构建工具。** 作者提前生成 ZIP；使用者在现有 MusicFS WebUI 安装，核心程序和页面都不需要重新编译。本文对应开发期 API 0.1.5，精确定义以随包的[公开类型](../packages/plugin-api/src/index.ts)和[插件合同](architecture/plugin-interface.md)为准。

## 准备一个独立目录

使用已交付的 `plugin-author-kit` 目录。若从 MusicFS 源码仓库开始，先在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run build:author-kit
```

输出为 `dist/plugin-author-kit/`。然后把这个目录的**全部内容**复制到一个新的工作目录。以下是 Linux/macOS 的例子，在 MusicFS 仓库根目录执行：

```sh
mkdir -p /tmp/musicfs-author-demo
cp -R dist/plugin-author-kit/. /tmp/musicfs-author-demo/
cd /tmp/musicfs-author-demo
```

Windows PowerShell 可以使用：

```powershell
New-Item -ItemType Directory -Path "$env:TEMP/musicfs-author-demo"
Copy-Item -Path dist/plugin-author-kit/* -Destination "$env:TEMP/musicfs-author-demo" -Recurse
Set-Location "$env:TEMP/musicfs-author-demo"
```

接下来所有作者包命令都在这个新目录执行。已验证工具链使用 Bun 1.4.3，可先运行 `bun --version` 核对。安装锁定的构建依赖：

```sh
bun install --frozen-lockfile
```

`@musicfs/plugin-api` 当前是随包提供的私有本地包，**尚未发布到 npm**。作者包通过 `file:./packages/plugin-api` 使用它，请保留整个 `packages/plugin-api/`，不要替换成从 npm 安装同名包。Ajv、zip.js、TypeScript 和 Bun 类型由作者包自己的锁文件固定，不需要复制 MusicFS 的 WebUI 或运行依赖。

## 修改身份并构建

打开 [plugins/sample/manifest.json](../plugins/sample/manifest.json)，保留其他字段，先修改以下三个字段：

```json
{
  "id": "org.example.myaudio",
  "name": "我的音频来源",
  "version": "0.1.0"
}
```

`id` 是插件的稳定身份，使用自己的唯一值；文件夹仍可叫 `plugins/sample`。`name` 是页面显示名称，`version` 是本次发布版本。示例已经声明桌面和 Worker 都使用 `index.mjs`，不必为第一次构建修改它们。

在作者包根目录执行：

```sh
bun run build
bun run typecheck
```

应生成 `dist/plugins/org.example.myaudio.zip`。构建先用 Ajv 从配置 Schema 生成 `generated-config.mjs`，再用 Bun 打包 ESM，最后由 zip.js 写入 ZIP。运行时不编译 Schema，也不安装 npm 依赖；`@musicfs/plugin-api` 只作类型导入，不是插件运行时要向宿主索取的模块。

每次修改发布内容后递增 `manifest.version` 再构建，包括改变代码、Schema 或包内文件。宿主用包摘要识别实际内容，不接受同一版本悄悄换成另一份包。第一次从示例派生新插件时改用自己的 ID，也可避免替换已有最小示例。

若直接在完整 MusicFS 仓库内开发，构建命令是 `bun run build:sample`；仓库的 `bun run typecheck` 检查范围更大。作者包使用上面的 `build`、`typecheck`，两者共用相同的示例构建与打包实现。

## 安装并验证两个实例

启动现有 MusicFS，打开 WebUI。以下步骤只操作预构建 ZIP：

1. 进入“插件 → 安装插件”，选择刚生成的 ZIP，点击“检查插件”。核对显示的 ID、版本、API 范围和支持宿主；兼容后点击“安装插件”。也可使用可直接下载 ZIP 的发布地址，检查和安装时都会校验包。检查本身不会安装。
2. 进入“数据源 → 添加数据源”，选择“我的音频来源”。创建实例 A，名称填“来源 A”，配置中的“目录名称”填“声音甲”。再创建实例 B，分别填“来源 B”和“声音乙”。此插件没有认证能力，因此无需扫码。
3. 分别打开两个实例的“内容源”，等待首次准备完成，应看到各自配置的入口。需要时点击“刷新目录”，等进度完成。
4. 进入“目录布局”，在草稿中添加一个“插件试用”分组，把两个实例的内容源分别加入，点击“保存并发布”。如果此前是默认布局，先点击“创建自定义布局”。在“已发布目录”中打开这两个来源，应分别看到 `440 Hz.wav`。
5. 从“服务连接”取得 WebDAV 地址和读取凭据，在客户端打开这两个文件。每份均为 16,044 字节，支持完整读取和随机范围读取。
6. 只把实例 A 的“目录名称”改成“声音甲改名”，保存并重新打开两个实例的内容源。A 的入口名称应变化，B 仍为“声音乙”。已保存的布局别名由“目录布局”控制，不随来源配置自动改名。
7. 重启 MusicFS 后，确认两份实例配置和已保存布局仍存在，文件仍可读取。

若使用已配置发布能力的 Worker，安装会显示后台变更进度，等操作完成后再创建实例。作者无需重新编译 Worker 核心或 WebUI。独立构建成功与本地安装只证明相应链路，不能替代真实 Worker 发布、资源额度或目标系统运行验收。

## 开始适配自己的来源

先阅读[最小插件说明](../plugins/sample/README.md)。通常只需从这些文件开始：

| 文件 | 作者负责的内容 |
|---|---|
| [index.ts](../plugins/sample/index.ts) | 默认导出的 `SourcePlugin`，配置检查、入口、目录、描述和实际读取 |
| [config.schema.json](../plugins/sample/config.schema.json) | 实例配置字段与结构约束，直接供通用页面显示 |
| [manifest.json](../plugins/sample/manifest.json) | 插件身份、版本、API 范围、宿主入口、结构版本和包内文件清单 |
| [generated-config.d.mts](../plugins/sample/generated-config.d.mts) | 生成验证器的类型声明；生成的 `.mjs` 不手改 |
| [LICENSE.txt](../plugins/sample/LICENSE.txt) | 当前示例的许可；发布自己的派生代码和依赖时保留适用声明 |
| [build-sample.ts](../scripts/build-sample.ts) / [build-plugin.ts](../scripts/build-plugin.ts) | 作者侧校验器生成、ESM 打包与 ZIP 封装 |

核心接收文件和不透明引用，不负责解释你的来源账号、歌单分类或音质。新增 npm 依赖时在作者侧安装、固定并打包，确认它能在所声明的宿主运行；使用者只安装 ZIP。只有自己实际支持的宿主才写入 `manifest.hosts`。

实现时先落实下面几条与可见行为直接相关的责任，详细字段和边界继续使用[插件合同](architecture/plugin-interface.md)：

- **身份与分页：** `sourceId` 标识入口，`entryId` 标识目录中的一次出现；同名或重复内容仍可有不同出现身份。`fileRef` 是稳定引用，`contentId` 标识实际字节，不能用会过期的下载地址代替。分页失败返回错误，不能伪装最后一页或空目录；核心在完整成功后切换目录快照。
- **文件描述：** 能确认时，在文件条目提供完整 `Entry.info`，与 `stat`、`open` 的内容身份、大小和媒体类型一致。无法确认时省略整个 `info`，不能填写猜测大小或把技术失败当成没有播放权限。示例的 WAV 描述来自已知实际字节。
- **读取与取消：** 用 `ctx.fetch` 和 `ctx.signal` 请求来源；返回原生可取消流并保留背压。只返回实际提供的范围，检查 `expectedContentId`，不要为模拟范围下载整曲或在已开始的响应中换文件。来源流被取消时应停止真正的上游工作。
- **实例状态：** 配置和私有状态来自当前 `ctx`。不要把 Cookie、令牌或实例设置存在共享模块变量中；通过结果的 `nextPrivateState` 提议保存。已确认凭据变化后，即使后续业务失败，也可以提出该状态；宿主负责按实例和版本提交，页面只接收公开结果。
- **更新与迁移：** 发布版本与 `configVersion`、`stateVersion` 是不同概念。只有结构变化才提升相应结构版本，提供需要的纯转换及 `validateState`；宿主准备候选并整体激活，失败保留旧状态。无需认证、续期或迁移时不声明对应可选能力。

示例许可仅覆盖其声明的范围。公开类型、构建工具及第三方依赖的授权以交付物随附的许可为准，不从示例的 MIT 声明推断整个 MusicFS 或全部依赖采用相同许可。
