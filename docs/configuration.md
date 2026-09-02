# Configuration reference

Everything is configured through environment variables (a `.env` in the working directory is loaded automatically). Back to the [README](../README.md).

## Environment variables

| Env var | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✓ | OAuth **Desktop** client from Google Cloud — see [Google Cloud setup](./google-cloud-setup.md) |
| `GOOGLE_ACCOUNTS` | ✓ | `alias:email,…` — e.g. `work:you@co.com,personal:you@gmail.com` |
| `MASTER_KEY` | ✓ | base64 32-byte key that encrypts the token store (`openssl rand -base64 32`) |
| `GOOGLE_PROFILE` | — | write policy: `read-only` (default) · `safe-writes` · `full-writes` |
| `GOOGLE_READ_ONLY` | — | `true` = hard kill-switch for all writes |
| `GOOGLE_WRITE_ALLOW` / `GOOGLE_WRITE_DENY` | — | glob overrides, e.g. `calendar:*`, `*:delete*` (deny wins) |
| `GOOGLE_OPTIONAL_SCOPES` | — | opt-in scope bundles, CSV — see [bundles](#optional-scope-bundles) |
| `GOOGLE_ADMIN_ACCOUNTS` | — | aliases granted Workspace-admin scopes (the account's own super-admin OAuth) |
| `GOOGLE_TOOLSETS` | — | `all` (default) or a CSV filter of service names — see [services](#services) |
| `GOOGLE_REVEAL_AT_BOOT` | — | CSV of service names (or `all`/`*`) to list on the **first** `tools/list` without calling `{service}_discover`. Use for clients (notably Claude Desktop/Cowork) that cannot select deferred tools after `tools/list_changed`. Example: `drive` so `drive_upload` is callable for deck posts. |
| `TOKEN_STORE_PATH` | — | override the encrypted token dir (default: `$XDG_CONFIG_HOME/mcp-google-multi/tokens`, falling back to `~/.config/mcp-google-multi/tokens`) |
| `DISCOVERY_CACHE_PATH` | — | override the Discovery-doc cache dir (default: `$XDG_CONFIG_HOME/mcp-google-multi/discovery`, falling back to `~/.config/mcp-google-multi/discovery`) |
| `GOOGLE_TRIM` | — | `off` (or `0`/`false`/`no`) disables compact JSON serialization of tool responses |
| `GOOGLE_GRANTS_PATH` | — | host-local grants file (default: `~/.config/mcp-google-multi/grants.json`) — see [Session grants](#session-grants-my-flowstyle) |
| `GOOGLE_GRANTS_ENFORCE` | — | `true` force fail-closed grants; `false` disable even if grants file exists; default = enforce when file has ≥1 grant |
| `GOOGLE_GRANT_CODE` | — | optional process-wide fallback code (prefer session tool `set_grant` or Grok OAuth-bound grant) |
| `MCP_HTTP_TOKEN` / `MCP_API_KEY` | hosted | Layer 2 gate for `POST /mcp` (Secret Manager). Grok OAuth wraps this token only. |
| `MCP_PUBLIC_HOST` | hosted | Public hostname (Cloud Run). Never `localhost:8787`. |
| `MCP_HOSTED` | — | `1` force hosted (no browser, no 8000/8787/4242); `0` force desk. Cloud Run sets `K_SERVICE`. |

Hosted / Grok Bot: see [hosted-mcp.md](./hosted-mcp.md) (three layers: provider credentials, MCP HTTP token, session grant).

Inspect the resolved setup any time: `mcp-google-multi config check`.

## Session grants (My Flow–style)

Without a session grant, multi-account tools can reach **every** alias in `GOOGLE_ACCOUNTS`. Session grants (layer 3) close that gap the same way My Flow MCP does for orgs. They do **not** log into Google — each alias is still minted with singular desk OAuth (layer 1).

1. Host-local file `grants.json` (see `grants.example.json`) maps **name + code → account aliases**.
2. **Stdio / CLI:** call `set_grant` / `clear_grant` / `grant_status` at session start (in-process).
3. **Hosted Grok:** enter the grant code on `/oauth/authorize`; the access JWT carries the grant *name* so every Cloud Run replica restores the same slice (no sticky sessions). In-process `set_grant` alone does not survive another instance.
4. When enforcement is on, `account_list`, fan-out `*`, and `getClient` only allow aliases on the active grant. Fail-closed if no grant.

**Codes stay host-local** — never commit real codes. You may reuse the **same secret** as a My Flow grant code so operators keep one code per brain; Google only looks up its own `grants.json`.

| Recipe name (example) | Typical accounts |
|----------------------|------------------|
| Personal Brain Grant 3 | all aliases (personal, stromback, opcenter, …) |
| StrombackBrain2 | `stromback` only |

`GOOGLE_PROFILE` (read-only / safe-writes / full-writes) is **write-control**, not brain isolation — do not confuse the two.

## Write-control (deny-by-default)

Reads are never gated. **Every create/update/delete is off until you opt in** — pick a profile:

| `GOOGLE_PROFILE` | Allows |
|---|---|
| `read-only` (default) | reads only |
| `safe-writes` | create + update (deletes still blocked) |
| `full-writes` | everything |

`GOOGLE_READ_ONLY=true` overrides all. For fine control: `GOOGLE_WRITE_ALLOW="calendar:*, sheets:update*"` and `GOOGLE_WRITE_DENY="*:delete*"` (deny wins). The policy applies identically to curated tools, generated tools, and the escape hatch.

## Services

Core services register by default: `gmail`, `drive`, `calendar`, `sheets`, `docs`, `contacts`, `searchconsole`, `tasks`, `meet`, `workspaceevents`.

Optional services register when their bundle is enabled (below): `slides`, `forms`, `chat`, `classroom`, `cloudidentity`, `cloudsearch`, `vault`, `keep`, `driveactivity`, `drivelabels`, `script`, `postmaster`, `groupssettings`, `groupsmigration`, `licensing`, `reseller`, `appsmarket` — plus `admin`, which requires `GOOGLE_ADMIN_ACCOUNTS`.

`GOOGLE_TOOLSETS` is a filter only: listing an optional service does not enable it without its bundle/admin gate.

## Optional scope bundles

Add bundle names to `GOOGLE_OPTIONAL_SCOPES` (CSV), then re-run `auth` for each account so the new scopes are granted:

`slides`, `forms`, `chat`, `classroom`, `cloudidentity`, `cloudsearch`, `vault`, `keep`, `driveactivity`, `drivelabels`, `script`, `postmaster`, `groupssettings`, `groupsmigration`, `licensing`, `reseller`, `appsmarket`.

Two bundles extend the always-on `gmail` service instead of enabling a new one — Gmail settings **writes** only accept the dedicated settings scopes (reads already work with the base scope):

| Bundle | Scope | Unlocks |
|---|---|---|
| `gmail_settings` | `gmail.settings.basic` | writing filters, vacation responder, IMAP/POP, language |
| `gmail_settings_sharing` | `gmail.settings.sharing` | send-as, delegates, auto-forwarding — kept separate because it can redirect or delegate your mail |

A tool whose scope was never granted returns a typed `insufficient_scope` error with a re-auth hint instead of failing silently.

## Secrets management

Don't leave `GOOGLE_CLIENT_SECRET` + `MASTER_KEY` in a plaintext `.env` for daily use — inject them at launch from a secrets manager. See [Secrets in a vault](./secrets.md).
