# Run on a NAS or remote machine

[简体中文](../headless.md)

Extract the Linux package and run on that machine:

```sh
./musicfs --headless --language en
```

The terminal prints management and WebDAV addresses, the data directory, and a single-use login link valid for three minutes. Linux without a graphical session and SSH launches use headless behavior automatically. The background keeps running after SSH closes; it does not register a tray or desktop login startup.

## Open management for the first time

Both entries initially listen only on the MusicFS machine. Copy the SSH-forwarding command printed in the terminal, replace the SSH destination, and run it on your own computer. Keep that connection open and use the login link.

For example, if management uses port 39123:

```sh
ssh -N -L 39123:127.0.0.1:39123 user@my-nas
```

This forwards management only. If the local port is busy, use `-L 8787:127.0.0.1:39123` and change the login link's port to 8787.

Install plugins, sign in to music sources and arrange folders from your own browser. Source QR codes appear there; the server needs no display. Create a management account in **Settings → Login account** when you want password sign-in.

## Allow direct LAN access

For management:

```sh
./musicfs --headless --management-access lan --management-port 8787 --language en
```

Open a LAN login link printed by the terminal. For player access, enable WebDAV separately:

```sh
./musicfs --headless --dav-access lan --dav-port 8788 --language en
```

Copy the WebDAV address and credentials from **Connect → WebDAV players**. Enabling only WebDAV leaves management local.

These options also update an existing service and preserve unspecified settings. Management and WebDAV need different ports. Port 0 selects an available port and reuses it on later starts where possible. Recreate the SSH forward if you change its backend port.

## Return, mount and stop

- For an expired or used login link, run the command again. It reuses the service and issues a new link. Keep the same `--data` directory; the terminal prints a complete command for reopening it.
- A disk mount appears on the named backend machine. Use a WebDAV player on your own computer, or run your local MusicFS to mount that remote WebDAV service.
- Stop through **Service actions → Quit MusicFS**. Closing a browser or SSH session leaves the background running.

## Use a service manager

Run `./musicfs --foreground --data /your/data/directory --language en`. The process stays in the foreground; Ctrl+C or SIGTERM stops it normally. A service manager such as systemd can own this command and its fixed data directory. MusicFS restores saved mounts in the background after startup.

If that directory already has a running service, foreground mode displays the existing entry and exits. See `./musicfs --help` for all options. Browser language is independent of the terminal language.
