# MusicFS

> This project is only a conversion and adaptation tool. It does not provide membership benefits or copyrighted content.
>
> In development. Testing, compatibility, performance and cost optimization need further work. Feedback is welcome.

[简体中文](README.md)

**Your online music, as local files.**

MusicFS turns music sources into read-only folders. Mount them as a drive for your favorite local player, connect a phone player over WebDAV, scan them into a music library, or copy songs for offline listening.

[Downloads](docs/en/release.md) · [User guide](docs/en/user-guide.md) · [Player connections](docs/en/clients.md)

## Get started

1. Extract the complete desktop package. Open `MusicFS.exe` on Windows or run `musicfs` on Linux.
2. In **Library → Add source**, install a bundled plugin from the `plugins` folder.
3. Add your music account, choose its quality settings, and scan the login QR code.
4. Browse the source, or drag playlists and albums into your player folders.
5. Open **Connect** to mount your music or copy the WebDAV details into a player.

Windows mounts use WinFsp, with an installer available in the app. Linux mounts use FUSE. MusicFS keeps running when you close the browser; use the tray or run it again to reopen management.

The interface supports English and Simplified Chinese. Use the language button to switch. Your song names, playlists and saved folders stay as they are.

## Your sources, your players

The bundled NetEase Cloud Music and QQ Music plugins support personal playlists, liked songs and recommendations. Each source has its own account and quality settings. Other providers can be added through plugins without rebuilding MusicFS.

The example plugins also supply music tags, covers and lyrics in supported audio formats. Read audio fragments are cached, playlists can update on a schedule, and filename templates let you choose how songs appear to your players.

The desktop cache uses sparse files. On Windows, **Size** may be much larger than **Size on disk**; use **Size on disk** to check actual disk usage.

Running on a NAS or over SSH? Use `./musicfs --headless --language en` for access URLs and a login link. Management and WebDAV have separate access settings and ports. [Remote use](docs/en/headless.md)

MusicFS can also run on Cloudflare Workers with the same management interface. [Worker deployment](docs/en/worker.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shengyusi-SYS/musicfs)

Connect GitHub and Cloudflare, then enter a management token, WebDAV credentials and a plugin publishing token. The database is created automatically.

## Keep exploring

[Development](docs/en/development.md) · [Documentation](docs/en/README.md)

## Build your own source

Start with the [plugin author guide](docs/en/plugin-authoring.md), or explore the [architecture](docs/en/architecture.md). Plugins can provide their own display translations.

## License

[GPL-3.0-only](LICENSE)
