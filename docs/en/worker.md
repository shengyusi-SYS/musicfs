# Deploy and upgrade a Cloudflare Worker

[简体中文](../worker.md)

The Worker serves the same library, management interface and WebDAV over HTTPS. Deploy in your browser or use the Worker release archive.

## Deploy in your browser

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shengyusi-SYS/musicfs)

1. Connect GitHub and Cloudflare to create your repository copy, Worker and D1 database.
2. Choose and save `ADMIN_TOKEN` for management and `DAV_USERNAME` / `DAV_PASSWORD` for players. [Create an API token](https://dash.cloudflare.com/profile/api-tokens/) in Cloudflare with **Account → Workers Scripts → Edit** permission for this account. Paste it into `CF_API_TOKEN` to let the Worker install, update and remove plugins.
3. Keep the repository root, use `bun run build` as the build command and `bun run deploy` as the deploy command. Then follow [Access and credentials](#access-and-credentials) below.
4. In **Plugins → Install plugin → Download link**, use a bundled ZIP on your own domain: `https://your-domain/plugin-packages/org.musicfs.netease.zip` for NetEase or `https://your-domain/plugin-packages/org.musicfs.qq.zip` for QQ. Then add a source and sign in.

The deployment tool fills in the account ID and Worker name and applies database migrations. Sign in to your music providers inside MusicFS afterward. [Official deployment flow](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

Future repository updates use the same deploy command, retaining D1, credentials and the exact plugins installed through management while replacing the core and WebUI. Let any plugin install or removal finish before updating. For source deployments, `bun run deploy --dry-run` assembles and checks the files without applying migrations or deploying.

<a id="first-deployment"></a>

## Deploy a release archive

Prepare a Cloudflare account, Bun and Wrangler, then extract the Worker release. To generate the directory from source, run `bun run build` and `bun run build:worker`.

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

The first three values provide initial management access and reader credentials. `CF_API_TOKEN` lets the running Worker publish plugin installs, updates and removals. [Create an API token](https://dash.cloudflare.com/profile/api-tokens/) with **Account → Workers Scripts → Edit** permission for the target account. Wrangler login authorizes your local deployment; it does not supply this runtime credential.

Apply all bundled migrations, then deploy:

```sh
bunx wrangler@4.119.0 d1 migrations apply musicfs --remote
bunx wrangler@4.119.0 deploy --secrets-file /absolute/path/to/musicfs-secrets.json
```

## Access and credentials

Open the HTTPS URL in the deployment result, or select your Worker in the Cloudflare dashboard and open its `workers.dev` domain, such as `https://musicfs.your-subdomain.workers.dev/`. Bookmark this address for later visits. Phones can open it directly too.

1. On the first visit, enter the `ADMIN_TOKEN` you chose during deployment and select **Connect**. There is no shared default token.
2. Optionally create a username and password in **Settings → Login account**. Use them for future visits with **Remember me**. `ADMIN_TOKEN` remains available for account recovery.
3. Install a plugin, add your music source and follow its sign-in steps. See the [user guide](user-guide.md) for daily use.
4. In **Connect → WebDAV players**, copy the address, username and password, or show the import QR code. The player address ends in `/dav/`, for example `https://musicfs.your-subdomain.workers.dev/dav/`.

Cloud hosting uses separate paths on the same HTTPS domain for management and WebDAV, each with its own credentials. Desktop LAN switches and local port settings are not needed.

| Credential | Used for | Set or change it |
|---|---|---|
| `ADMIN_TOKEN` | First management login and account recovery | Choose it during deployment and save it in your password manager; change it in the Worker's Secrets |
| Management username and password | Everyday management login | Create or change them in **Settings → Login account**; stored in D1 |
| `DAV_USERNAME`, `DAV_PASSWORD` | Players and remote mounts reading music | Set the initial values during deployment; later use **WebDAV players → Edit credentials**. Values saved in D1 take precedence |
| `CF_API_TOKEN` | Background plugin publishing | Create it in Cloudflare and store or replace it in Worker Secrets; do not enter it into MusicFS login or player fields |

Deployment credentials are stored as Worker Secrets, outside your public repository. To change a runtime secret, open **Workers & Pages → your Worker → Settings → Variables and Secrets**, use the Secret type and deploy the change. Build environment variables are a separate setting. [Cloudflare Secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/)

### Recover or replace credentials

- **Forgot the management username or password:** expand **Use an admin token** on the login page, enter `ADMIN_TOKEN`, then reset the account in **Settings → Login account**.
- **Forgot `ADMIN_TOKEN`:** Cloudflare does not show a saved Secret's original value. Replace `ADMIN_TOKEN` in the Worker settings above and deploy it, then enter the new token. Browsers need to sign in again; your management account and music data remain.
- **Forgot the player password:** sign in to management, view or change it under **WebDAV players**, and update your players. Once saved there, these credentials override the initial `DAV_*` Secrets.

Upgrades retain Secrets and D1, so credentials do not need to be generated again. Music-provider sign-in is stored by its plugin, separately from these credentials.

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

View runtime logs under your Worker's **Observability** page in Cloudflare. The template records application warnings, errors and uncaught exceptions without a log for every scan or Range request. See [IO diagnostics](logging.md) for temporary debug logging and correlation fields.

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
