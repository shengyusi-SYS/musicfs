# Develop MusicFS

[简体中文](../development.md)

MusicFS consists of a common core, WebUI, desktop and Worker hosts, and independent source plugins. For another data source, start with the [plugin author guide](plugin-authoring.md). For application changes, use this workflow.

## Set up

Use the Bun version fixed in `package.json`, currently 1.4.3. Type and dependency checks use Node 24; source and release tools use Git. Desktop native builds also need Rust/Cargo and the target toolchain. [Native helper setup](../../native/desktop/README.md)

```sh
bun install --frozen-lockfile --ignore-scripts
```

## Start local development

In the first terminal:

```sh
bun run build:web
bun run build:sample
export MUSICFS_ADMIN_TOKEN=local-development-token
export MUSICFS_DAV_PASSWORD=local-reader-password
bun run dev:service
```

In Windows PowerShell, replace the two `export` lines with:

```powershell
$env:MUSICFS_ADMIN_TOKEN="local-development-token"
$env:MUSICFS_DAV_PASSWORD="local-reader-password"
```

Open `http://127.0.0.1:8787/` and enter the management token above. Data is stored in `dist/dev-data`; the reader username is `musicfs`. Install `dist/plugins/org.musicfs.sample.zip` to browse and read a sample without a music account.

For frontend editing, use a second terminal:

```sh
bun run dev:web
```

Open `http://127.0.0.1:5173/`. Vite proxies requests to the test backend. This development service provides common features; it does not register a tray, login startup or system mount. Use a built desktop artifact for those paths.

## Find the owner

| Change | Entry |
|---|---|
| Pages, forms and workspace | `src/web` |
| Domain logic | `src/core/extensions`, `sources`, `library` |
| Management HTTP and read-only DAV | `src/transport`; [API reference](management-api.md) |
| Desktop listeners, tray and mounts | `src/hosts/desktop`, `native/desktop` |
| Worker, D1 and plugin publication | `src/hosts/worker`, `src/worker.ts` |
| Plugin types, examples and tagging tools | `packages/plugin-api`, `plugins`, `packages/audio-tags` |

Dependencies flow `library → sources → extensions`. Plugins use public types; hosts adapt storage and execution from outside the core. [Architecture](architecture.md)

Append database migrations rather than rewriting applied ones, and check shared SQLite/D1 semantics. Add UI messages to both `src/i18n/locales/zh-CN.json` and `en.json`. Translation belongs to display layers; plugin dictionaries are plugin-owned. Keep songs, saved values and file identities unchanged. [Localization design, Chinese](../architecture/i18n.md)

## Check changes

```sh
bun run typecheck
bun run check:boundaries
bun run check:i18n
bun test tests/your-related.test.ts
```

`bun run check` builds all three example plugins and runs the complete offline type, boundary, dictionary and test suite. For UI changes, also walk the affected flow in a browser, checking both languages, navigation and unsaved input. Select focused probes by the affected path; [specialist commands, Chinese](../development-reference.md) list platform and player tools.

## Build desktop and Worker

```sh
bun run build:desktop -- --target linux-x64
```

Targets are `windows-x64`, `linux-x64`, `macos-x64` and `macos-arm64`. The default is the current host; cross builds still need the target's native linker environment. The script builds WebUI, native helper, rclone and three plugins into `dist/desktop/<target>/`. Initial builds may download fixed tool materials.

Run that directory's app with `--data /tmp/musicfs-dev` for separate data and `--no-integration` to disable tray and login-startup registration. Add `--no-open` to print access details instead of opening the browser. [Remote and CLI use](headless.md)

For Worker:

```sh
bun run build:web
bun run build:worker
```

Output is `dist/worker/`. No plugin arguments means an empty registry; pass already-built ZIP paths to include modules. Users activate plugins through management. [Deploying and retaining cloud plugins](worker.md)

## Set the application version

