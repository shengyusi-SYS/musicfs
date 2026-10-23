# Deploy and upgrade a Cloudflare Worker

[简体中文](../worker.md)

The Worker serves the same library, management interface and WebDAV over HTTPS. Prepare a Cloudflare account, Bun and Wrangler. Use the Worker release archive, or run `bun run build:web` and `bun run build:worker` from source to create `dist/worker/`.

## First deployment

In the extracted Worker directory:

```sh
bunx wrangler@4.119.0 login
bunx wrangler@4.119.0 d1 create musicfs
```

Edit `wrangler.jsonc`: fill in `database_id` and `CF_ACCOUNT_ID`, and make `CF_WORKER_NAME` match the top-level `name`. Keep the supplied module rules, ASSETS binding, compatibility settings and migrations directory.

Create a JSON file outside the release directory:

```json
{
  "ADMIN_TOKEN": "your-management-token",
  "DAV_USERNAME": "musicfs",
  "DAV_PASSWORD": "your-reader-password",
  "CF_API_TOKEN": "your-worker-publishing-token"
}
```

The first three values provide initial management access and reader credentials. `CF_API_TOKEN` lets the running Worker publish plugin installs, updates and removals. Use an **Account → Workers Scripts → Edit** token for the target account. Wrangler login authorizes your local deployment; it does not supply this runtime credential.

Apply all bundled migrations, then deploy:

```sh
bunx wrangler@4.119.0 d1 migrations apply musicfs --remote
bunx wrangler@4.119.0 deploy --secrets-file /absolute/path/to/musicfs-secrets.json
```

Open the printed domain, enter `ADMIN_TOKEN`, then create a management account in **Settings → Login account** if desired. Install a plugin and add your source as described in the [user guide](user-guide.md).

Players use `https://your-domain/dav/` with the reader credentials; the page also offers an import QR code. Management, reader credentials and source-platform sign-in are separate.

## Daily operation

- **Plugins:** upload a ZIP or provide its download link in management, then wait for completion. No core rebuild or local Wrangler command is needed for each install.
- **Content:** persistent refresh tasks retain progress across page reloads. Existing contents stay readable while they update.
- **Continue after closing the page:** the default minute Cron advances one step, prioritizing plugin changes over directory work. Keeping management open advances tasks continuously. Set `triggers.crons` to `[]` if you prefer to resume by reopening the page.
- **Caching and usage:** metadata lives in D1; audio streams on demand. Players and OpenList can cache it themselves. Choose scheduled refresh scopes to match what you use.

The hosts share plugin and file semantics, while Worker pages respect invocation budgets. The source package's verification record describes free-plan and large-library evidence; successful paid-account deployment is not a free-quota measurement.

## Upgrade the core and WebUI while retaining plugins

Plugins installed through management may differ from your original local build. Use the upgrade assembler in the matching complete source package. It reads the existing Worker's exact plugin modules and replaces the core and WebUI while retaining D1, configuration and Secrets.

Install locked source dependencies, wait for any plugin change to finish, and provide the existing publishing token through `CF_API_TOKEN` or `CLOUDFLARE_API_TOKEN`:

```sh
bun run build:web
bun scripts/build-worker-upgrade.ts \
  --config /absolute/path/to/existing/wrangler.jsonc \
  --out /absolute/path/to/musicfs-upgrade
```

Use an output directory separate from the existing configuration directory. Assembly prepares files without deploying. Apply all migrations from the new directory to the existing database, then deploy:

```sh
bunx wrangler@4.119.0 d1 migrations apply musicfs --remote \
  --config /absolute/path/to/musicfs-upgrade/wrangler.jsonc
bunx wrangler@4.119.0 deploy \
  --config /absolute/path/to/musicfs-upgrade/wrangler.jsonc \
  --keep-vars --autoconfig=false
```

`--keep-vars` preserves existing variables; Secrets remain available. Finish this assembly and deployment before starting another plugin change. Open the new page, check your sources and folders, and read an existing file. [Wrangler deployment options](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)

## Files in the deployment package

| File | Purpose |
|---|---|
| `worker.mjs`, `core.mjs`, `registry.mjs` | Entry, common core and executable plugin registry |
| `plugins/<revision>/…` | Preloaded plugin modules; activation still happens through management |
| `plugin-packages/` | Original plugin ZIPs selected during the build |
| `bundle.json` | Exact modules, plugins and source identity |
| `web/` | Common management interface |
| `migrations/` | Ordered D1 migrations |
| `wrangler.jsonc` | Worker name, DB, ASSETS, Cron and compatibility configuration |

## Help and backups

| Symptom | Check |
|---|---|
| Plugin publishing is not configured | Verify `CF_API_TOKEN`, account ID and Worker name |
| Install or migration is still pending | View its progress; reopening resumes the same operation |
| A new folder is temporarily unavailable | Check refresh or file preparation, then retry the client |
| Database columns are missing after upgrade | Apply every migration from the new package to the same D1 |

Export D1:

```sh
bunx wrangler@4.119.0 d1 export musicfs --remote --output /absolute/path/to/musicfs-backup.sql
```

Keep your deployment configuration, your copy of the Secrets and the plugin release ZIPs as well. D1 holds sources and folders, while executable plugins are deployed with the Worker. [D1 export command](https://developers.cloudflare.com/d1/wrangler-commands/#d1-export)

Core changes and local verification are covered in the [development guide](development.md).
