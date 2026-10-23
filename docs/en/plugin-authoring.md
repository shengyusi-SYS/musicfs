# Build and publish a source plugin

[简体中文](../plugin-authoring.md)

Start with the standalone author kit, adapt its sample, build a ZIP and install it in an existing MusicFS. The minimal sample exports a WAV file without accounts, playlists or quality settings. NetEase and QQ use the same public contract.

Authors need Bun; plugin users install a ready-made ZIP. The current source uses API 0.1.12. For a downloaded kit, follow its bundled [types](../../packages/plugin-api/src/index.ts) and [contract](plugin-interface.md).

## Create a working directory

Extract the complete plugin-author-kit archive into your own directory. From the full MusicFS repository, generate it with:

```sh
bun install --frozen-lockfile
bun run build:author-kit
```

Copy all of `dist/plugin-author-kit/` into a separate directory. For example, from the repository on Linux/macOS:

```sh
mkdir -p /tmp/musicfs-author-demo
cp -R dist/plugin-author-kit/. /tmp/musicfs-author-demo/
cd /tmp/musicfs-author-demo
```

In Windows PowerShell:

```powershell
New-Item -ItemType Directory -Path "$env:TEMP/musicfs-author-demo"
Copy-Item -Path dist/plugin-author-kit/* -Destination "$env:TEMP/musicfs-author-demo" -Recurse
Set-Location "$env:TEMP/musicfs-author-demo"
```

Use the Bun version fixed in the kit, currently 1.4.3:

```sh
bun install --frozen-lockfile
```

`@musicfs/plugin-api` is supplied through `file:./packages/plugin-api`; it is not published on npm. Keep that directory. The kit has its own small lockfile for the builder, rather than the application's WebUI and platform SDK dependencies.

## Set the identity and build

Edit [plugins/sample/manifest.json](../../plugins/sample/manifest.json):

```json
{
  "id": "org.example.myaudio",
  "name": "My audio source",
  "nameTranslations": { "zh-CN": "我的音频来源" },
  "version": "0.1.0"
}
```

Choose a stable unique ID, your display names and a release version. The folder may remain `plugins/sample`; both host entries already point to `index.mjs`.

From the kit root:

```sh
bun run build
bun run typecheck
```

Output is `dist/plugins/org.example.myaudio.zip`. Ajv generates standalone configuration validation, Bun bundles ESM and zip.js writes the archive. Users need no npm installation or runtime schema compiler. Public API imports are type-only.

Increase the manifest version whenever published contents change. From the complete repository, the equivalent sample command is `bun run build:sample`; the standalone kit uses `bun run build`.

## Install and try two instances

1. In **Plugins → Install plugin**, choose the ZIP. The page checks it automatically; install after reviewing compatibility. A direct ZIP download URL also works.
2. In **Library → Add source**, choose your plugin. Create sources A and B with different **Folder name** values. The minimal sample has no sign-in.
3. Browse both sources and find `440 Hz.wav`.
4. Open **Player folders**, create a folder, drag both source entries into it and **Save folders**. **Add to…** offers the same destination selection.
5. Use **Connect → WebDAV players** to read both files. The sample is 16,044 bytes; compare complete and ranged reads.
6. Change only A's configured folder name and update its entries. B stays unchanged; saved player-folder aliases remain user-controlled.
7. Restart normally and confirm that both sources, saved folders and files remain available.

Worker installation reports background progress. If your plugin supports Worker, check its network and runtime dependencies in that host too.

## Adapt the source

| File | What to change |
|---|---|
| [index.ts](../../plugins/sample/index.ts) | Default `SourcePlugin` export: validation, roots, listing, stat and reading |
| [config.schema.json](../../plugins/sample/config.schema.json) | Instance configuration and form annotations |
| [translations.json](../../plugins/sample/translations.json) | Optional display translations, imported into configuration |
| [manifest.json](../../plugins/sample/manifest.json) | Identity, API range, host entries, structure versions and payload files |
| [generated-config.d.mts](../../plugins/sample/generated-config.d.mts) | Declaration for the generated validator |
| [build-sample.ts](../../scripts/build-sample.ts) | Author-side build and archive entry |

The core understands files and opaque references; your plugin owns provider authentication, categories, quality and metadata. Bundle runtime dependencies into your ZIP and declare only hosts you support.

The [contract](plugin-interface.md) covers exact behavior. Start with these decisions:

- Keep source, occurrence, file and byte identities distinct. A temporary download URL is not a stable file identity. A failed page is not an empty final page.
- Publish accurate final sizes, media types and content IDs. When `info` is absent, `stat` obtains it; explicit `deferredInfo` enables a bulk preparation pass. Keep file modification times stable when bytes do not change.
- Return the actual served range and a cancellable native stream. Check `expectedContentId`, preserve backpressure and pass cancellation to upstream requests.
- Read config and private state from `ctx`. Propose changes through `nextPrivateState`, including confirmed credential rotation when later content work fails. Shared module variables are not instance storage.
- Use optional host JSON caching for metadata and plans, not audio. Immutable plans referenced by published files need stable keys and lifetimes. Use the returned winner from `putIfAbsent` when fixing a first-read plan.
- Tagging is optional. Pass through files, implement it yourself or bundle a tool. Descriptions and ranges always refer to final exported bytes.
- Optional naming facts come from listings. The core applies templates; do not fetch extra audio just to name files or use global playlist positions as naming identity.
- Retention-only configuration can use `contentConfiguration`; deliberate metadata refresh uses `metadataRefresh`. Neither changes already-published bytes in place.
- Change `configVersion` or `stateVersion` only for structure changes. Supply pure migrations and target-state validation when existing instances need conversion.

## Display translations

`nameTranslations` requires an API lower bound of 0.1.12. Configuration may carry its own dictionaries without depending on React or i18next:

```ts
configuration: {
  schema: { type: 'object', properties: { server: { type: 'string', title: 'Server URL' } } },
  translations: {
    'zh-CN': { 'Server URL': '服务器地址', 'Sign in first.': '请先授权。' }
  }
}
```

The host translates annotations, authorization messages and errors in the plugin namespace. Keep enum values, defaults, user names and references unchanged. Parameterized errors can retain a fallback `message` and attach `translation: { key: 'Request failed ({{status}})', values: { status: 503 } }`, with that key in the dictionary.

## Publish and update

Publish the ZIP with its name, version, API range, supported hosts, configuration and sign-in instructions. Users upload it or enter a direct download link. Increase the package version for every content change; structure versions only change for data migrations.

Before release, check two-instance isolation and one update from the previous version with saved data. Include applicable licenses, dependency notices and the corresponding build-source entry. The supplied public types, tools and sample code use [GPL-3.0-only](../../LICENSE); third-party components retain their own licenses.
