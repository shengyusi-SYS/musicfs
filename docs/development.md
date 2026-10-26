# 开发 MusicFS

[English](en/development.md)

MusicFS 由共用核心、WebUI、桌面/Worker 宿主和独立来源插件组成。新增数据源从[插件作者指南](plugin-authoring.md)开始；修改应用按本页启动、验证和构建。

## 准备环境

使用 `package.json` 固定的 Bun，当前为1.4.3；类型和依赖检查使用 Node 24，源码与发行工具使用 Git。桌面原生构建另需 Rust/Cargo 与目标工具链，见[原生辅助程序](../native/desktop/README.md)。

```sh
bun install --frozen-lockfile --ignore-scripts
```

## 启动本地开发

在第一个终端构建页面和插件，启动测试后台：

```sh
bun run build:web
bun run build:sample
export MUSICFS_ADMIN_TOKEN=local-development-token
export MUSICFS_DAV_PASSWORD=local-reader-password
bun run dev:service
```

Windows PowerShell 中，将两条 `export` 换成：

```powershell
$env:MUSICFS_ADMIN_TOKEN="local-development-token"
$env:MUSICFS_DAV_PASSWORD="local-reader-password"
```

打开 `http://127.0.0.1:8787/`，填入上面的管理令牌进入。数据在 `dist/dev-data`，读取用户名为 `musicfs`。在插件页安装 `dist/plugins/org.musicfs.sample.zip`，即可不用音乐账号浏览和读取样本。

改前端时，在第二个终端运行：

```sh
bun run dev:web
```

打开 `http://127.0.0.1:5173/`，Vite 将请求代理到测试后台。开发服务提供共用能力，不注册托盘、自启或系统挂载；完整桌面入口另用构建产物运行。

## 按职责修改

| 改什么 | 入口 |
|---|---|
| 页面、表单、工作区 | `src/web`；[界面设计](architecture/web-ui.md) |
| 核心领域 | `src/core/extensions`、`sources`、`library` |
| 管理 HTTP、只读 DAV | `src/transport`；[API](management-api.md) |
| 桌面监听、托盘、挂载 | `src/hosts/desktop`、`native/desktop` |
| Worker、D1、插件发布 | `src/hosts/worker`、`src/worker.ts` |
| 插件类型、示例和标签工具 | `packages/plugin-api`、`plugins`、`packages/audio-tags` |

核心单向依赖 `library → sources → extensions`，插件通过公开类型接入，宿主从外侧适配存储和执行。更多分工见[架构](architecture/README.md)。数据库结构变更新增迁移，保留已应用文件；SQLite/D1 语义同时核对。

新增界面文案同时维护 `src/i18n/locales/zh-CN.json` 和 `en.json`。共用 UI 使用显示层翻译，插件提供自己的词典；歌曲、配置值和文件身份不翻译。[国际化规则](architecture/i18n.md)

## 验证改动

```sh
bun run typecheck
bun run check:boundaries
bun run check:i18n
bun test tests/你的相关测试.test.ts
```

完整离线检查用 `bun run check`，它会先构建三个示例插件，再检查类型、边界、词典和测试。浏览器改动另走一次真实操作，核对中英文、导航和未保存输入。专项探针、真实来源及播放器验证见[验证参考](development-reference.md)，按受影响链路选择即可。

修改桌面进程锁或崩溃恢复时，再运行 `bun test ./tests/probes/desktop-recovery.ts`。这项验收会实际强杀并恢复独立测试后台，等待约 30 秒，不随日常检查执行。

## 构建桌面与 Worker

```sh
bun run build:desktop -- --target linux-x64
```

支持的目标为 `windows-x64`、`linux-x64`、`macos-x64`、`macos-arm64`。默认构建当前系统目标；交叉构建仍需对应原生链接环境。脚本构建页面、原生辅助程序、rclone 和三个插件，输出 `dist/desktop/<目标>/`。首次可能下载固定版本的构建材料。

测试完整桌面后台时，运行该目录的程序，并用 `--data /tmp/musicfs-dev` 隔离数据、`--no-integration` 关闭托盘与系统自启。要看启动地址可加 `--no-open`。CLI 和远程运行见[远程指南](headless.md)。

Worker 构建：

```sh
bun run build:web
bun run build:worker
```

生成 `dist/worker/`。空参数生成空插件注册表；也可在命令后传入已经构建的插件 ZIP。日常安装在管理页完成，部署与保留云端插件的升级见[Worker 指南](worker.md)。

## 更新主程序版本

```sh
bun run version:set 0.1.0-dev.32
```

命令同步 `package.json`、中英文发行说明中的版本和全部包名，并按版本自动调整预发布标记。下载入口统一指向 GitHub Releases。插件、插件 API 和历史发行记录使用各自的版本。命令只更新文件，随后按下面的流程构建或提交发布。

