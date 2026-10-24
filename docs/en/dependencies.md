# Dependencies and trade-offs

[简体中文](../dependencies.md)

MusicFS reuses libraries for forms, authentication, archives, tags and system integration. The project owns plugins, snapshots, file representations and refresh rules. Exact versions live in package manifests, `bun.lock` and the native helper's `Cargo.lock`.

## Forms and validation

**RJSF** turns a plugin's JSON Schema into a form, with Ant Design providing the controls. New plugins describe fields without adding provider-specific pages to the application. Handwritten forms would couple providers to the UI; lighter form libraries would still need a Schema-to-controls layer.

**Ajv** validates JSON Schema. Example plugins generate standalone validators at build time and call them at runtime, fitting the Worker environment. RJSF uses its Ajv adapter, while `ajv-i18n` translates validation errors. Zod validates the application's management API inputs: plugin declarations and application contracts have separate owners.

## Archives and versions

**zip.js** handles plugin ZIPs and release archives, including streaming, entry checks and file modes. **fflate** is limited to development and test ZIP encoding for interoperability checks. JSZip can also handle ordinary ZIPs; the existing toolchain uses zip.js to avoid holding large archives entirely in memory.

**semver** parses versions and compatibility ranges such as `^0.1.0`. The library implements version rules; MusicFS decides installation and instance transitions. Plain string comparisons misinterpret prereleases and ranges.

## Time, naming and cache

| Dependency | Purpose and rationale |
|---|---|
| Croner | Calendar times and time zones; persistent jobs and retries stay in the refresh module |
| Mustache | One template renderer for filename previews and exported paths |
| sanitize-filename | Filesystem-safe names; stable identities and collision handling stay in MusicFS |
| lru-cache | Bounded in-process indexes; rclone VFS owns persistent audio fragments |
| rclone | WebDAV clients, filesystem mounts and sparse read caching |
| node-taglib-sharp | Tag encoding in the optional audio toolkit; MusicFS combines tags and original audio segments without re-encoding audio |

A generic cache cannot infer file size, range and content identity. See the [cache design, Chinese](../architecture/cache-policy.md) and [tagging toolkit](../../packages/audio-tags/README.md).

## Interface, access and runtime

| Dependency | Purpose |
|---|---|
| React, Vite, Ant Design | Shared management UI, build and components |
| TanStack Query | Requests, query reuse, updates and invalidation |
| Pragmatic Drag and Drop | Library drag interactions; the UI owns layout drafts and saving |
| i18next, react-i18next | Translations, interpolation and browser language preferences |
| Hono | Shared desktop and Worker HTTP routes |
| Better Auth | One administrator's password and browser sessions, joined by desktop and QR entry |
| LogTape | Structured logs, desktop file rotation and high-frequency limits |
| xmldom, range-parser | DAV XML and HTTP Range parsing; MusicFS owns the read-only file contract |
| Cloudflare SDK, Wrangler | Worker publishing and deployment tools |
| Bun SQLite, D1 | Host persistence adapters using common SQL and conditional commits |

Provider SDKs belong to their plugins and use pinned versions: [NetEase](../../plugins/netease/README.md), [QQ](../../plugins/qq/README.md). Native tray/startup choices and authentication alternatives are documented in the [desktop integration](../research/desktop-integration.md) and [authentication](../research/management-authentication.md) references.

## Boundaries and release materials

**dependency-cruiser** inspects imports and enforces rules such as preventing core domains from importing UI, provider SDKs or host implementations. TypeScript checks types; dependency-cruiser checks module direction.

Licenses are collected for dependencies participating in each build. Fixed runtime materials live in `third-party/`; see the [third-party guide](../../third-party/README.md).
