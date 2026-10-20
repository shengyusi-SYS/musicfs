# Small source media fixtures

`source.mp3`, `source.flac`, and `source.m4a` are approximately one second of synthesized audio generated locally for the metadata feasibility work. They are not music-platform downloads or account data. Source plugin tests use their valid container structures to verify tagging, exact final lengths, and byte ranges.

APE tests reuse the structurally valid generated tag/container fixture in `packages/audio-tags/test-fixtures.ts`; its arbitrary audio payload is not a decoding fixture.

`cover.jpg` is a locally generated 8×8 red JPEG. The NetEase integration test returns its original bytes with the observed `image/jpg` MIME alias and verifies normalization to `image/jpeg` without rewriting the picture.
