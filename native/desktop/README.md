# MusicFS desktop helper

Small native companion for the existing Bun backend. It contains no HTTP server,
music-source code, credentials or browser UI.

## Interface

- `desktop-helper tray`: newline-delimited JSON on stdout: `{"type":"ready"}`,
  then `{"type":"action","action":"open"|"phone"|"quit"}`. Keep stdin open while
  the parent is alive; closing the pipe removes the tray and exits. The backend
  decides what each action does, including whether quitting is currently possible.
- `desktop-helper autostart`: reads one JSON object from stdin:
  `{"enabled":true,"command":["/path/to/MusicFS","--autostart"]}`. Returns exit 0
  after updating this user's registration. Enabling again updates the executable
  path after an extracted-release upgrade.
- Windows `desktop-helper open-url`: reads a JSON URL string from stdin and uses
  the system URL handler via windows-sys/ShellExecuteW, without PowerShell or cmd.
  The launcher and tray actions both use it. URL/ticket data is not put in argv.

The Bun API is `startDesktopIntegration({resourcesDirectory,onAction,onError?})`,
which resolves to `{close(): Promise<void>}`, and
`setDesktopAutostart({resourcesDirectory,enabled,command})`. Both are asynchronous.
The packaged helper lives at `resources/desktop-helper` (`.exe` on Windows).

Release packaging calls `writeDesktopNativeLicenses({target,outputDirectory})`
from the build script with `licenses/desktop-helper` as its destination. It selects
the locked Cargo target graph offline and copies only license/notice documents
from the already-downloaded crate cache, plus an SPDX/name/version index. It also
copies the installed Rust standard-library notices and the cached MinGW runtime
notices for GNU Windows builds. Materials absent from the installed toolchain are
recorded in the index; license collection never downloads a source repository.

## Platform boundaries

| Platform | Tray | Login startup |
| --- | --- | --- |
| Linux | tray-icon KSNI over session D-Bus; no GTK | auto-launch's user XDG Autostart entry, with Exec argument encoding |
| Windows | tray-icon and tao event loop; left double click opens, right click shows menu; GUI subsystem | windows-registry, only the MusicFS value in HKCU Run |
| macOS | tray-icon created inside tao's main-thread event loop; accessory app | plist serializer and dirs, user LaunchAgent with ProgramArguments array |

`auto-launch 0.6.0` does not quote executable paths or arguments for Windows/Linux.
Its Windows disable operation also checks HKLM, and its macOS XML interpolation
does not escape path characters. Therefore it is only used for the Linux entry;
the other platforms reuse typed registry/plist libraries at their OS boundary.
Linux's dependency writes `~/.config/autostart`; custom `XDG_CONFIG_HOME` is not
supported by that dependency. Showing a Linux tray still needs a desktop SNI host.

## Build

```sh
bun run scripts/build-desktop-native.ts --target linux-x64 --output dist/native/linux-x64/desktop-helper
bun run scripts/build-desktop-native.ts --target windows-x64 --output dist/native/windows-x64/desktop-helper.exe
bun run scripts/build-desktop-native.ts --target macos-arm64 --output dist/native/macos-arm64/desktop-helper
```

`macos-x64` is also supported. Cargo.lock pins dependencies. The build script accepts
`--linker /absolute/path/to/linker` for an already-configured cross toolchain; it does
not install an SDK or call Windows host programs. Linux uses the musl target and
links statically. Windows defaults to MSVC on Windows and GNU/MinGW on other hosts;
`--windows-toolchain gnu|msvc` can select explicitly. The WSL build also recognizes
an extracted MinGW toolchain at `dist/tools/mingw/usr/bin` without a system install.
MSVC needs its linker/SDK; macOS releases need the Apple SDK and matching Rust target. `cargo check --target`
validates Rust code, not the presence of a usable packaged executable or system tray.

Narrow checks: `bun test tests/desktop-integration.test.ts` and
`cargo test --locked --manifest-path native/desktop/Cargo.toml`. These do not enable
actual login startup or contact a music platform.
