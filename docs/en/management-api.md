# Management HTTP API

[简体中文](../management-api.md)

The desktop and Worker compose the same management routes. Browsers send their HttpOnly session Cookie; scripts can use `Authorization: Bearer <management-token>`. DAV uses separate Basic reader credentials. JSON contracts live in [`src/contracts`](../../src/contracts).

## Access and plugins

| Method and path | Input / result |
|---|---|
| `GET /api/access` | Public access state: authenticated, passwordConfigured, optional username |
| `POST /api/access/login` | `{username,password,rememberMe}` → browser session |
| `POST /api/access/bootstrap` | `{token}` → browser session |
| `PUT /api/access/account` | Authenticated `{username,password}`; password changes replace prior sessions |
| `POST /api/access/ticket` | Authenticated request → single-use ticket, valid for 3 minutes |
| `POST /api/access/exchange` | `{ticket}` → independent browser session |
| `POST /api/access/logout` | End the current session |
| `GET /api/status` | Host and version |
| `GET /api/connection`, `PUT /api/connection` | Read or customize DAV `{username,password}`; management-authenticated |
| `GET /api/plugins` | Installed manifests/revisions and active/missing state |
| `POST /api/plugins/inspect` | ZIP body → manifest, revision and compatibility, without installing |
| `POST /api/plugins/inspect-url` | `{url}` → same inspection |
| `POST /api/plugins` | ZIP body → installation or persistent change |
| `POST /api/plugins/from-url` | `{url}` → installation or persistent change |
| `DELETE /api/plugins/:id` | Remove installation, preserving instance config and layout references |
| `GET /api/plugin-changes/:operationId` | Durable progress; unfinished changes schedule continuation |
| `GET /api/plugins/:id/configuration` | Schema, display dictionaries, UI hints and optional capabilities |

Desktop simple installs return 201; structure upgrades return 202. Worker code changes return 202. Follow `PluginChange.status` to `completed` or `failed`. An upload response alone is not installation completion.

## Sources, folders and refresh

| Method and path | Input / result |
|---|---|
| `GET /api/instances` | Public instances without private state |
| `POST /api/instances` | `{pluginId,name,config}` |
| `PUT /api/instances/:id/config` | `{config}`; plugin validation and conditional save |
| `DELETE /api/instances/:id` | Delete that instance and snapshots |
| `DELETE /api/instances/:id/session` | Clear that source's authorization, preserving config/layout |
| `GET /api/instances/:id/authentication` | Public `{operationId,step,error?}` or null |
| `POST /api/instances/:id/authentication` | Start/poll/submit/cancel; poll/submit include operation and challenge IDs |
| `GET /api/instances/:id/roots` | Complete published source entries |
| `GET /api/instances/:id/directory?directoryRef=…` | Shallow source-reference browser; omit ref for roots |
| `GET /api/instances/:id/directory-status?directoryRef=…` | Published success time, statistics and latest error |
| `GET /api/library/directory?path=…` | Published path's entries and status |
| `POST /api/instances/:id/refresh` | Scope below → 202 RefreshView |
| `GET /api/instances/:id/refresh` | Current/latest refresh or null; read-only |
| `GET /api/refreshes/:operationId` | Read-only operation progress |
| `POST /api/refreshes/:operationId/step` | At most one plugin page, then durable checkpoint |
| `DELETE /api/refreshes/:operationId` | Persist cancellation |
| `GET /api/layout` | `{revision,nodes}`; null nodes means automatic layout |
| `GET /api/layout/default` | Editable automatic layout without saving |
| `PUT /api/layout` | `{expectedRevision,nodes}` |
| `GET /api/library?path=…` | Shallow exported file view |

Refresh bodies: `{}` updates roots; `{directoryRef}` updates one directory; `{scope:"instance"}` visits the source; `{scope:"file-info",directoryRef}` prepares file attributes; `{scope:"metadata",directoryRef}` deliberately refreshes metadata when supported.

A refresh exposes queued/running/completed/failed/superseded/cancelled and per-directory failures. A completed multi-directory operation can still contain failed directories, whose previous content stays published. GET never advances a refresh. Cold reads may return `503 refresh_pending`, `Retry-After: 2` and `X-MusicFS-Refresh`; retrying reuses the active work.

## Rules and naming

| Method and path | Input / result |
|---|---|
| `GET /api/update-rules`, `POST /api/update-rules` | List or save `{instanceId,target,timing,enabled,label?}` |
| `PUT /api/update-rules/:id`, `DELETE /api/update-rules/:id` | Edit or remove |
| `POST /api/update-rules/:id/run` | Schedule the scope now |
| `GET /api/instances/:id/file-naming?directoryRef=…` | Revision, effective policy, inheritance and available fields |
| `PUT /api/instances/:id/file-naming?directoryRef=…` | `{revision,policy}`; null restores inheritance/original names |
| `POST /api/instances/:id/file-naming/preview?directoryRef=…` | `{policy}`; uses published facts, without fetching audio |
| `GET/PUT /api/instances/:id/refresh-policy?directoryRef=…` | Legacy interval policy; 0 manual, otherwise at least 15 minutes |

Rule timing and target DTOs are in [`refresh-policy.ts`](../../src/contracts/refresh-policy.ts). A duplicate target returns 409 `update_rule_exists` with the existing `ruleId`; it is distinct from revision or source-generation conflicts.

## Desktop-only operations

| Resource | Operations |
|---|---|
| `/api/mounts` | GET state; POST saved local/remote mount |
| `/api/mounts/:id` | DELETE unmounts and removes its definition/cache |
| `/api/mounts/:id/mount`, `/unmount` | POST remount or unmount |
| `/api/mounts/:id/name`, `/auto-mount` | PUT `{name}` or `{enabled}` |
| `/api/mounts/:id/cache` | GET actual state, PUT settings, DELETE owned cache with normal remount |
| `/api/mounts/:id/cache/refresh` | POST invalidate only that mount's listing |
| `/api/desktop/read-cache` | GET actual shared state, PUT `{maxMiB,maxAgeHours}`, DELETE idle shared cache |
| `/api/desktop/network` | GET actual addresses; PATCH supplied fields or PUT complete settings |
| `/api/desktop/preferences` | GET/PUT startup, browser-opening and mount-retry preferences |
| `/api/desktop/mount-prerequisites` | GET component readiness; POST `/install` runs the Windows installer |
| `/api/desktop/https` | GET/DELETE local HTTPS; POST `/enable` or `/trust` |
| `/api/desktop/https/file-size-limit` | DELETE restores the app-saved original native limit |
| `/api/desktop/quit` | POST normal shutdown; 202 accepted or 409 busy |

Desktop network fields are `managementAccess/managementPort/davAccess/davPort`; returned `managementUrls/davUrls` use actual listeners. Ports belong to their entry. App-local mounts use a separate internal connection. See [`desktop`](../../src/contracts/desktop.ts), [`mounts`](../../src/contracts/mounts.ts) and [`read-cache`](../../src/contracts/read-cache.ts) for full JSON types.

## Errors and DAV

Malformed input returns 400; plugin config/authentication failures use 422 and structured fields; conflicts use 409. Source faults keep their specific kind and optional display translation. Private state candidates never reach the browser. Management responses use `Cache-Control: no-store`.

The read-only `/dav/` surface implements OPTIONS, Depth 0/1 PROPFIND, GET and HEAD with exact range/conditional handling. The [plugin contract](plugin-interface.md) explains byte identity, deferred attributes and stream behavior. Desktop-only APIs are not available in Worker or the minimal development service.
