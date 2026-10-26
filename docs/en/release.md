# Downloads and upgrades

[简体中文](../release.md)

<!-- release-version -->
Current version: **0.1.1**.

## Choose a package

Published attachments are available from [GitHub Releases](https://github.com/shengyusi-SYS/musicfs/releases). Use the filenames below to choose a package, or follow the [source development guide](development.md).

| Goal | Package |
|---|---|
| Use on Linux | `musicfs-0.1.1-linux-x64.zip` |
| Use on Windows | `musicfs-0.1.1-windows-x64.zip` |
| Deploy Cloudflare Worker | `musicfs-0.1.1-worker.zip` |
| Develop a source plugin | `musicfs-0.1.1-plugin-author-kit.zip` |
| Modify or build MusicFS | `musicfs-0.1.1-source.zip` |

Windows x64 and Linux x64 are built from the same source. macOS currently has a source-build entry.

Desktop packages include a `plugins/` folder. Standalone plugins are separate Release attachments. Package identities and checksums are in `release-manifest.json` and `SHA256SUMS`.

Pushing a version tag builds and publishes the package set through GitHub Actions. [Maintainer instructions](development.md#github-releases)

## First use

Extract the complete desktop package, keeping `resources/` and `plugins/` beside the program. Open `MusicFS.exe` on Windows or run `musicfs` on Linux, then follow the [user guide](user-guide.md). Users do not need Bun or Node.

Use the [Worker guide](worker.md) for hosting or the [author guide](plugin-authoring.md) for a new source.

## Upgrade

1. Quit MusicFS normally from the tray or management page.
2. Extract a complete new version and launch it.
3. Keep the same `--data` directory if you selected one. Accounts, folders and settings remain there.
4. Install newer plugin ZIPs from **Plugins** when needed. Upgrade MusicFS first if a plugin requires a newer host API.

Upgrading from a shared-port version keeps the old address for WebDAV where possible; reopen management through the launcher. Worker upgrades retain the original D1 and exact cloud plugin modules using the [upgrade workflow](worker.md#upgrade-the-core-and-webui-while-retaining-plugins).

[Backups](desktop.md#data-backups-and-help) · [Release history, Chinese](../release-history.md) · [Verification record, Chinese](../verification.md)