## 准备一次发行

先确定版本和要分发的目标，更新对应文档，完成本次改动需要的检查，再从同一份源码顺序构建：

```sh
bun run build:desktop -- --target windows-x64
bun run build:desktop -- --target linux-x64 --skip-web
bun run build:worker dist/plugins/org.musicfs.sample.zip dist/plugins/org.musicfs.qq.zip dist/netease/org.musicfs.netease.zip
bun run build:author-kit
bun run package:release -- --targets windows-x64,linux-x64
```

按实际目标调整列表。构建完成后不再修改发行输入；有变化则重建受影响产物。输出位于 `dist/releases/<版本>/`，包含 ZIP、插件、`release-manifest.json` 和 `SHA256SUMS`。在版本目录执行 `sha256sum -c SHA256SUMS`，Windows 可用 `Get-FileHash <归档.zip> -Algorithm SHA256` 与清单核对。检查解压后的双语使用入口及作者包构建，再将对应附件和下载说明一起发布。

本地打包工具核对源码、页面和插件身份；上传由下面的 GitHub workflow 完成。桌面包、Worker 包和作者包携带各自需要的双语文档；完整设计、参考与历史证据在源码包。发行入口见[下载与升级](release.md)。

## 云端更新工具

`.github/workflows/update-musicfs.yml` 负责选择正式发行、检查构建和创建更新请求，复用 `peter-evans/create-pull-request`。`scripts/update-worker-source.ts` 只处理两个源码目录的文件更新与 Wrangler 配置合并，不调用 Cloudflare；部署仍由 `scripts/deploy-worker.ts` 负责。旧部署只复制工作流即可接入，更新工具从选定的发行标签加载。

修改更新工具时运行 `bun test tests/update-worker-source.test.ts tests/worker-deployment.test.ts tests/worker-upgrade.test.ts`。这些测试覆盖独立仓库更新、配置保留和既有插件保留；不需要访问音乐平台或新建云资源。

## GitHub 自动发行

[Build and release](../.github/workflows/release.yml) 在 GitHub 上构建 Windows x64、Linux x64、Worker、插件作者包、源码包和三个示例插件。

- 试构建：进入仓库 **Actions → Build and release → Run workflow**，选择分支。完成后从该次运行的 **Artifacts** 下载整套包，保留 7 天。
- 发布：用 `version:set` 更新版本，再提交并推送同名的 `v` 前缀标签。例如版本为 `0.1.0-dev.32` 时：

```sh
git add package.json docs/release.md docs/en/release.md
git commit -m "release: 0.1.0-dev.32"
git tag v0.1.0-dev.32
git push origin HEAD
git push origin v0.1.0-dev.32
```

标签必须与 `package.json` 一致。检查、构建和校验通过后，workflow 创建 GitHub Release 并上传全部附件；带 `-dev`、`-alpha` 等后缀的版本自动标为预发布，不替代最新正式版。发布说明由 GitHub 根据提交生成，可在 Release 页面编辑。手动运行只构建，不发布。

workflow 使用内置 `GITHUB_TOKEN`，无需新增密钥。构建在一个 Linux runner 内完成，缓存依赖和工具；Windows 原生辅助程序使用 MinGW 交叉编译。完整离线检查使用 `bun run check`，不调用音乐平台或部署 Cloudflare。macOS 仍按上面的源码构建入口使用。

GitHub 附件不保留子目录，所以自动发行采用 `--flat-plugins`，将独立插件 ZIP 放在发行目录根部，清单和 `SHA256SUMS` 同步使用这些文件名。本地默认仍放在 `plugins/` 中。下载同一版本的全部附件后，可直接运行 `sha256sum -c SHA256SUMS`。

## 从源码发行包构建

源码 ZIP 不含 `.git`、已安装依赖或用户数据。`SOURCE.md` 保存原构建身份；解压后先创建本地 Git 快照，供构建工具枚举文件：

```sh
git init
git add .
git -c user.name='Source build' -c user.email='source@musicfs.invalid' commit -m 'Import source release'
bun install --frozen-lockfile --ignore-scripts
bun run build:desktop -- --target linux-x64
```

其他目标沿用上面的构建命令。自己的修改记录、对应源码和适用许可随发行交付；MusicFS 自有代码采用 GPL-3.0-only。

## 提交修改与反馈

问题反馈附版本、系统、来源或连接方式、复现步骤和相关错误。代码改动保持一项清楚的用户结果，更新受影响的类型、示例和双语文档，在提交说明中写明改变的行为及实际检查范围。新增来源通常放在插件，来源特有的账号、音质或资料策略不进入核心。
