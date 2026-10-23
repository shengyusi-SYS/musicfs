# Connect players and music libraries

[简体中文](../clients.md)

Add a source and sign in in **Library**, then choose how your player reads files.

| Use case | Connection |
|---|---|
| A player or scanner that accepts local paths | Create a disk mount, then add its drive or folder |
| A WebDAV player | Copy the connection details or scan the import code |
| OpenList | Add WebDAV storage with proxy reading |
| Offline copies or downloads | Copy from the mounted folder or download over WebDAV |

## A local drive

Open **Connect → Disk mounts** and add a mount. Windows can assign a drive letter and offers WinFsp installation. Linux needs FUSE and an empty mount directory. Add the resulting path to your player or scanner.

The mount appears on the machine running MusicFS. Managing a NAS or WSL from a Windows browser does not create a Windows drive. Run the Windows app for a Windows mount; it can also mount a remote WebDAV service.

Windows Explorer mapping is a separate option using the app's local HTTPS setup. See [desktop details](desktop.md#windows-explorer-mapping). The app's disk mount is the usual starting point.

## A WebDAV player

1. Open **Connect → WebDAV players**.
2. Copy the full address, username and password into the player, or choose **Scan to import**. The QR code contains the reader credentials for players accepting that URL format.
3. For another device, enable **LAN devices** on this page and choose a reachable address. Management may remain local.

Use the reader credentials shown here. The management account and music-platform sign-in serve different purposes. Update existing players after changing the reader credentials.

`127.0.0.1` inside a different computer, NAS or container refers to that environment itself. Use a MusicFS address reachable from the client. A Worker uses its HTTPS domain and `/dav/` path.

## OpenList

In OpenList, add a storage using the **WebDAV** driver:

| Field | Value |
|---|---|
| Mount path | Your choice, for example `/Music` |
| Address | The full WebDAV address from MusicFS |
| Username and password | MusicFS reader credentials |
| Root folder | `/`, or the desired subfolder |
| Vendor | Other |
| Web proxy | Enabled |
| WebDAV policy | Local proxy |

OpenList then holds the credentials and proxies audio for browsing, playback and downloads. [OpenList WebDAV documentation](https://doc.oplist.org/guide/drivers/webdav)

## Scanning, scraping and offline files

Folders load on demand. With the NetEase example, MP3, FLAC and M4A listings are ready to connect after loading; metadata is added on the first track read. Other sources or formats may show **Prepare files** first; finish that step before scanning. A scanner reading every track's tags still prepares each track on its first read.

Scanners can read embedded titles, artists, albums, covers and lyrics. Display of synchronized lyrics, translations and multiple artists depends on the player. Preview custom names in a source or folder's **Settings → File naming**.

Mounted music is read-only. Copy or download files to a local folder before using a scraper that writes tags, cover files or new names.

Fragment caches help repeat reads. For offline use, download complete files rather than relying on a mounted path. [Cache settings](user-guide.md#update-music-and-manage-caches)

## Stale contents or first-open waits

Update the source or folder in MusicFS, then refresh the client's listing cache. In OpenList, use its own **Refresh** action; reloading the browser may still show cached listings.

Some clients report a temporary error while a new folder is prepared. Check refresh or preparation progress in MusicFS, then refresh the client or retry its scan. Existing contents stay readable during background updates.
