# Use MusicFS

[简体中文](../user-guide.md)

Connect a source, browse its music, then use it with your favorite player.

## Open MusicFS

Extract the complete desktop package. Open `MusicFS.exe` on Windows or run `musicfs` on Linux. The browser opens management and signs you in. Available packages are listed on the download page.

Closing the browser leaves the service and mounts running. Double-click the Windows tray icon or run MusicFS again to reopen management. By default, manual launches open the page and login startup stays quiet. Change these in **Settings → Startup & mounts**.

Use [remote mode](headless.md) for a NAS, server or SSH session. The language button switches between English and Simplified Chinese without clearing your current input.

## Sign in and manage from a phone

Create a management account in **Settings → Login account** when you need password sign-in. **Remember me** uses a 30-day session. Signing out ends this browser session; music and mounts keep running.

For phone management, connect to the same network, allow **LAN devices** in **Settings → Management page access**, then open **Service actions → Mobile access**. Scan the code. Choose a reachable address if the machine has several network interfaces, and refresh the QR code for another sign-in.

## Add a music source

1. In **Library**, choose **Add source**. If you have no plugin, the installer opens first.
2. Select a plugin ZIP from the package's `plugins/` folder, or paste a direct plugin download link. Install it after the automatic check.
3. Give the source a name, choose its settings and select **Add & sign in**.
4. Complete the plugin's QR, link or input step, then browse its content.

You can create several sources from one plugin, with separate accounts and quality settings. For QQ Music, choose the QQ or WeChat sign-in method that holds your music.

Source settings change its configuration. The source menu lets you sign in again, sign out of that source, or delete it. Signing out preserves its configuration and player-folder references.

## Browse and arrange

Choose a source or playlist in the left tree; the center shows its contents. Open **Player folders** to arrange the folders your players see. Drag the divider to resize it; small windows use drawers.

The arrow expands a tree node, while the name opens its contents. Search filters the current folder. Returning to a recent folder restores your search, selection, page and scroll position. Browser history and reload retain the current location.

To arrange music:

- Drag source entries, individual playlists or albums into a player folder. A multi-selection can be added together. **Add to…** also lets you choose or create a destination.
- Create folders from the player-folder header. Rename from the menu or by double-clicking a folder name.
- Drop in the middle to move inside a folder, or at its upper/lower edge to reorder. The menu offers the same move and reorder actions.
- Use undo, redo and **Save folders** at the bottom. **Save & connect** saves first, then takes you to the connection page.

Unsaved changes survive navigation between pages. Use the player-folder menu to return to automatic arrangement by source and save the result. Removing a folder reference leaves the original music source intact.

## Use a local player

Open **Connect → Disk mounts → Add mount**. The page names the machine where the mount will appear.

Windows can assign a drive letter automatically; install WinFsp from the prompt on first use. On Linux, prepare FUSE and choose an empty directory. See [desktop details](desktop.md) for platform setup.

Add the resulting drive or folder to your player or library scanner. You can also copy songs from it to a local folder.

Each mount has its own automatic-start switch. **Unmount** stops this session; **Remove mount** deletes its saved connection and cache. The menu also offers remounting and cache settings. Startup restoration happens in the background, with bounded retries when enabled.

To mount a remote MusicFS or another WebDAV server, choose **Remote WebDAV** and enter its address and credentials.

## Connect a WebDAV player

Open **Connect → WebDAV players** and copy the address, username and password into your player. You can customize the reader credentials or use **Scan to import**, which includes them in a connection URL for players that accept that format.

For another device, allow **LAN devices** on this WebDAV page and select its reachable address. Management access may stay local. The two services have separate ports and credentials. Update existing players after changing the WebDAV address or password.

OpenList, scanning and download workflows are covered in [player connections](clients.md). Windows Explorer mapping uses the app's local HTTPS connection setup; see [desktop details](desktop.md#windows-explorer-mapping).

## Update music and manage caches

Choose a source and **Refresh** for all its contents, or choose a folder to update that folder. Existing contents remain available during refresh.

In a source or folder's **Settings → Automatic updates**, choose a daily time, weekdays or an interval, and select the scope. Manage rules together from the main **Settings → Automatic updates** page. The background service continues after the browser closes.

To fetch covers, lyrics and other music information again, use **Refresh music metadata** from the song folder's update menu. Normal refresh reuses available metadata.

| Where | What it controls |
|---|---|
| Mount menu → Cache settings | Folder cache and this mount's audio-fragment cache |
| WebDAV player → WebDAV read cache | Shared fragments for direct desktop WebDAV clients |
| Source settings | Metadata retention offered by that plugin |

Local mount listings default to one year; remote listings to one month. Local content changes refresh the affected mount listing. Audio fragments and example-plugin metadata default to one year, subject to capacity limits. Existing custom retention choices are preserved on upgrade.

A capacity of 0 stops new audio caching; an age of 0 disables age-based eviction. Changing or clearing an active mount's cache remounts it normally. Changing metadata retention affects future fetches; use the metadata refresh action when you want new data now. Download or copy complete files for offline use.

## Customize filenames

Open a source or folder's **Settings → File naming**, choose a custom template and preview a pattern such as `{{title}} - {{artist}}`. Field buttons insert supported metadata; MusicFS appends the extension.

Apply the preview when it looks right. A folder can inherit its source's policy or use its own. Changing paths can make players scan them again; omitting the playlist index reduces renames when songs are inserted or removed.

## Update and back up

Install a new plugin ZIP from its menu on **Plugins**. For the desktop app, quit normally, extract the complete new version and launch it. Keep the same `--data` directory if you use one. Upgrade MusicFS first when a plugin requires a newer API.

For data locations and backups, see [desktop details](desktop.md#data-backups-and-help). For cloud hosting, see [Worker deployment](worker.md). To create a source plugin, use the [author guide](plugin-authoring.md).
