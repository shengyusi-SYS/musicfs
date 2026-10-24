# Desktop service, mounts and backups

[简体中文](../desktop.md)

MusicFS runs a background service on your computer and uses a browser to manage it. Start with the [user guide](user-guide.md) or [player connections](clients.md).

## Open, reopen and quit

Extract the complete package. Open `MusicFS.exe` on Windows or run `musicfs` on Linux. Management opens signed in. Closing the page leaves the service and mounts running; running the app again reuses that service.

Double-click the Windows tray icon to open management. Its menu also provides mobile access and quitting. If quitting reports that a file is busy, close the player or copy operation using it and try again.

**Settings → Startup & mounts** controls:

| Setting | Default |
|---|---|
| Start at login | On |
| Open management on a manual launch | On |
| Open management at login | Off; stay quiet |
| Restore automatic mounts | On |
| Retry temporary mount failures | On |

Mount restoration runs in the background and retries at most three times when enabled. The page remains available. Launching a new extracted version updates its login-startup location. Linux trays need a desktop with StatusNotifier support.

For NAS or SSH use, see [remote mode](headless.md). `--language en` or `--language zh-CN` sets terminal and tray language; browsers remember their own language separately.

## Sign-in and separate network access

Opening the app signs you in locally. Create a password in **Settings → Login account** when needed. To recover management access, run the app again and change the account from settings.

| Goal | Setting |
|---|---|
| Manage from another computer or phone | Settings → Management page access |
| Let a player read music | Connect → WebDAV player |

Each entry has its own access scope and port; both start as local-only. Enable only WebDAV when all you need is player access. Port 0 chooses an available port. Changing the management port does not move WebDAV; update clients if you change the WebDAV port.

**Service actions → Mobile access** signs a browser into management. **Scan to import** on the WebDAV page exports the reader username and password. Both let you select a reachable network address.

## Mount a drive

In **Connect → Disk mounts**, add the current MusicFS or a remote WebDAV URL and credentials. The page names the machine receiving the mount.

| System | Setup |
|---|---|
| Windows | Install WinFsp from the prompt; choose a free drive letter such as `M:` or leave it empty |
| Linux | Prepare FUSE, `/dev/fuse` and `fusermount3` or `fusermount`; choose an empty folder |
| macOS | Build from source; mounting uses system NFS tools and permissions |

The default name is MusicFS. Set a custom name when adding or rename an existing mount from its menu. Automatic mounting is saved per mount. **Unmount** stops this session, **Remove mount** deletes its definition and cache, and **Remount** reuses its settings.

Folder and audio caches are available in the mount menu. Editing or clearing an active mount's cache remounts it normally. Direct WebDAV read caching is managed separately on the WebDAV page. [Cache controls](user-guide.md#update-music-and-manage-caches)

## Windows Explorer mapping

For Explorer's **Map network drive**, open **WebDAV players → Windows Explorer native mapping**:

1. Enable local HTTPS.
2. Choose **Set up Windows connection** and accept the system permission prompt.
3. Enter the displayed HTTPS address and reader credentials in Explorer.

Setup trusts this data directory's local certificate, starts WebClient and, when needed, raises its single-file limit from 50,000,000 bytes to 4 GiB minus 1 byte. This setting affects native WebDAV connections on that computer and reconnects WebClient when applied. **Restore original file limit** restores the value MusicFS saved. Quitting or disabling HTTPS leaves the limit setting in place.

Local HTTPS is for the machine running MusicFS. LAN players use the LAN address. The app's rclone/WinFsp mount accepts HTTP/HTTPS and is not subject to that native file limit.

## Data, backups and help

Run with `--headless` or `--no-open` to see the data directory. Use `--data /your/directory` to choose one. The default is the current user's system application-data directory, separate from the extracted program.

Quit normally and copy the entire data directory to back up accounts, plugins, folders, connections and mount settings. Restore it and use `--data` to select it. Audio fragments are optional backup contents; copy or download complete songs separately.

| Symptom | Next step |
|---|---|
| Management page was closed | Run the app again or double-click the Windows tray icon |
| Mount fails | Read its error, check WinFsp/FUSE and the chosen location, then remount |
| Another device cannot connect | Check the relevant entry's LAN setting and reachable address |
| Source needs sign-in | Sign in to that source again; QQ and WeChat may hold different libraries |
| Startup fails | Inspect `startup.log` and `launcher.log` in the data directory |
| WebDAV or background reads fail | Inspect `logs/musicfs.log` and match the error ID when available |
| Mount reads fail | Inspect `mounts/rclone.log` in the data directory |

When reporting a problem, include MusicFS and plugin versions, system, connection method, steps and the relevant error.

Use **Settings → Logs and diagnostics** to change application or mount logging immediately and download a diagnostic ZIP. See [IO diagnostics](logging.md).