```sh
bun run version:set 0.1.0-dev.32
```

This updates `package.json`, the version and package names in both release guides, and the prerelease label. Downloads use the shared GitHub Releases entry. Plugins, the plugin API and historical records keep their own versions. The command only edits files; build locally or commit and publish as described below.

## Prepare a release

Choose the version and targets, update their docs, complete checks appropriate to the change, then build in sequence from the same source:

```sh
bun run build:desktop -- --target windows-x64
bun run build:desktop -- --target linux-x64 --skip-web
bun run build:worker dist/plugins/org.musicfs.sample.zip dist/plugins/org.musicfs.qq.zip dist/netease/org.musicfs.netease.zip
bun run build:author-kit
bun run package:release -- --targets windows-x64,linux-x64
```

Adjust the target list to your toolchains. If release inputs change afterward, rebuild affected artifacts. `dist/releases/<version>/` contains ZIPs, plugins, `release-manifest.json` and `SHA256SUMS`. Run `sha256sum -c SHA256SUMS` there. Windows can compare `Get-FileHash <archive.zip> -Algorithm SHA256` with the checksum list. Check the extracted bilingual entry pages and author-kit build, then publish matching attachments and download instructions together.

Local packaging checks source, WebUI and plugin identity; the GitHub workflow below handles uploads. Desktop, Worker and author packages carry their relevant bilingual guides. Complete designs, references and historical evidence live in the source package. [Downloads and upgrades](release.md)

## GitHub releases

[Build and release](../../.github/workflows/release.yml) builds Windows x64, Linux x64, Worker, the author kit, source and all three example plugins on GitHub.

- To try a build, open **Actions → Build and release → Run workflow** and select a branch. Download the complete package set from that run's **Artifacts**, retained for 7 days.
- To publish, update the version with `version:set`, commit, then push a matching tag with a `v` prefix. For version `0.1.0-dev.32`:

```sh
git add package.json docs/release.md docs/en/release.md
git commit -m "release: 0.1.0-dev.32"
git tag v0.1.0-dev.32
git push origin HEAD
git push origin v0.1.0-dev.32
```

The tag must match `package.json`. After checks, builds and checksum verification pass, the workflow creates a GitHub Release with all attachments. Versions with suffixes such as `-dev` or `-alpha` are marked as prereleases and do not replace the latest stable release. GitHub generates release notes from commits; edit them on the Release page as needed. Manual runs only build packages.

The workflow uses the built-in `GITHUB_TOKEN`; no extra secrets are needed. A single Linux runner builds the release with cached dependencies and tools. MinGW cross-compiles the Windows native helper. `bun run check` runs the offline checks, without contacting music platforms or deploying Cloudflare. macOS remains available through the source-build commands above.

GitHub attachments do not retain subdirectories. Automated builds use `--flat-plugins` to place standalone plugin ZIPs at the release root, with matching paths in the manifest and `SHA256SUMS`. Local packaging still uses `plugins/` by default. Download all attachments for a version into one directory, then run `sha256sum -c SHA256SUMS`.

## Build from a source archive

The source ZIP omits `.git`, installed dependencies and user data. `SOURCE.md` records its original build identity. After extraction, create a local Git snapshot so build tools can enumerate inputs:

```sh
git init
git add .
git -c user.name='Source build' -c user.email='source@musicfs.invalid' commit -m 'Import source release'
bun install --frozen-lockfile --ignore-scripts
bun run build:desktop -- --target linux-x64
```

Use the target commands above for other platforms. Include corresponding source, change records and applicable licenses with your distribution. MusicFS's own code uses GPL-3.0-only.

## Contribute and report

For a problem, include versions, system, source or connection method, steps and the relevant error. Keep a code change focused on a clear user result, update affected types, examples and bilingual docs, and describe changed behavior and actual checks in the submission. New providers usually belong in plugins; provider-specific accounts, quality and metadata policy stay outside the core.
