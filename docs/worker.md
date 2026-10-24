# 部署与升级 Cloudflare Worker

[English](en/worker.md)

Worker 版通过 HTTPS 提供同一套音乐库、管理页面和 WebDAV。可以直接在浏览器部署，也可以使用发行附件中的 Worker 包。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shengyusi-SYS/musicfs)

1. 连接 GitHub 和 Cloudflare，创建自己的仓库副本、Worker 和 D1 数据库。
2. 填写 `ADMIN_TOKEN`（首次进入管理页的令牌）、`DAV_USERNAME`、`DAV_PASSWORD`（播放器账号密码）和 `CF_API_TOKEN`。最后一项需要当前账号的 **Workers Scripts → Edit** 权限，用于在管理页安装、更新和移除插件。
3. 构建命令使用 `bun run build`，部署命令使用 `bun run deploy`，根目录保持仓库根目录。完成后打开返回的网址，用 `ADMIN_TOKEN` 进入。
4. 在「插件 → 安装插件 → 下载链接」填写自己域名下的插件地址：网易云为 `https://你的域名/plugin-packages/org.musicfs.netease.zip`，QQ 音乐为 `https://你的域名/plugin-packages/org.musicfs.qq.zip`。安装后添加来源并登录。

账号 ID 和 Worker 名称由部署工具填写，数据库迁移自动执行。来源平台的扫码登录仍在 MusicFS 中完成。官方流程见 [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

之后更新自己的仓库，沿用同一部署命令即可保留 D1、凭据和云端已安装插件，替换核心与页面。更新前先等管理页中的插件安装或移除完成。源码部署也可用 `bun run deploy --dry-run` 只组装并检查部署文件。

<a id="首次部署"></a>

## 用发行包部署

准备 Cloudflare 账号、Bun 和 Wrangler。解压 Worker 发行包；从源码生成发行目录可运行 `bun run build` 和 `bun run build:worker`。

在解压的 Worker 目录中执行：

```sh
bunx wrangler@4.119.0 login
bunx wrangler@4.119.0 d1 create musicfs
```

编辑 `wrangler.jsonc`：填写数据库的 `database_id` 和账号的 `CF_ACCOUNT_ID`；`CF_WORKER_NAME` 与配置顶层 `name` 保持相同。保留随包的模块规则、ASSETS、兼容设置和迁移目录。

准备一个位于发行目录之外的 JSON 文件：

```json
{
  "ADMIN_TOKEN": "your-management-token",
  "DAV_USERNAME": "musicfs",
  "DAV_PASSWORD": "your-reader-password",
  "CF_API_TOKEN": "your-worker-publishing-token"
}
```

前三项分别用于首次进入管理页及播放器读取。`CF_API_TOKEN` 用于 Worker 在管理页安装、更新或移除插件时发布代码；创建目标账号的 **Account → Workers Scripts → Edit** Token 即可。Wrangler 登录用于本机部署，不能替代云端运行时的发布凭据。

应用包内全部迁移，再部署：

```sh
bunx wrangler@4.119.0 d1 migrations apply musicfs --remote
bunx wrangler@4.119.0 deploy --secrets-file /absolute/path/to/musicfs-secrets.json
```

打开命令返回的域名，使用 `ADMIN_TOKEN` 进入，在「设置 → 登录账号」按需创建管理账号。然后安装插件、添加来源并登录，日常流程见[使用指南](user-guide.md)。

播放器使用 `https://你的域名/dav/` 和读取凭据，管理页也可生成导入二维码。管理账号、读取凭据、来源平台授权分别设置。

## 日常运行

- **插件安装：** 在管理页上传 ZIP 或填下载链接，等后台进度完成。使用者无需重新编译核心或重新运行 Wrangler。
- **更新内容：** 来源和目录复用持久任务，页面关闭或重开不会丢失进度。已有内容在更新期间继续可读。
- **关页后继续：** 默认每分钟 Cron 推进一步，优先处理插件变更，再处理目录工作；保持页面打开可持续推进。若不需要关页续跑，可将 `triggers.crons` 设为 `[]`，之后重开页面继续。
- **缓存与费用：** 音乐资料保存在 D1，音频正文按需流式读取；播放器或 OpenList 可自行缓存。请求量取决于刷新、扫描与实际播放，定时范围按自己需要设置。

两宿主共用插件和文件合同，Worker 按单次调用预算分页。免费计划的大目录与 CPU 范围见源码中的验收台账；付费账号已有部署记录不代表免费配额实测。

## 升级核心与 WebUI，保留云端插件

管理页安装后的云端插件可能不同于最初的本地包。升级使用同版本完整源码包中的组装工具，读取原 Worker 的精确插件模块，再替换核心和页面；原 D1、配置和 Secrets 继续使用。

在源码目录安装锁定依赖，等现有插件变更完成后执行。通过 `CF_API_TOKEN` 或 `CLOUDFLARE_API_TOKEN` 环境变量提供已有发布 Token：

```sh
bun run build:web
bun scripts/build-worker-upgrade.ts \
  --config /absolute/path/to/existing/wrangler.jsonc \
  --out /absolute/path/to/musicfs-upgrade
```

新目录与原配置目录分开。工具只准备文件，不自动部署。使用新目录中的全部迁移更新原数据库，然后部署：

```sh
bunx wrangler@4.119.0 d1 migrations apply musicfs --remote \
  --config /absolute/path/to/musicfs-upgrade/wrangler.jsonc
bunx wrangler@4.119.0 deploy \
  --config /absolute/path/to/musicfs-upgrade/wrangler.jsonc \
  --keep-vars --autoconfig=false
```

`--keep-vars` 保留现有变量，Secrets 继续保留。[Wrangler 部署选项](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)

升级期间完成这一组装和部署后，再继续管理页中的插件变更。打开新页面确认实例与目录仍在，并读取一个已有文件即可。

## 部署包中的文件

| 文件 | 用途 |
|---|---|
| `worker.mjs`、`core.mjs`、`registry.mjs` | 入口、共用核心、当前可执行插件注册表 |
| `plugins/<修订>/…` | 已预载的插件模块；安装激活仍通过管理页完成 |
| `plugin-packages/` | 构建时选入的原插件 ZIP，可用于管理页安装 |
| `bundle.json` | 精确模块、插件及源码身份 |
| `web/` | 共用管理页面 |
| `migrations/` | 按顺序应用的 D1 迁移 |
| `wrangler.jsonc` | Worker 名称、DB、ASSETS、Cron 与兼容设置 |

## 常见问题与备份

| 现象 | 检查 |
|---|---|
| 安装显示未配置发布能力 | 核对 `CF_API_TOKEN`、账号和 Worker 名称 |
| 插件停在安装或迁移中 | 查看插件页进度；重新打开页面会继续原操作 |
| 新目录首次暂时不可用 | 在音乐库查看刷新或文件准备进度，完成后重试播放器 |
| 升级后提示数据库字段缺失 | 对同一 D1 应用新版包内的全部迁移 |

备份 D1：

```sh
bunx wrangler@4.119.0 d1 export musicfs --remote --output /absolute/path/to/musicfs-backup.sql
```

[D1 导出命令](https://developers.cloudflare.com/d1/wrangler-commands/#d1-export)

同时保存部署配置、Secrets 的自有副本和插件发布包。D1 保存实例与目录，插件可执行代码随 Worker 发布；二者一起保留才能恢复完整安装。核心开发和离线验证见[开发指南](development.md)。
