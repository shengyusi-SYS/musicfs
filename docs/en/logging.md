# Logs and IO diagnostics

[简体中文](../architecture/logging.md)

Diagnostics follow the player request through WebDAV, the library, source operations, upstream connections and desktop caching. Refresh and plugin progress remain in their existing durable records; logs are not a second task database.

| Scope | Location | Default |
|---|---|---|
| Desktop application | Data directory: `logs/musicfs.log` | warning and above, 2 MiB rotation and 3 backups |
| rclone mounts and remote WebDAV | Data directory: `mounts/rclone.log` | Native JSON ERROR logs, 2 MiB rotation and 3 backups |
| Process startup failures | Existing `startup.log`, `launcher.log` | Launcher messages and runtime crash output, separate from application IO logs |
| Worker | The Worker's Cloudflare Observability page | Application warnings, errors and uncaught exceptions; template invocation logs and traces are disabled |

Set `MUSICFS_LOG_LEVEL=debug` in the desktop process environment or Worker runtime variables, restart or deploy the variable change, then reproduce once. Common levels are `warning`, `info` and `debug`; missing or unrecognized values use `warning`.

The source development service uses the same setup. If file logging is unavailable, it falls back to process output without blocking service startup.

Routine traffic is debug-only. Each kind of IO event allows 20 records per minute and summarizes suppressed counts, tracking at most 128 event keys. No logs are emitted for every song, SQL query or audio chunk. Response-header timing and completed-stream timing describe different stages.

## Follow a request

Hono assigns the request ID. LogTape's async context carries it through source operations and upstream connections. Immutable resource keys link the desktop cache's separate native-process requests. Categories distinguish `source`, `cache`, `rclone` and `dav`.

The cache records whether a read uses native caching or bypasses it. A request for source bytes identifies actual cache read-through; entering VFS alone does not prove a cache hit. Existing rclone statistics remain the source for cache size and usage; logging adds no queries.

Streams report completion, cancellation or failure once, with byte counts and elapsed time. Backpressure and cancellation propagate normally; ordinary seek cancellation is not a warning. Unexpected HTTP 500 errors expose a copyable error ID. Repeated source and stream failure details may be suppressed by IO limits.

## Implementation

[LogTape](https://logtape.org/manual/start) supplies structured logging, levels, async context and throttling for Bun and edge runtimes. `@logtape/file` supplies desktop rotation; rclone uses its own rotation options. This keeps one logging API across hosts without bundling desktop file sinks into Worker. Pino or Winston would fit an existing Node logging stack; MusicFS prioritizes shared runtime support.

Hosts configure logging; transport and IO adapters observe it. Domains remain independent of the logging library. Standard Error causes preserve diagnostic relationships without changing user-facing error semantics. Observation neither reads bodies for logging nor adds provider requests.

Application records use request/operation IDs, route patterns, status, timing, byte counts, error types/codes and stack locations. Full URLs, query strings, credentials, cookies, request bodies, music paths and raw upstream error messages are not passed to the logger. Native tools manage their own logs; public records retain only the necessary anonymous findings.

The Worker template enables application logs while disabling per-invocation logs and traces, reducing scan and Range traffic records. It adds no separate logging service, Tail Worker or database. Existing custom deployment settings remain unchanged. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [rclone logging](https://rclone.org/docs/#logging)
