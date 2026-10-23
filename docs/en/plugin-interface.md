# Source plugin contract

[简体中文](../architecture/plugin-interface.md)

This is the current API 0.1.12 contract. Exact serializable types are in [plugin-api](../../packages/plugin-api/src/index.ts), included in the author kit. Start-to-finish instructions are in the [author guide](plugin-authoring.md).

## Package and entry

A ZIP contains `manifest.json`, prebuilt ESM entries, bundled dependencies, configuration resources and applicable licenses. The manifest declares identity, SemVer version, API range, host entries, config/state structure versions and payload files. Its digest identifies exact installed contents. Increase the version for changed payloads.

Default-export a `SourcePlugin`. Required methods are `validateConfig`, `roots`, `list`, `stat` and `open`. Authentication, renewal, migration, caching, naming and metadata refresh are optional. A plain file source does not need accounts or music-specific fields.

Use type-only public API imports and bundle runtime dependencies. Desktop and Worker entries may differ, but must implement the same source semantics. Host-specific process or filesystem dependencies belong only in the appropriate entry.

## Configuration and display

`configuration.schema` uses JSON Schema draft-07. `validateConfig(ctx, candidate)` returns the normalized config or a structured error. The official builder uses Ajv standalone validation; a plugin may choose another compatible internal validator.

Finite `ui` hints expose root property ordering and `password`, `textarea` or `uri` widgets, identified by property name or JSON Pointer. Field-error paths use JSON Pointer too. The host adapts these to its form library. Authorization secrets are private state, rather than public form defaults.

