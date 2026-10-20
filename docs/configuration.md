# Configuration reference

Everything is configured through environment variables and an optional `${XDG_CONFIG_HOME:-~/.config}/mcp-google-multi/config.json`. `.env` files load automatically with this precedence (highest first): real environment, then `.env` in the working directory, then `.env` in the package root, then `${XDG_CONFIG_HOME:-~/.config}/mcp-google-multi/.env`. Set `MCP_GOOGLE_MULTI_ENV=/abs/path/.env` to load exactly that file instead of searching; a missing or unreadable pointed file is a fatal `E_ENV_NOT_FOUND`. Node.js 22+ is required; older runtimes exit with `E_NODE_TOO_OLD`. Back to the [README](../README.md).

## config.json (account registry)

Accounts live in a mutable, plaintext-by-design `config.json` (no secrets ever; safe to commit):

```jsonc
{
  "version": 1,
  "accounts": {
    "work":     { "email": "you@company.com", "admin": true },
    "personal": { "email": "you@gmail.com" }
  }
}
```

- **Env override:** while `GOOGLE_ACCOUNTS` is set and non-empty, the whole registry comes from env and the file is ignored (12-factor deployments keep working unchanged). `GOOGLE_ADMIN_ACCOUNTS`, when set, overrides per-account `admin` flags.
- **`mcp-google-multi migrate-config`** synthesizes the file from your current env (idempotent; never edits env).
- On first start with `GOOGLE_ACCOUNTS` set and no file, the file is materialized automatically.
- Secrets (`GOOGLE_CLIENT_ID`/`SECRET`, `MASTER_KEY`) are never config fields — a secret-shaped key fails validation (`E_CONFIG_INVALID`).
- Startup errors: no accounts anywhere = `E_NO_ACCOUNTS_CONFIGURED`; invalid file = `E_CONFIG_INVALID`; a file written by a newer version = `E_CONFIG_VERSION_UNSUPPORTED` (upgrade the package).

## Scope profiles (per-account consent)

Each account can point at a named **scope profile** so consent is exactly what that account uses — a Workspace account can carry admin + `gmail_settings` while a personal account is never asked for them:

```jsonc
{
  "version": 1,
  "accounts": {
    "work":     { "email": "you@company.com", "scopeProfile": "workspace-admin" },
    "personal": { "email": "you@gmail.com" }
  },
  "scopeProfiles": {
    "workspace-admin": { "bundles": ["gmail_settings", "chat"], "admin": true }
  }
}
```

- A missing `scopeProfile` means the built-in `base` profile (base scopes only). `admin: true` on a profile equals including the `admin` bundle.
- Services register for the **union** of every account's bundles; authorization stays per account at call time (an account without the bundle gets a scope error with a re-auth hint, not silent access).
- Changing a profile changes that account's consent set — re-run `auth --account <alias>` for it.
- An unknown bundle name fails startup with `E_UNKNOWN_BUNDLE` and a did-you-mean suggestion.
- `"includesBase": false` on a profile drops the base scopes (advanced; a profile that resolves to zero scopes fails `E_CONFIG_INVALID`).
- `GOOGLE_OPTIONAL_SCOPES` still works as a legacy global override applied to every account (warns `E_LEGACY_GLOBAL_SCOPES`; `migrate-config` folds it into an explicit `legacy-global` profile).

### Bundle catalog

| Bundle | Risk | Unlocks |
|---|---|---|
| `slides` | low | Create and edit Slides presentations |
| `keep` | low | Read and edit Keep notes (not for a personal account) |
| `driveactivity` | low | Read the Drive activity feed |
| `postmaster` | low | Read Postmaster Tools deliverability data |
| `analytics` | low | Read Google Analytics (GA4): reports, realtime, account/property config |
| `analytics_write` | medium | Edit GA4 configuration: properties, streams, key events, custom definitions (includes read) |
| `forms` | medium | Build Forms and read responses |
| `chat` | medium | Read/send Chat messages, manage spaces |
| `gmail_settings` | medium | Mailbox settings: filters, labels, vacation |
| `classroom` | medium | Courses, coursework, rosters, announcements |
| `cloudsearch` | medium | Query Cloud Search across Workspace content |
| `drivelabels` | medium | Manage Drive labels |
| `script` | medium | Apps Script projects and deployments |
| `groupssettings` | medium | Google Groups settings |
| `gmail_settings_sharing` | high | Forwarding/delegation — can route mail out |
| `cloudidentity` | high | Cloud Identity groups and devices (not for a personal account) |
| `groupsmigration` | high | Migrate messages into Groups |
| `licensing` | high | Assign/revoke license seats |
| `reseller` | high | Reseller subscriptions and orders |
| `appsmarket` | high | Marketplace license assignments |
| `vault` | high (Workspace-only) | eDiscovery over the whole domain |
| `admin` | high (Workspace-only) | Directory management + audit reports |

