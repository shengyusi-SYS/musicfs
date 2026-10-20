# Optional audio tags

This package belongs to plugins that choose to generate tagged audio. The host does not import it or decide which source fields to trust. Plugins fetch music information/artwork/lyrics, choose their own configuration and cache the resulting plan using the ordinary plugin cache.

```ts
const plan = await prepare({ format: 'mp3', sourceInfo, readRange, tags, signal });
// Persist JSON.stringify(plan) under a key that includes the source identity and tag inputs.
const result = await open(plan, readRange, requestedRange, signal);
```

`readRange(range, signal)` returns a normal plugin `ReadResult` for the original source. Ranges are inclusive. Its `content` must match the supplied `sourceInfo`; its `servedRange` and stream must contain exactly the requested bytes. The callback must use the provided cancellation signal. Plans contain source identity, final `FileInfo`, inline base64 tag segments and original source intervals. They never contain credentials or temporary media URLs.

`prepare` reads the source metadata needed for that format. `open` maps the requested range of the final file onto the plan and streams original audio; it does not download the whole song. Changing the source identity or generated metadata changes the final content identity. The first original-source response is checked before returning the tagged result; later stream failure or source change terminates that read. Cancelling the response aborts and cancels its current original-source read.

## Fields

All fields are optional. Missing fields preserve the tags already present where the format/library can represent them. There is no global source merge or guessing policy here.

- `title`, `artists: string[]`, `album`, `albumArtists: string[]`, `date`.
- `track` and `disc`: `{ number, total? }`.
- `cover`: `{ mimeType, data: Uint8Array, description? }`.
- `lyrics`: `{ original?, translation?, romanization? }`, each the source's existing text/LRC independently. Time markers remain in their respective texts.

MP3 dates use the v2.3 `TYER` year and `TDAT` day/month frames (`DDMM`); readers can expose them separately rather than a combined date.

The original lyrics use the format's ordinary lyrics field. Translation/romanization use separate ID3 USLT descriptions, Xiph/APE fields or iTunes freeform items. These preserve separate texts; player support for choosing extra lyric variants and scrolling LRC is not universal. The underlying library normalizes outer whitespace in Xiph comments; time markers and lines are preserved.

## Format handling

| Format | Changed bytes | Original media |
| --- | --- | --- |
| MP3 | Existing ID3v2 is read and rendered as v2.3 with UTF-16 text; selected fields replace their tags. An ID3v1 footer is merged into missing fields and removed. | Original interval after ID3v2/before ID3v1 streams unchanged. |
| FLAC | Xiph comments are updated; supplied cover replaces picture blocks. | STREAMINFO and other metadata blocks remain source intervals, with only the final-block flag adjusted as needed; audio frames remain unchanged. Missing cover preserves existing picture blocks. |
| APE | Existing APEv2 tag is read and re-rendered at the end. Existing ID3 common fields can fill missing fields. | Original Monkey's Audio media interval streams unchanged. |
| M4A | Only `ftyp`/`moov` metadata is read. A small `ftyp` + `udta` editing container is passed to the library. The old `moov` becomes equal-sized `free`; a rebuilt `moov` is appended. | Every original `mdat` keeps its absolute position and bytes, so chunk-offset tables need no adjustment. |

M4A supports the ordinary non-fragmented layout with one `moov`, including `moov` before or after `mdat`. It rejects fragmented/multiple-user-data layouts and open-ended boxes too large to retain their original header width. It never falls back to a whole-song buffer or transcoding. M4A preparation retains the entire movie metadata in memory, not the media payload; unusually large metadata still consumes corresponding memory. Appending the new `moov` means a player must support normal file seeking/Range to read it.

Tag/container encoding uses pinned `node-taglib-sharp@6.0.3`. Empty M4A user data is initialized with an explicit named handler to avoid the library's implicit empty-tag path; its existing `dist/mpeg4/mpeg4BoxRenderer` class encodes that small metadata structure. This deep module path is covered by the no-existing-tags test. The small amount of local framing reads existing metadata boundaries and maps byte intervals; it is not a new codec/tag implementation. Node-compatible builds need `nodejs_compat` and a normal CJS `createRequire` wrapper when the bundler leaves Node builtins as require calls. The host itself need not depend on this package. The dependency keeps its LGPL-2.1-or-later license.