`nameTranslations`, configuration dictionaries and error `translation: {key, values}` are optional display data. They do not change config values, filenames or identity. See [translations](plugin-authoring.md#display-translations).

## Context and results

`Context` supplies `instanceId`, current `config`, `privateState`, `fetch` and `signal`, plus optional cache, preparation and work-budget hints. Use the provided cancellation signal for real upstream work.

Methods return `Outcome<T>`: `{ok:true,value}` or `{ok:false,error}`, optionally with a complete `nextPrivateState`. A confirmed credential change can be proposed even if later content work fails. The host owns conditional persistence; private state never appears in management responses.

## Stable identities and pagination

| Identity | Meaning |
|---|---|
| Plugin ID / revision | Author identity / exact installed payload |
| Instance ID | One independently configured source |
| `sourceId` | A content entry exposed by `roots` |
| `entryId` | One stable occurrence in a directory, including repeats |
| `directoryRef`, `fileRef` | Opaque provider references |
| `contentId` | One exact final byte representation |

Temporary URLs are locators, not stable identities. Changed encoding, bytes or tags need a new representation identity. Renaming an instance or arranging exported folders does not change source identity.

`roots` and `list` return ordered pages with optional `nextCursor`. No cursor means completion; an empty page with a cursor is not an empty completed directory. On failure, return a fault rather than a truncated success. The host publishes each directory only after its full page sequence succeeds.

Optional `Page.statistics` contains nonnegative safe-integer **per-page increments**, with the same keys across the sequence. `SourcePlugin.statistics` supplies display labels. `Page.progress` instead reports cumulative `{completed,total,unit}` with stable total/unit and monotonic completed work. Failed work does not count as accepted progress.

## File descriptions and deferred preparation

A complete `FileInfo` contains `{contentId,size,mediaType}` for the final exported bytes, with optional stable ISO `modifiedAt`. Keep it consistent across listing, stat and open. Unknown size is not zero. A missing timestamp falls back to the directory's content time, preserved on unchanged refreshes.

Provide complete `Entry.info` whenever known. Otherwise, omit it and let `stat` obtain exact information. `Entry.deferredInfo: true` explicitly opts into a background bulk-preparation pass; individual stat/open still resolve only the requested file.

When `ctx.fileInfo === 'required'`, every file returned by `list` must include complete `info`, or the call must return a fault. Use the same pagination, retry and cancellation semantics. Existing listings remain available while preparation runs.

Bulk DAV properties requiring size, media type or ETag can return `503` with `Retry-After` and `X-MusicFS-Refresh` while preparation is pending. Single-file HEAD/GET resolve that file, then enforce the ordinary byte contract.

## Open, ranges and cancellation

`open` receives `expectedContentId` and an optional inclusive `{start,end}` range. Return `ReadResult` containing the actual final `content`, actual `servedRange` or `null` for the full file, and a `ReadableStream<Uint8Array>`.

The host normalizes client ranges and checks returned identity, length and interval. A full upstream response must not be labeled as a partial one. If relocation finds changed contents, return `content_changed` before sending a body. Do not switch representations or restart from the beginning inside an already-started response.

Preserve native stream backpressure and cancellation. Propagate late upstream errors as stream errors rather than normal EOF. Do not buffer an entire song just to emulate a range or discover its length.

Tagging is optional and plugin-owned. Passing through, bundling a tagger or using the common audio tool all produce the same final-byte contract. A plugin may reserve a legal final layout and fill tags at first read if every read of that published identity uses one persistently fixed plan. Example-specific padding budgets are not a core requirement.

## Authentication and private state

Optional `authenticate` accepts `start`, `poll`, `submit` and `cancel`, with current challenge IDs where required. Steps are `waiting`, `input`, `complete`, `expired` or `cancelled`; waiting/input include challenge ID and expiry. The host's management operation ID stays outside the plugin action.

Waiting may supply text `qrCode`, inline PNG/JPEG `qrImage`, or an HTTP(S) authorization `url`. `qrImage` is a base64 data URI up to 350,000 characters. Input steps use a serializable Configuration. Complete means usable credentials exist; optional profile details should not hold up sign-in.

The host persists public steps and associates calls with the instance generation and state revision. Cancellation is persisted before provider cleanup. Late or replaced results cannot reactivate an operation. Signing out resets this instance's private state while retaining configuration and layout.

Do not store instance credentials in module globals. Submit a complete state candidate using `nextPrivateState`; the host commits it with generation/CAS checks. Private state holds authorization and workflow information, while public metadata belongs in cache or directory snapshots.

## Small JSON cache and work budget

`ctx.cache` is optional and isolated by instance, generation, plugin revision and installation generation.

| Method | Contract |
|---|---|
| `get(key)` | Missing/expired is `undefined`; cached `null` is a valid hit |
| `put(key,value,{expiresAt?})` | JSON value; expiry is Unix milliseconds; omit for representation plans that must persist |
| `getMany(keys)` | Optional positional results, preserving misses and repeated keys |
| `putMany(items)` | Optional atomic batch using the same expiry rules |
| `putIfAbsent(key,value)` | Optional atomic non-expiring insert; returns the actual winner, including `null` |

Keys are 1–4096 characters; a serialized JSON value is at most 1 MiB. Keep audio outside this metadata cache. Plans referenced by published files use immutable keys and must survive the reference lifetime. Ordinary get-then-put does not implement atomic first-read fixation.

`ctx.workBudget.remaining` is a live invocation allowance, not a provider quota. Checkpoint before more work when necessary. Desktop and Worker can share an adaptive pagination algorithm without a fixed per-host song count.

## Content configuration, metadata refresh and naming

`contentConfiguration(config)` may exclude retention-only policy from content/authentication identity. Do not exclude options that change actual contents or authorization.

With `metadataRefresh: true`, `list` recognizes `ctx.metadataRefresh` as the deliberate refresh operation ID. Fetch fresh metadata while reusing assets within that operation; do not overwrite immutable published plans.

Optional `naming.fields` declares template-field labels. Each file may supply `{identity,fields}`, using already-listed facts. The identity excludes global directory position; the host handles repeated occurrences, templates, extensions and collision allocation. Naming does not require extra audio fetches.

## Renewal and migrations

Optional `renewal.needed` checks local state/time. Only when renewal is needed does the host coordinate a per-instance short lease and call cancellable `renew` outside a database transaction. Normal reads do not enter a global serial queue. Credential rotation does not mean an account change or invalidate successful directories.

`configVersion` and `stateVersion` describe structures, separately from release SemVer. Pure synchronous `migrateConfig` and `migrateState` return complete JSON candidates without I/O. `validateState` checks the target state against candidate config. Existing affected instances need corresponding conversion and validation hooks.

The host freezes all affected inputs, prepares candidates and activates the installation and **all** instances atomically. Any changed input or failed conversion preserves the old active installation and data. Worker publishing and database activation are separate phases; new code must be available before migration uses it.

## Errors and lifecycle

Fault kinds distinguish invalid configuration, sign-in requirements, missing content, unavailable media, rate limits, temporary failures, unsupported operations and changed representations. `retryAfterSeconds` may express provider cooldown. An empty directory, lack of playback rights and a network failure are different results.

The host binds every call to the actual plugin revision and instance generation. Updates, removal, account/config changes and cancellation invalidate stale commits. Coordinate retries with the upstream SDK rather than multiplying retry loops.

## Verify your plugin

Use two instances, independent config and a saved directory across restart. Check one complete listing, exact descriptions, full/ranged reads and cancellation. Check an update from the previous version when structure or state behavior changes. Choose additional cases from the capabilities your plugin actually declares.
