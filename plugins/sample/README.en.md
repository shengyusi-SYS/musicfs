# Minimal audio source

[简体中文](README.md)

This sample exports a deterministic `440 Hz.wav`: one second, 8 kHz, 16-bit mono, 16,044 bytes. It demonstrates the public file contract without accounts, sign-in, playlists or quality settings.

Use the [author guide](../../docs/en/plugin-authoring.md) to adapt it in a standalone directory. Public types come from the kit's local `packages/plugin-api`, rather than an npm SDK release.

In the author kit:

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
```

In the full repository, use `bun run build:sample`. Output is `dist/plugins/<manifest.id>.zip`. Choose your own ID, names and version before publishing.

`index.ts` default-exports the plugin; `config.schema.json` defines `label`; `translations.json` carries optional display text. `roots` exposes one entry, `list` supplies complete file info, `stat` returns the same description, and `open` checks content identity/ranges and returns a cancellable native stream.

Two instances can choose different folder names without changing the WAV's byte identity. Saved player-folder aliases remain user-controlled. Follow the [contract](../../docs/en/plugin-interface.md) when adding network reads, private state or migrations. The sample uses GPL-3.0-only.