Google refuses the `keep` and `cloudidentity` scopes on a personal account's consent screen, and the refusal fails the whole sign-in. So for a `gmail.com` or `googlemail.com` address, `allBundles` leaves both out, and naming either one is refused with `E_VALIDATION`.

## Environment variables

| Env var | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✓ | OAuth **Desktop** client from Google Cloud — see [Google Cloud setup](./google-cloud-setup.md) |
| `GOOGLE_ACCOUNTS` | — | `alias:email,…` — e.g. `work:you@co.com,personal:you@gmail.com`. When set and non-empty it replaces the `config.json` registry; one of the two must define at least one account |
| `GOOGLE_DEFAULT_ACCOUNT` | | Alias used when a tool call omits `account` (or set `"defaultAccount"` in config.json; env wins; note: while `GOOGLE_ACCOUNTS` is set, the whole registry — including the default — comes from env, so the config field is inert). Unset = `account` stays required per call (`E_NO_DEFAULT_ACCOUNT` hint on omission). An alias that is not configured fails startup with `E_DEFAULT_ACCOUNT_UNKNOWN`. Explicit aliases, `*` and CSV are never affected |
| `GOOGLE_DISCOVERY` | | Tool-surface visibility: `lazy` (default on stdio — meta-tools only until `{service}_discover`), `curated` (all curated tools advertised eagerly), `eager` (everything). An invalid value warns and falls back to `lazy`. House `dist/http.js` upgrades unset/`lazy` to curated on the connect-time `tools/list` (stateless; Grok does not rebind after discover). Bakissation `MCP_TRANSPORT=http` forces `curated`. `eager` is unchanged |
| `MASTER_KEY` | | encrypts the token store. Optional: resolved as env > OS keychain > `master.key` (0600, in the config dir) > generated on first use. Keep it in env for deployments that may downgrade or move hosts. Never regenerated while encrypted tokens exist (`E_MASTER_KEY_MISSING_TOKENS_EXIST`) |
| `GOOGLE_PROFILE` | — | write policy: `read-only` (default) · `safe-writes` · `full-writes`; an invalid value warns and falls back to `read-only`. Session grants do not change this profile |
| `GOOGLE_READ_ONLY` | — | `true` (or `1`/`yes`) = hard kill-switch for all writes |
| `GOOGLE_WRITE_ALLOW` / `GOOGLE_WRITE_DENY` | — | glob overrides, e.g. `calendar:*`, `*:delete*` (deny wins) |
| `GOOGLE_OPTIONAL_SCOPES` | — | legacy: CSV of scope bundles applied to every account (warns `E_LEGACY_GLOBAL_SCOPES`; prefer [scope profiles](#scope-profiles-per-account-consent)) — see [bundles](#optional-scope-bundles) |
| `GOOGLE_ADMIN_ACCOUNTS` | — | aliases granted Workspace-admin scopes (the account's own super-admin OAuth); when set, overrides per-account `admin` flags |
| `GOOGLE_TOOLSETS` | — | `all` (default) or a CSV filter of service names; unknown names warn and are ignored — see [services](#services) |
| `GOOGLE_REVEAL_AT_BOOT` | — | CSV of service names (or `all`/`*`) to list on the **first** `tools/list` without calling `{service}_discover`. Use for clients (notably Claude Desktop/Cowork) that cannot select deferred tools after `tools/list_changed`. Example: `drive` so `drive_upload` is callable for deck posts. |
| `TOKEN_STORE_PATH` | — | override the encrypted token dir (default: `$XDG_CONFIG_HOME/mcp-google-multi/tokens`, falling back to `~/.config/mcp-google-multi/tokens`) |
| `DISCOVERY_CACHE_PATH` | — | override the Discovery-doc cache dir (default: `$XDG_CONFIG_HOME/mcp-google-multi/discovery`, falling back to `~/.config/mcp-google-multi/discovery`) |
| `GOOGLE_ARG_UNKNOWN` | `reject` | what to do with a `tools/call` argument the tool does not declare: `reject` (default) refuses the call with a typed `unknown_argument` error naming the likely intended parameter, `warn` logs it to stderr and drops it, `off` drops it silently. A bad value falls back to `warn`, not to the default. Never screened: keys starting with `_`, keys containing `/`, the client artifacts `random_string`/`toolCallId`/`tool_call_id`/`tool_call_description`, tools that declare no arguments, and a key whose declared twin the same call also sent |
| `GOOGLE_OUTBOUND_ALLOWLIST` | off | opt-in outbound target allowlist for unattended deployments: comma-separated addresses and `@domain` suffixes gating Gmail recipients, Calendar attendees and Drive grantees (curated tools, generated tools and the escape hatch; while active, uninspectable raw-compose methods and `drive_share` `anyone` link shares are refused). Blocked calls fail with `recipient_not_allowed` and a hint |
| `GOOGLE_USAGE_METRICS` | off | local usage metrics: `on\|1\|true\|yes` enables, `off\|0\|false\|no` disables; any other value warns and stays OFF; wins over the `usageMetrics` config key. See [usage-metrics.md](./usage-metrics.md) |
| `usageMetrics` (config.json) | absent = off | same switch as a config key; remove it before downgrading below 6.0 (strict schema) |
| `USAGE_METRICS_PATH` | — | override the metrics dir (default: `$XDG_STATE_HOME/mcp-google-multi/metrics`, falling back to `~/.local/state/mcp-google-multi/metrics`); setting the path alone enables nothing |
| `GOOGLE_TRIM` | — | `off` (or `0`/`false`/`no`) disables compact JSON serialization of tool responses |
| `GOOGLE_ARG_NORMALIZE` | — | `off` (or `0`/`false`/`no`) disables tools/call argument-key normalization (snake_case → declared camelCase when unambiguous; each rename logs one line to stderr) |
| `GOOGLE_GRANTS_PATH` | — | host-local grants file (default: `~/.config/mcp-google-multi/grants.json`) — see [Session grants](#session-grants-my-flowstyle) |
| `GOOGLE_GRANTS_ENFORCE` | — | `true` force fail-closed grants; `false` disable even if grants file exists; default = enforce when file has ≥1 grant |
| `GOOGLE_GRANT_CODE` | — | optional process-wide fallback code (prefer session tool `set_grant` or Grok OAuth-bound grant) |
| `MCP_HTTP_TOKEN` / `MCP_API_KEY` | hosted | Layer 2 gate for house `POST /mcp` (Secret Manager). Grok OAuth wraps this token only. |
| `MCP_PUBLIC_HOST` | hosted | Public hostname for house Streamable HTTP. Never `localhost:8787`. |
| `MCP_HOSTED` | — | `1` force hosted (no browser, no 8000/8787/4242); `0` force desk. Cloud Run sets `K_SERVICE`. |
| `GOOGLE_CLOUD_PROJECT` / `GCP_PROJECT` | desk SM | Explicit GCP project for desk→Secret Manager token uploads. Required when `--upload-sm` / `GOOGLE_UPLOAD_SM` is on. Never `gcloud config get-value project`. |
| `GOOGLE_UPLOAD_SM` / `GOOGLE_SM_UPLOAD` | desk SM | `1`/`true`/`yes`/`on` — `auth --account` is incomplete until `google-mcp-token-<alias>` gets a new version (same as `--upload-sm`). Default off; CI stays dry/mocked. |
| `MCP_GOOGLE_MULTI_ENV` | — | absolute path of the one `.env` file to load instead of searching (see top of page) |
| `MCP_TRANSFER_PASSPHRASE` | — | passphrase for `account export` / `account import`; unset = prompt on a TTY |

Hosted / Grok Bot: see [hosted-mcp.md](./hosted-mcp.md) (three layers: provider credentials, MCP HTTP token, session grant).

Inspect the resolved setup any time: `mcp-google-multi config check`.

## Session grants (My Flow–style)

Without a session grant, multi-account tools can reach **every** alias in `GOOGLE_ACCOUNTS`. Session grants (layer 3) close that gap the same way My Flow MCP does for orgs. They do **not** log into Google — each alias is still minted with singular desk OAuth (layer 1).

1. Host-local file `grants.json` (see `grants.example.json`) maps **name + code → account aliases**.
2. **Stdio / CLI:** call `set_grant` / `clear_grant` / `grant_status` at session start (in-process).
3. **Hosted Grok:** enter the grant code on `/oauth/authorize`; the access JWT carries the grant *name* (`gname`) so every Cloud Run replica restores the same slice (no sticky sessions). Hosted `set_grant` is refused — it only mutates process memory and does not survive another instance.
4. When enforcement is on, `account_list`, fan-out `*`, and `getClient` only allow aliases on the active grant. Fail-closed if no grant. `account_add` and `account_reauth` refuse an alias outside that grant (`account_outside_grant`) before they write the registry or start consent. `account_write_config` refuses while any configured account sits outside the grant, because that write is process-wide.

**Codes stay host-local** — never commit real codes. You may reuse the **same secret** as a My Flow grant code so operators keep one code per brain; Google only looks up its own `grants.json`.

| Recipe name (example) | Typical accounts |
|----------------------|------------------|
| Personal Brain Grant 3 | personal, stromback, opcenter, buildcoin (Cosmos-related aliases stay here) |
| StrombackBrain2 | `stromback` only |

`GOOGLE_PROFILE` (read-only / safe-writes / full-writes) is **write-control**, not brain isolation — do not confuse the two. v6 `safe-writes` also refuses privileged org/Vault/script writes and `*_watch` push registrations (`MIGRATION-v6.md`).

## Transport

By default `dist/index.js` speaks **stdio** (`MCP_TRANSPORT=stdio`). It can also serve bakissation's Streamable HTTP (`src/http-transport.ts`) when `MCP_TRANSPORT` is `http` or `both`.

The house Cloud Run image does **not** use that path. `Dockerfile` runs `docker/entrypoint.sh` → `dist/http.js` (`src/http.ts`: Grok OAuth, JWT `gname`, per-request `buildGoogleMcpServer`). Bakissation's distroless `MCP_TRANSPORT=http` Dockerfile was not taken.

| Variable | Default | Notes |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio`, `http`, or `both` — applies to `dist/index.js`, not house `dist/http.js` |
| `MCP_HTTP_HOST` | `127.0.0.1` | bind address for `src/http-transport.ts` |
| `MCP_HTTP_PORT` | `4243` | bind port for `src/http-transport.ts` |
| `MCP_PUBLIC_URL` | `http://<host>:<port>` | canonical public base for the upstream transport; `${MCP_PUBLIC_URL}/mcp` is the endpoint |
| `MCP_OWNER_EMAILS` | *(required for upstream http)* | CSV of Google emails allowed to authenticate; upstream HTTP refuses to start without it |
| `MCP_ALLOWED_ORIGINS` | — | extra Origins beyond `MCP_PUBLIC_URL` and `https://claude.ai` |
| `MCP_CIMD_ALLOWED_ISSUERS` | `claude.ai` | CSV host allowlist for OAuth client-metadata documents. Other clients that pick CIMD are refused with `invalid_client` until their host is listed |
| `MCP_ACCESS_TTL` | `600` | MCP access-token lifetime (seconds) on the upstream authorization server |
| `MCP_JWT_KEY` | auto | signing key for the upstream server's own MCP tokens; resolved like `MASTER_KEY`. Regenerating it only signs those clients out. House Grok JWTs use the house key in `src/oauth.ts` |

Over upstream HTTP the process is its own **OAuth 2.1 authorization server** (owner gate, audience-bound token). That is a different OAuth surface from house Grok OAuth in `src/oauth.ts`. Full upstream remote-HTTP walkthrough is in [docs/http-setup.md](./http-setup.md). This isolate does not deploy either transport. The house `Dockerfile` stays the Cloud Run `dist/http.js` image; bakissation's distroless `MCP_TRANSPORT=http` image was not taken.

## Write-control (deny-by-default)

Reads are never gated. **Every create/update/delete is off until you opt in** — pick a profile:

| `GOOGLE_PROFILE` | Allows |
|---|---|
| `read-only` (default) | reads only |
| `safe-writes` | create + update on your own data (Trash moves, permanent deletes, and privileged writes blocked) |
| `full-writes` | everything |

`GOOGLE_READ_ONLY=true` overrides all; an invalid `GOOGLE_PROFILE` falls back to `read-only`. For fine control: `GOOGLE_WRITE_ALLOW="calendar:*, sheets:update*"` and `GOOGLE_WRITE_DENY="*:delete*"` (deny wins). Each tool matches as `service:cud` and as `service:op` (its name minus the service prefix), so a tool named after its own class shares that class's pattern: `drive:update` matches `drive_update` and every other update-class Drive tool (`drive_move`, `drive_permission_update`, …). The policy applies identically to curated tools, generated tools, and the escape hatch.

### What `safe-writes` refuses beyond deletes

"Not a delete" is a statement about an HTTP verb, not about consequences. `safe-writes` also refuses two classes of write that are shaped like an ordinary create or update:

- **Privileged scope.** The method can be authorized by a scope that acts on the whole organization, on legal holds, on billing, or on deployed code: `admin.directory.*`, `admin.datatransfer`, `cloud-identity*`, `apps.licensing`, `apps.order`, `apps.groups.settings`, `apps.groups.migration`, `ediscovery*` (Vault), `script.projects`, `script.deployments`. This is what stops `admin_users_make_admin` and `admin_two_step_verification_turn_off`, both of which are plain `update`s.
- **Push-channel registration.** Any `*_watch` method, plus `workspaceevents` subscription create and reactivate. These register a webhook that delivers your activity to an external URL, so they are exports wearing the shape of a create.

The rule is derived from each method's declared scopes and name, not from a hand-kept list, so it keeps working as the generated surface is regenerated. A method whose scopes are unknown is treated as **not** privileged: absent information is not evidence, and failing the other way would break ordinary writes.

`GOOGLE_WRITE_ALLOW` still wins over this, because naming a tool explicitly is a deliberate opt-in. `GOOGLE_WRITE_DENY` still wins over that.

### Trash stays denied under every profile

`gmail_trash`, `drive_trash`, and `gmail_users_threads_trash` move an item to Trash. Upstream safe-writes treats that as an ordinary write. This hosted build does not: no profile (`read-only`, `safe-writes`, or `full-writes`) permits them. Opt in to one tool with an allow glob that matches its operation, for example `GOOGLE_WRITE_ALLOW="gmail:trash"`. A delete-class pattern such as `gmail:delete` does not open Trash. `GOOGLE_WRITE_DENY` still wins over that allow. Untrash (`drive_untrash` and the generated Gmail untrash twins) is an update, so `safe-writes` still allows it. Emptying Trash, a permanent delete, and `drive_transfer`'s `move` flag stay refused under `safe-writes`.

## Services

Core services register by default: `gmail`, `drive`, `calendar`, `sheets`, `docs`, `contacts`, `searchconsole`, `tasks`, `meet`, `workspaceevents`.

Optional services register when their bundle is enabled (below): `slides`, `forms`, `chat`, `analytics` (or `analytics_write`), `classroom`, `cloudidentity`, `cloudsearch`, `vault`, `keep`, `driveactivity`, `drivelabels`, `script`, `postmaster`, `groupssettings`, `groupsmigration`, `licensing`, `reseller`, `appsmarket` — plus `admin`, which requires `GOOGLE_ADMIN_ACCOUNTS`.

`GOOGLE_TOOLSETS` is a filter only: listing an optional service does not enable it without its bundle/admin gate.

## Optional scope bundles

Add bundle names to an account's [scope profile](#scope-profiles-per-account-consent) (or, legacy, to `GOOGLE_OPTIONAL_SCOPES` as CSV for every account), then re-run `auth --account <alias>` so the new scopes are granted:

`slides`, `forms`, `chat`, `analytics`, `analytics_write`, `classroom`, `cloudidentity`, `cloudsearch`, `vault`, `keep`, `driveactivity`, `drivelabels`, `script`, `postmaster`, `groupssettings`, `groupsmigration`, `licensing`, `reseller`, `appsmarket`.

Two bundles extend the always-on `gmail` service instead of enabling a new one — Gmail settings **writes** only accept the dedicated settings scopes (reads already work with the base scope):

| Bundle | Scope | Unlocks |
|---|---|---|
| `gmail_settings` | `gmail.settings.basic` | writing filters, vacation responder, IMAP/POP, language |
| `gmail_settings_sharing` | `gmail.settings.sharing` | send-as, delegates, auto-forwarding — kept separate because it can redirect or delegate your mail |

A tool whose scope was never granted returns a typed `insufficient_scope` error with a re-auth hint instead of failing silently.

## Secrets management

Don't leave `GOOGLE_CLIENT_SECRET` + `MASTER_KEY` in a plaintext `.env` for daily use — inject them at launch from a secrets manager. See [Secrets in a vault](./secrets.md).
