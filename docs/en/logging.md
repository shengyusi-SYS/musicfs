# Logs and IO diagnostics

[简体中文](../architecture/logging.md)

Diagnostics follow the player request through WebDAV, the library, source operations, upstream connections and desktop caching. Refresh and plugin progress remain in their existing durable records; logs are not a second task database.

| Scope | Location | Default |
|---|---|---|
| Desktop application | Data directory: `logs/musicfs.log` | info by default: startup, configuration and refresh outcomes; 2 MiB rotation and 3 backups |
| rclone mounts and remote WebDAV | Data directory: `mounts/rclone.log` | Native JSON ERROR logs, 2 MiB rotation and 3 backups |
| Process startup failures | Existing `startup.log`, `launcher.log` | Launcher messages and runtime crash output, separate from application IO logs |
| Worker | The Worker's Cloudflare Observability page | Application warnings, errors and uncaught exceptions; template invocation logs and traces are disabled |

On desktop, use **Settings → Logs and diagnostics** to change application and mount/cache verbosity. Changes apply immediately and persist without restarting the backend or remounting. Application logs default to `info`; routine requests remain `debug`. rclone defaults to `ERROR` and uses its official `options/set` command. Configuring an unused native service does not start it.

Choose **Debug** before reproducing a problem, then **Download logs**. The ZIP includes application, MusicFS-managed rclone and startup logs plus version, build revision, process ID, start time and active settings. It excludes account configuration, databases and authorization state. Application and rclone logs each include the current file and up to three backups, with at most the final 2 MiB of each file; the summary marks truncated files.

Desktop uses `MUSICFS_LOG_LEVEL` as the startup fallback when settings have not been saved. Saved settings take precedence on later starts. Worker continues to use that runtime variable, defaulting to `warning`; deploy the variable change in Cloudflare. No D1 configuration polling or cloud log storage is added.

The source development service uses the same setup. If file logging is unavailable, it falls back to process output without blocking service startup.

Routine traffic is debug-only. Each kind of IO event allows 20 records per minute and summarizes suppressed counts, tracking at most 128 event keys. No logs are emitted for every song, SQL query or audio chunk. Response-header timing and completed-stream timing describe different stages.

## Follow a request

Hono assigns the request ID. LogTape's async context carries it through source operations and upstream connections. Immutable resource keys link the desktop cache's separate native-process requests. Categories distinguish `source`, `cache`, `rclone` and `dav`.

The cache records whether a read uses native caching or bypasses it. A request for source bytes identifies actual cache read-through; entering VFS alone does not prove a cache hit. Existing rclone statistics remain the source for cache size and usage; logging adds no queries.

DAV 5xx responses are recorded by default, including a 503 waiting for preparation. Records include the request ID, method, range, stage and available refresh-operation ID. Preparation waits use a separate event from other failures.

Provider outcomes are observed as well as HTTP: a provider fault can be recorded even when the transport returned 200. Records include the fault kind and retry delay. Background refresh records outcomes and failure summaries; debug mode adds checkpoints.

Streams report one completion, cancellation or failure event with expected/actual bytes, range, content identity, elapsed time and time since the last data. Premature EOF, stream errors and request/consumer cancellation are distinguished. Backpressure and cancellation propagate normally; ordinary seek cancellation is not a warning; deadline expiry remains a warning. Unexpected HTTP 500 errors expose a copyable error ID. Repeated events remain bounded by IO limits.

## Implementation

[LogTape](https://logtape.org/manual/start) supplies structured logging, levels, async context and throttling for Bun and edge runtimes. `@logtape/file` supplies desktop rotation; rclone uses its own rotation options. This keeps one logging API across hosts without bundling desktop file sinks into Worker. Pino or Winston would fit an existing Node logging stack; MusicFS prioritizes shared runtime support.

Hosts configure logging; transport and IO adapters observe it. Domains remain independent of the logging library. Standard Error causes preserve diagnostic relationships without changing user-facing error semantics. Observation neither reads bodies for logging nor adds provider requests.

Application records use request/operation IDs, route patterns, status, timing, byte counts, error types/codes and stack locations. Full URLs, query strings, credentials, cookies, request bodies, music paths and raw upstream error messages are not passed to the logger. Native tools manage their own logs; public records retain only the necessary anonymous findings.

The Worker template enables application logs while disabling per-invocation logs and traces, reducing scan and Range traffic records. It adds no separate logging service, Tail Worker or database. Existing custom deployment settings remain unchanged. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [rclone logging](https://rclone.org/docs/#logging)

The desktop diagnostics controller owns sinks and `diagnostics.json`. It applies levels through LogTape filters and rclone RC, independently of music domains, source configuration and audio cache identity.
