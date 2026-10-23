# Downloads and upgrades

[简体中文](../release.md)

Current source is **0.1.0-dev.31**, including bilingual UI and headless access. The latest archived release remains **0.1.0-dev.30**; a stable release has not been published.

## Choose a package

| Goal | Download |
|---|---|
| Use on Windows | [Windows x64](../../dist/releases/0.1.0-dev.30/musicfs-0.1.0-dev.30-windows-x64.zip) |
| Deploy Cloudflare Worker | [Worker package](../../dist/releases/0.1.0-dev.30/musicfs-0.1.0-dev.30-worker.zip) |
| Develop a source plugin | [Author kit](../../dist/releases/0.1.0-dev.30/musicfs-0.1.0-dev.30-plugin-author-kit.zip) |
| Modify or build MusicFS | [Complete source](../../dist/releases/0.1.0-dev.30/musicfs-0.1.0-dev.30-source.zip) |

These downloads are dev.30 and do not include dev.31 localization. The latest Linux prebuilt package is [dev.14 x64](../../dist/releases/0.1.0-dev.14/musicfs-0.1.0-dev.14-linux-x64.zip); [build current source](development.md#build-desktop-and-worker) for newer features. macOS currently has a source-build entry.

Plugin ZIPs are in `plugins/`. Package identities and checksums are in the [manifest](../../dist/releases/0.1.0-dev.30/release-manifest.json) and [SHA256SUMS](../../dist/releases/0.1.0-dev.30/SHA256SUMS).

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
