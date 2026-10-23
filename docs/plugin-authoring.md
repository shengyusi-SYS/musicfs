# 编写并交付一个数据源插件

[English](en/plugin-authoring.md)

从独立作者包开始，修改示例、构建 ZIP，再安装到现有 MusicFS。最小示例提供一份 WAV，不需要账号、歌单或音质概念；网易云、QQ 也使用同一公开合同。

**作者需要 Bun，使用插件的人不需要构建工具。** 作者提前生成 ZIP；使用者在现有 MusicFS WebUI 安装，核心程序和页面都不需要重新编译。当前源码对应 API 0.1.12；下载作者包时，以包内类型和清单为准。精确定义以随包的[公开类型](../packages/plugin-api/src/index.ts)和[插件合同](architecture/plugin-interface.md)为准。

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

打开 [plugins/sample/manifest.json](../plugins/sample/manifest.json)，修改身份与显示名称：

```json
{
  "id": "org.example.myaudio",
  "name": "我的音频来源",
  "nameTranslations": { "en": "My audio source" },
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

1. 进入「插件 → 安装插件」，选择 ZIP 后会自动检查名称、版本和兼容性，点击安装。也可填写 ZIP 下载链接。
2. 进入「音乐库 → 添加来源」，选择自己的插件。创建来源 A 和来源 B，将「目录名称」分别设为不同值；最小插件无需登录。
3. 分别选择两份来源，浏览各自入口，应看到 `440 Hz.wav`。
4. 展开「播放器目录」，新建文件夹，将两份来源入口拖入，点击「保存目录」。也可用「添加到…」选择位置。
5. 从「连接与挂载 → WebDAV 播放器」取得连接，读取两个文件；最小样本完整大小均为16,044字节，可比较完整及范围读取。
6. 只修改来源 A 的目录名称，再更新入口，确认 B 不变。用户已保存的播放器目录别名继续由目录整理控制。
7. 正常重启后，两份实例、布局和文件仍可使用。

Worker 安装显示后台变更进度，完成后再创建实例。若插件声明支持 Worker，也应在该宿主核对自己的网络与运行时依赖。

## 开始适配自己的来源

先阅读[最小插件说明](../plugins/sample/README.md)。通常只需从这些文件开始：

| 文件 | 作者负责的内容 |
|---|---|
| [index.ts](../plugins/sample/index.ts) | 默认导出的 `SourcePlugin`，配置检查、入口、目录、描述和实际读取 |
| [config.schema.json](../plugins/sample/config.schema.json) | 实例配置字段与结构约束，直接供通用页面显示 |
| [translations.json](../plugins/sample/translations.json) | 可选显示翻译，编入配置声明；不改动配置值和目录名 |
| [manifest.json](../plugins/sample/manifest.json) | 插件身份、版本、API 范围、宿主入口、结构版本和包内文件清单 |
| [generated-config.d.mts](../plugins/sample/generated-config.d.mts) | 生成验证器的类型声明；生成的 `.mjs` 不手改 |
| [LICENSE.txt](../plugins/sample/LICENSE.txt) | 当前示例的许可；发布自己的派生代码和依赖时保留适用声明 |
| [build-sample.ts](../scripts/build-sample.ts) / [build-plugin.ts](../scripts/build-plugin.ts) | 作者侧校验器生成、ESM 打包与 ZIP 封装 |

核心接收文件和不透明引用，不负责解释你的来源账号、歌单分类或音质。新增 npm 依赖时在作者侧安装、固定并打包，确认它能在所声明的宿主运行；使用者只安装 ZIP。只有自己实际支持的宿主才写入 `manifest.hosts`。

实现时先落实下面几条与可见行为直接相关的责任，详细字段和边界继续使用[插件合同](architecture/plugin-interface.md)：

- **身份与分页：** `sourceId` 标识入口，`entryId` 标识目录中的一次出现；同名或重复内容仍可有不同出现身份。`fileRef` 是稳定引用，`contentId` 标识实际字节，不能用会过期的下载地址代替。分页失败返回错误，不能伪装最后一页或空目录；核心在完整成功后切换目录快照。
- **文件修改时间：** 建议提供每个最终表示的稳定`info.modifiedAt`，不要在每次list/stat中改成当前时间。增删其他歌曲不应改变此文件的时间；缺失时宿主使用目录内容时间，目录实际变化会影响依赖mtime的挂载与同步缓存。
- **文件描述：** 能确认时，在文件条目提供完整 `Entry.info`，与 `stat`、`open` 的内容身份、大小和媒体类型一致。无法确认时省略整个 `info`，不能填写猜测大小或把技术失败当成没有播放权限。示例的 WAV 描述来自已知实际字节。
- **可选延迟准备：** 需要先发布完整清单时可显式返回 `Entry.deferredInfo: true`，单文件stat按需提供准确描述；宿主设置 `ctx.fileInfo: 'required'` 的分页准备调用中，每个文件必须返回完整info或明确故障。使用此能力须声明API至少0.1.8，详见[两阶段文件合同](architecture/plugin-interface.md#稳定身份分页与目录)。旧插件可保持现有实时stat，不需要增加标签方法。
- **补标签可选：** 可以透传原文件，也可以在插件中自带实现或选用第三方/共用工具；没有强制的标签方法或核心音乐字段。处理后的描述和 Range 必须对应最终字节，核心不会再补写一遍。依赖由插件作者打包，详细设计位于完整源码包的 `docs/architecture/audio-tags.md`。
- **读取与取消：** 用 `ctx.fetch` 和 `ctx.signal` 请求来源；返回原生可取消流并保留背压。只返回实际提供的范围，检查 `expectedContentId`，不要为模拟范围下载整曲或在已开始的响应中换文件。来源流被取消时应停止真正的上游工作。
- **实例状态：** 配置和私有状态来自当前 `ctx`。不要把 Cookie、令牌或实例设置存在共享模块变量中；通过结果的 `nextPrivateState` 提议保存。已确认凭据变化后，即使后续业务失败，也可以提出该状态；宿主负责按实例和版本提交，页面只接收公开结果。
- **可选缓存：** 使用 `ctx.cache` 可在宿主保存小 JSON 资料和表示计划，与授权状态分开；需要它的插件声明 API 至少 0.1.6。资料可以设置 `expiresAt`，已发布文件使用的不可变计划不应随短 TTL 消失。API0.1.9另提供可选`putIfAbsent`，用于并发首读时原子固定永久计划；使用独立键，后续通过返回值读取胜出的计划。普通`put`仍可覆盖同名键，插件应自行区分用途。`@musicfs/audio-tags` 是两个音乐示例选用的工具，不是插件必需依赖。
- **可选更新控制：** API0.1.10的`contentConfiguration`可排除纯保留策略，避免只调整缓存天数就使整库失效。声明`metadataRefresh: true`后，`list`需识别`ctx.metadataRefresh`操作ID，重新取得资料并跨页复用本轮结果；已发布计划保持不可变。细节见[插件合同](architecture/plugin-interface.md#保留策略与资料更新)。
- **可选命名资料：** API0.1.11可声明`naming: {fields: {title: '歌名', artist: '歌手'}}`，文件条目提供`naming: {identity: '来源歌曲:实际音质', fields: {title: '歌名', artist: ['歌手']}}`。资料来自当前清单，不为模板补取音频；identity不使用整歌单位置。核心负责模板、扩展名和同名处理，旧插件可继续只提供`name`。详见[命名职责](architecture/updates-and-naming.md#模板与插件合同)。
- **更新与迁移：** 发布版本与 `configVersion`、`stateVersion` 是不同概念。只有结构变化才提升相应结构版本，提供需要的纯转换及 `validateState`；宿主准备候选并整体激活，失败保留旧状态。无需认证、续期或迁移时不声明对应可选能力。

## 显示翻译

API0.1.12可在清单加入 `"nameTranslations": { "en": "My source" }`，保留 `name` 作为默认名称。使用这个新字段时将 `apiRange` 下限设为0.1.12。

配置声明可自带词典，不需要插件依赖 React、i18next 或宿主源码：

```ts
configuration: {
  schema: { type: 'object', properties: { server: { type: 'string', title: '服务器地址' } } },
  translations: {
    en: { '服务器地址': 'Server URL', '请先授权。': 'Sign in first.' }
  }
}
```

界面按插件命名空间翻译配置注释、授权提示和错误；没有词典时保留原文。不要翻译 `const`、`enum`、`default`、歌曲名或文件引用。带参数的错误可返回原消息和可选的 `translation: { key: '请求失败（{{status}}）', values: { status: 503 } }`，并在词典中定义对应键；缺少翻译时回退到 `message`。

## 发布与更新

发布插件 ZIP，并说明名称、版本、API 范围、支持的宿主、配置和登录方式。使用者可以上传 ZIP 或填写可直接下载的链接；每次改变包内容都提升版本。配置或状态结构改变时再提升相应结构版本并实现迁移，其余修正不必改结构版本。发布前用两个实例检查配置隔离，并从旧版更新一次核对数据保留。

## 开源许可

随包的公开类型、构建工具和示例代码采用 GPL-3.0-only，正文见 [LICENSE](../LICENSE)。第三方组件保留各自许可和署名。发布 ZIP 时附适用的许可、依赖说明和构建所用源码入口。
