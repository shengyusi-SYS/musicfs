# 下载与升级

[English](en/release.md)

当前源码为 **0.1.0-dev.31**，已加入中英文界面和无桌面访问。最近归档仍是 **0.1.0-dev.30**；正式版尚未发布。

## 选择下载

| 你要做什么 | 下载 |
|---|---|
| 在 Windows 上使用 | [Windows x64](../dist/releases/0.1.0-dev.30/musicfs-0.1.0-dev.30-windows-x64.zip) |
| 部署 Cloudflare Worker | [Worker 部署包](../dist/releases/0.1.0-dev.30/musicfs-0.1.0-dev.30-worker.zip) |
| 编写自己的来源插件 | [插件作者包](../dist/releases/0.1.0-dev.30/musicfs-0.1.0-dev.30-plugin-author-kit.zip) |
| 修改或构建 MusicFS | [完整源码](../dist/releases/0.1.0-dev.30/musicfs-0.1.0-dev.30-source.zip) |

这些下载对应 dev.30，不包含 dev.31 的双语改造。Linux 最近的预构建包是 [dev.14 x64](../dist/releases/0.1.0-dev.14/musicfs-0.1.0-dev.14-linux-x64.zip)；使用最新功能可从当前源码[构建](development.md#构建桌面与-worker)。macOS 目前提供构建入口。

版本内的插件 ZIP 在 `plugins/` 目录中；各包内容和摘要见[发行清单](../dist/releases/0.1.0-dev.30/release-manifest.json)、[SHA256SUMS](../dist/releases/0.1.0-dev.30/SHA256SUMS)。

## 首次使用

完整解压桌面包，保留程序旁的 `resources/` 和 `plugins/`。Windows 打开 `MusicFS.exe`，Linux 运行 `musicfs`，按[使用指南](user-guide.md)添加来源和连接播放器。普通使用无需安装 Bun 或 Node。

Worker 部署从[部署指南](worker.md)开始。插件作者从[作者指南](plugin-authoring.md)开始。

## 升级已有安装

1. 从托盘或管理页正常退出 MusicFS。
2. 将新版解压到完整的新目录，运行其中的启动程序。
3. 使用过 `--data` 时继续指定同一数据目录。账号、目录和设置会保留。
4. 在「插件」中按需安装随新版提供的插件 ZIP。插件要求更高宿主版本时，先升级 MusicFS。

由旧共享端口版本升级时，旧地址优先保留给 WebDAV；管理页面从启动器重新打开。Worker 升级会保留原 D1 与精确插件模块，按[核心升级步骤](worker.md#升级核心与-webui保留云端插件)操作。

备份位置见[桌面指南](desktop.md#数据备份与常见问题)。历史下载、构建与实测范围分别见[发行历史](release-history.md)和[验收台账](verification.md)。
