# Compatibility and verification scope

[简体中文](../verification.md)

This page summarizes representative checks. Development checks and specialist probes are listed in the [Chinese verification guide](../development-reference.md).

## Platforms

| Runtime | Existing verification | Conditions or remaining scope |
|---|---|---|
| Windows x64 app | Tray, management login, startup registration, background mount restore, labels and file reads | App mounts require WinFsp; the package includes installation guidance. Ordinary-user UAC interaction has not been fully verified. |
| Linux / WSL | Compiled app, HTTP, rclone/FUSE mounts and range reads | System FUSE is required. Native Linux graphical tray interaction remains unverified. |
| macOS | Build entry points and earlier cross-compilation checks | Native execution, mounts and graphical interaction remain unverified. |
| Cloudflare Worker | Wrangler deployment, login, plugin changes, core upgrades and limited real-source reads | Cloud results used a paid account. Free-plan CPU, large-library resources and the native deploy-button dashboard form remain unverified. |
| Native Windows WebDAV | Local HTTPS mapping, a 64MiB read and restoration of system settings | Its file-size limit differs from WinFsp mounts; see the [desktop guide](desktop.md). |

## Sources and audio metadata

The NetEase and QQ examples have real QR authorization, session persistence and limited content-read evidence. Login channels, content, quality and playback rights belong to the provider.

| Format | Existing implementation and evidence | Scope |
|---|---|---|
| MP3 | Real songs from both examples, tag parsing, full and range reads | Basic metadata, artwork and lyrics depend on source data. |
| FLAC | Generated tag fixtures, segment reads and Windows / WSL lazy mounts | Not every real provider file has been tested. |
| M4A | Ordinary front/end `moov`, local Worker/DAV and Windows / WSL lazy mounts | Fragmented MP4 and other special layouts are unsupported. |
| APE | Structural fixtures, an official small sample and WSL read experiments | Real QQ APE and Windows lazy mounts remain unverified. The NetEase example does not export APE. |

NetEase MP3, FLAC and M4A use an exact reserved representation so directories can appear before per-song tagging. Exported files include padding, normally adding 1MiB. Metadata exceeding the budget requires a refreshed exact representation. QQ still prepares files while paging. See the [tagging design, Chinese](../architecture/audio-tags.md) and [format toolkit](../../packages/audio-tags/README.md).

Existing lyric timing, translations and romanization are preserved. Embedded fields and player presentation are separate: synchronized lyrics and similar displays depend on the player.

## Clients and cache

Representative rclone/WinFsp, WSL/FUSE, OpenList and mpv checks cover listing, HEAD, single-range reads or seeking. Full-library scraping, lyric UI and offline caching depend on the client.

App-local mounts and direct desktop WebDAV have separate read-byte caches. Worker streams from the source. Uncached audio still requires a source connection; a mounted drive is not a complete offline library. Directory refresh timing does not measure player scanning.

## Historical evidence

Earlier records, raw data and screenshots remain in [Git history](https://github.com/shengyusi-SYS/musicfs/tree/b637d4d19da97e3473942be9ad7925b740afd47a/docs/verification). Current documentation keeps conclusions useful for choosing and using MusicFS.
