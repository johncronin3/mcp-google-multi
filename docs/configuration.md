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
| `GOOGLE_DISCOVERY` | | Tool-surface visibility: `lazy` (default — meta-tools only until `{service}_discover`), `curated` (all 191 curated tools advertised eagerly), `eager` (everything). An invalid value warns and falls back to `lazy`; over the upstream HTTP transport the mode is always `curated`. At runtime an agent can `discover_all` / `discover_reset` to expand/collapse a lazy surface without config changes. House `dist/http.js` upgrades unset/`lazy` to `curated` on the connect-time `tools/list` (stateless; Grok does not rebind after discover). `eager` is unchanged |
| `MASTER_KEY` | | encrypts the token store. Optional: resolved as env > OS keychain > `master.key` (0600, in the config dir) > generated on first use. Keep it in env for deployments that may downgrade or move hosts. Never regenerated while encrypted tokens exist (`E_MASTER_KEY_MISSING_TOKENS_EXIST`) |
| `GOOGLE_PROFILE` | — | write policy: `read-only` (default) · `safe-writes` · `full-writes`; an invalid value warns and falls back to `read-only` |
| `GOOGLE_READ_ONLY` | — | `true` (or `1`/`yes`) = hard kill-switch for all writes |
| `GOOGLE_WRITE_ALLOW` / `GOOGLE_WRITE_DENY` | — | glob overrides, e.g. `calendar:*`, `*:delete*` (deny wins) |
| `GOOGLE_OPTIONAL_SCOPES` | — | legacy: CSV of scope bundles applied to every account (warns `E_LEGACY_GLOBAL_SCOPES`; prefer [scope profiles](#scope-profiles-per-account-consent)) — see [bundles](#optional-scope-bundles) |
| `GOOGLE_ADMIN_ACCOUNTS` | — | aliases granted Workspace-admin scopes (the account's own super-admin OAuth); when set, overrides per-account `admin` flags |
| `GOOGLE_TOOLSETS` | — | `all` (default) or a CSV filter of service names; unknown names warn and are ignored — see [services](#services) |
| `GOOGLE_LOCAL_FILES` | on | `off` (or `0`/`false`/`no`, any case; an unrecognised value warns and stays "on") removes every host-file tool/param (Gmail attachments, Drive `localPath`/`savePath`, `drive_download`, `drive_export`, `gmail_download_attachment`) even from the owner session that would otherwise get them. These are already owner-only and share one confinement policy, see [features.md](./features.md#host-file-access-one-policy-an-off-switch) |
| `GOOGLE_LOCAL_FILES_DIR` | `~/Downloads/mcp-google-multi` | the allow-list root every host-file read and write must resolve inside (realpath, so a symlink cannot escape it); a relative path or filename resolves inside this root. Created on first use (mode `0700`) if missing. The server's own config/token directory, Discovery cache, `/proc`, and any `.env` file it loaded secrets from stay refused even when they fall inside a root set too wide (e.g. `$HOME`) |
| `GOOGLE_REVEAL_AT_BOOT` | — | CSV of service names (or `all`/`*`) to list on the **first** `tools/list` without calling `{service}_discover`. Use for clients (notably Claude Desktop/Cowork) that cannot select deferred tools after `tools/list_changed`. Example: `drive` so `drive_upload` is callable for deck posts. |
| `TOKEN_STORE_PATH` | — | override the encrypted token dir (default: `$XDG_CONFIG_HOME/mcp-google-multi/tokens`, falling back to `~/.config/mcp-google-multi/tokens`) |
| `DISCOVERY_CACHE_PATH` | — | override the Discovery-doc cache dir (default: `$XDG_CONFIG_HOME/mcp-google-multi/discovery`, falling back to `~/.config/mcp-google-multi/discovery`) |
| `GOOGLE_ARG_UNKNOWN` | `reject` | what to do with a `tools/call` argument the tool does not declare: `reject` (default) refuses the call with a typed `unknown_argument` error naming the likely intended parameter, `warn` logs it to stderr and drops it, `off` drops it silently. A bad value falls back to `warn`, not to the default. Never screened: keys starting with `_`, keys containing `/`, the client artifacts `random_string`/`toolCallId`/`tool_call_id`/`tool_call_description`, tools that declare no arguments, and a key whose declared twin the same call also sent |
| `GOOGLE_OUTBOUND_ALLOWLIST` | off | opt-in outbound target allowlist for unattended deployments: comma-separated addresses and `@domain` suffixes gating Gmail recipients, Calendar attendees and Drive permission/access-proposal grantees on **curated tools only** (`gmail_send`/`create_draft`/`send_draft`, calendar attendees, `drive_share`, `drive_permission_update`, `drive_access_proposal_resolve`, `drive_revision_update`'s publish flags, `gmail_set_vacation`'s unrestricted auto-reply). `drive_permission_update` and `drive_access_proposal_resolve` never trust their own call's body for the grantee (neither carries one); each looks the real grantee up itself (the existing permission's type/domain/email, or the proposal's recipient) and checks that instead, so a role **downgrade** (e.g. writer to reader) on a permission whose grantee is `anyone`/an unlisted domain is refused too, not just an upgrade. Blocked calls fail with `recipient_not_allowed` and a hint. The escape hatch (`google_api_call` and every generated per-method tool) has no content-based reasoning of its own here: see [Escape hatch](#escape-hatch-writes-ask-for-confirmation) below for what this variable does to it instead |
| `GOOGLE_USAGE_METRICS` | off | local usage metrics: `on\|1\|true\|yes` enables, `off\|0\|false\|no` disables; any other value warns and stays OFF; wins over the `usageMetrics` config key. See [usage-metrics.md](./usage-metrics.md) |
| `usageMetrics` (config.json) | absent = off | same switch as a config key; remove it before downgrading below 6.0 (strict schema) |
| `USAGE_METRICS_PATH` | — | override the metrics dir (default: `$XDG_STATE_HOME/mcp-google-multi/metrics`, falling back to `~/.local/state/mcp-google-multi/metrics`); setting the path alone enables nothing |
| `GOOGLE_TRIM` | — | `off` (or `0`/`false`/`no`) disables compact JSON serialization of tool responses |
| `GOOGLE_ARG_NORMALIZE` | — | `off` (or `0`/`false`/`no`) disables tools/call argument-key normalization (snake_case → declared camelCase when unambiguous; each rename logs one line to stderr) |
| `GOOGLE_GRANTS_PATH` | — | host-local grants file (default: `~/.config/mcp-google-multi/grants.json`) — see [Session grants](#session-grants-my-flowstyle) |
| `GOOGLE_GRANTS_ENFORCE` | — | `true` force fail-closed grants; `false` disable even if grants file exists; default = enforce when file has ≥1 grant |
| `GOOGLE_GRANT_CODE` | — | desk/stdio process-wide fallback code (prefer `set_grant`). Ignored on hosted. |
| `MCP_HTTP_TOKEN` / `MCP_API_KEY` | hosted | Layer 2 gate for house `POST /mcp` (Secret Manager). Grok OAuth password field checks this value. It does not sign JWTs. |
| `MCP_JWT_SIGNING_KEY_FILE` | hosted | File path of the house Grok JWT signing key (Secret Manager mount `google-mcp-jwt-signing-key`). At least 32 bytes. Missing, short, or unreadable fails closed on hosted and does not fall back to the bearer. |
| `MCP_JWT_SIGNING_KEY` | desk | Same key as an env string for desk/stdio only. Ignored on hosted (`MCP_HOSTED` / `K_SERVICE`). At least 32 bytes. |
| `MCP_OAUTH_REFRESH_TTL` | 30 days | House Grok refresh-token lifetime in seconds. Access tokens are 1 hour. Refresh keeps `gname`. |
| `MCP_HTTP_TOKEN_GRANT` | — | Optional grant **name** bound to the static `MCP_HTTP_TOKEN` / `MCP_API_KEY` bearer. Resolved from the grants file on every request and wrapped in `runWithGrant`. Unset (the default) or unknown → that request is grantless and fails closed. It does not inherit in-process `set_grant` or `GOOGLE_GRANT_CODE`. Not set in deploy files. |
| `MCP_PUBLIC_HOST` | hosted | Public hostname for house Streamable HTTP. Never `localhost:8787`. |
| `MCP_HOSTED` | — | `1` force hosted (no browser, no 8000/8787/4242); `0` force desk. Cloud Run sets `K_SERVICE`. |
| `GOOGLE_CLOUD_PROJECT` / `GCP_PROJECT` | desk SM | Explicit GCP project for desk→Secret Manager token uploads. Required when `--upload-sm` / `GOOGLE_UPLOAD_SM` is on. Never `gcloud config get-value project`. Interim pin if a comment must name one: `myflow-260730`. |
| `GOOGLE_UPLOAD_SM` / `GOOGLE_SM_UPLOAD` | desk SM | `1`/`true`/`yes`/`on` — `auth --account` is incomplete until `google-mcp-token-<alias>` gets a new version (same as `--upload-sm`). Default off; CI stays dry/mocked. |
| `MCP_GOOGLE_MULTI_ENV` | — | absolute path of the one `.env` file to load instead of searching (see top of page) |
| `MCP_TRANSFER_PASSPHRASE` | — | passphrase for `account export` / `account import`; unset = prompt on a TTY |

Hosted / Grok Bot: see [hosted-mcp.md](./hosted-mcp.md) (three layers: provider credentials, MCP HTTP token, session grant).

Inspect the resolved setup any time: `mcp-google-multi config check`.

## Session grants (My Flow–style)

Without a session grant, multi-account tools can reach **every** alias in `GOOGLE_ACCOUNTS`. Session grants (layer 3) close that gap the same way My Flow MCP does for orgs. They do **not** log into Google — each alias is still minted with singular desk OAuth (layer 1).

1. Host-local file `grants.json` (see `grants.example.json`) maps **name + code → account aliases**.
2. **Stdio / CLI:** call `set_grant` / `clear_grant` / `grant_status` at session start (in-process). Desk stdio may also use `GOOGLE_GRANT_CODE`.
3. **Hosted Grok:** `/oauth/authorize` always requires the grant's secret code (constant-time compare), even when `GOOGLE_GRANTS_ENFORCE` is off. The bearer plus a grant name, or the bearer alone, does not mint a token. Desk/stdio still requires the code only when enforcement is on. The access JWT carries the grant *name* (`gname`) so every Cloud Run replica restores the same slice (no sticky sessions). Hosted `set_grant` is refused — it only mutates process memory and does not survive another instance. On hosted, a request has only its own grant or null: no in-process `set_grant` and no `GOOGLE_GRANT_CODE`.
4. **Static bearer** (`Authorization: Bearer <MCP_HTTP_TOKEN>`, or `MCP_API_KEY`): wrapped in `runWithGrant` of `MCP_HTTP_TOKEN_GRANT` on every request. Unset fails closed. This is not the OAuth consent flow.
5. When enforcement is on, `account_list`, fan-out `*`, and `getClient` only allow aliases on the active grant. Fail-closed if no grant.

**Codes stay host-local** — never commit real codes. You may reuse the **same secret** as a My Flow grant code so operators keep one code per brain; Google only looks up its own `grants.json`.

Optional `notBefore` (ISO-8601) on a grant record refuses refresh and `/mcp` for tokens whose `iat` is earlier. That revokes one grant without rotating the JWT signing key. See `grants.example.json`. Code lookup and name lookup re-read `grants.json` on each check, so a removed grant or a new `notBefore` applies without a restart. There is no file watcher. `grant_status` reports `code_sha8` (8 hex chars of SHA-256), never a prefix of the code. A code shorter than 24 characters, or equal to its grant name ignoring case, is rejected when the file loads. The error names the grant only. On hosted that load runs even when `GOOGLE_GRANTS_ENFORCE` is off, so a refused file does not open every alias. `GOOGLE_GRANT_CODE` is ignored on hosted. Authorization-code exchange uses the same live-grant and `notBefore` checks as refresh, on the code JWT's `iat`, before it mints access and refresh tokens.

| Recipe name (example) | Typical accounts |
|----------------------|------------------|
| Personal Brain Grant 3 | all aliases (personal, stromback, opcenter, …) |
| StrombackBrain2 | `stromback` only |

`GOOGLE_PROFILE` (read-only / safe-writes / full-writes) is **write-control**, not brain isolation — do not confuse the two. v6 `safe-writes` also refuses privileged org/Vault/script writes and `*_watch` push registrations (`MIGRATION-v6.md`).

## Transport

By default `dist/index.js` speaks **stdio** (`MCP_TRANSPORT=stdio`). It can also serve bakissation's Streamable HTTP (`src/http-transport.ts`) when `MCP_TRANSPORT` is `http` or `both`.

The house Cloud Run image does **not** use that path. `Dockerfile` runs `docker/entrypoint.sh` → `dist/http.js` (`src/http.ts`: Grok OAuth, JWT `gname`, per-request `buildGoogleMcpServer`). Bakissation's distroless `MCP_TRANSPORT=http` Dockerfile was not taken.

| Variable | Default | Notes |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio`, `http`, or `both` — applies to `dist/index.js`, not house `dist/http.js` |
| `MCP_HTTP_HOST` | `127.0.0.1` | bind address for the upstream transport (`src/http-transport.ts`) |
| `MCP_HTTP_PORT` | `4243` | bind port for the upstream transport |
| `MCP_PUBLIC_URL` | `http://<host>:<port>` | the canonical public base URL; `${MCP_PUBLIC_URL}/mcp` is the endpoint clients connect to |
| `MCP_OWNER_EMAILS` | *(required for upstream http)* | CSV of Google emails allowed to authenticate; the upstream HTTP transport refuses to start without it |
| `MCP_ALLOWED_ORIGINS` | — | extra Origins to allow beyond `MCP_PUBLIC_URL` and `https://claude.ai` |
| `MCP_CIMD_ALLOWED_ISSUERS` | `claude.ai` | CSV host allowlist for OAuth client-metadata documents. Other clients that pick CIMD are refused with `invalid_client` until their host is listed, e.g. `claude.ai,chatgpt.com` for Codex or ChatGPT |
| `MCP_ACCESS_TTL` | `600` | MCP access-token lifetime (seconds) on the upstream authorization server |
| `MCP_JWT_KEY` | auto | signing key for the upstream transport's own MCP tokens; resolved like `MASTER_KEY` (env > OS keychain > `mcp-jwt.key` file > generated). Regenerating it only signs those clients out. House Grok JWTs use `MCP_JWT_SIGNING_KEY_FILE` / `MCP_JWT_SIGNING_KEY`, not this key |

Over the upstream HTTP transport the server is its own **OAuth 2.1 authorization server**: Claude Code and the claude.ai connector authenticate with zero custom UI. A client that connects to `${MCP_PUBLIC_URL}/mcp` is sent through Google login; only an email in `MCP_OWNER_EMAILS` is admitted (the owner gate), and the server then mints its own audience-bound token for the client — your Google tokens are never handed to the client, and the client's token is never sent to Google. That is a different OAuth surface from house Grok OAuth in `src/oauth.ts`. Behind a Cloudflare named tunnel, keep the bind on loopback and set `MCP_PUBLIC_URL` to the public HTTPS host; add `${MCP_PUBLIC_URL}/callback` as an authorized redirect URI in your Google Cloud console. Register the URL with a local client via `mcp-google-multi write-client-config --url ${MCP_PUBLIC_URL}/mcp`. Full remote-HTTP walkthrough — named tunnel, Docker, and one-click Render/Railway deploys — is in [docs/http-setup.md](./http-setup.md).

### Docker

This fork's `Dockerfile` is the house Cloud Run image (`docker/entrypoint.sh` → `dist/http.js`: Grok OAuth, session grants). It is not bakissation's distroless `MCP_TRANSPORT=http` image. The upstream distroless recipe (loopback bind, config volume, `MCP_OWNER_EMAILS`) lives in [docs/http-setup.md](./http-setup.md); `docker build` in this repository does not produce it.

## Write-control (deny-by-default)

Reads are never gated. **Every create/update/delete is off until you opt in** — pick a profile:

| `GOOGLE_PROFILE` | Allows |
|---|---|
| `read-only` (default) | reads only |
| `safe-writes` | create + update on your own data, plus moving items to or from Trash; curated tools hard-refuse permanent deletes and privileged writes, the escape hatch asks for them instead (below) |
| `full-writes` | everything |

`GOOGLE_READ_ONLY=true` overrides all; an invalid `GOOGLE_PROFILE` falls back to `read-only`. For fine control over **curated tools**: `GOOGLE_WRITE_ALLOW="calendar:*, sheets:update*"` and `GOOGLE_WRITE_DENY="*:delete*"` (deny wins). Each tool matches as `service:cud` and as `service:op` (its name minus the service prefix), so a tool named after its own class shares that class's pattern: `drive:update` matches `drive_update` and every other update-class Drive tool (`drive_move`, `drive_permission_update`, …), including a bare `service:cud` allow (`gmail:create` opens every create-class Gmail tool, a push-channel registration such as `gmail_users_watch` included; name the tool, e.g. `gmail:users_watch`, to grant just that one).

`GOOGLE_WRITE_DENY` (never `GOOGLE_WRITE_ALLOW`, see [Escape hatch](#escape-hatch-writes-ask-for-confirmation)) also reaches `google_api_call` and every generated per-method tool: a deny on a curated tool's name also blocks the raw Discovery method underneath it, resolved under the real tool's name when one exists, the full method-path name (`drive_permissions_create`, `gmail_users_settings_filters_create`), and the legacy last-dot-segment name, so a resource-scoped method can never hide behind a generic `drive_create`/`gmail_create` that a resource-scoped deny pattern cannot match. Denying any one of those names denies the call. A curated tool's own deny reaches every raw Discovery method it calls internally, not just its own primary one: `drive_transfer`'s download+upload fallback also calls `files.create`/`files.copy`/`files.update` and `permissions.create`/`permissions.delete` (see `CURATED_METHOD_TOOLS`), so `GOOGLE_WRITE_DENY="drive:transfer"` also blocks `google_api_call` on those raw methods, not only on `drive_transfer` itself.

### What `safe-writes` refuses beyond deletes (curated tools)

"Not a delete" is a statement about an HTTP verb, not about consequences. On a **curated** tool, `safe-writes` also refuses two classes of write that are shaped like an ordinary create or update:

- **Privileged scope.** The method can be authorized by a scope that acts on the whole organization, on legal holds, on billing, or on deployed code: `admin.directory.*`, `admin.datatransfer`, `cloud-identity*`, `apps.licensing`, `apps.order`, `apps.groups.settings`, `apps.groups.migration`, `ediscovery*` (Vault), `script.projects`, `script.deployments`. This is what stops `admin_users_make_admin` and `admin_two_step_verification_turn_off`, both of which are plain `update`s, when called BY THAT NAME.
- **Push-channel registration.** Any `*_watch` method, plus `workspaceevents` subscription create and reactivate. These register a webhook that delivers your activity to an external URL, so they are exports wearing the shape of a create.

The rule is derived from each method's declared scopes and name, not from a hand-kept list, so it keeps working as the generated surface is regenerated. A method whose scopes are unknown is treated as **not** privileged: absent information is not evidence, and failing the other way would break ordinary writes.

`GOOGLE_WRITE_ALLOW` still wins over this, because naming a tool explicitly is a deliberate opt-in. `GOOGLE_WRITE_DENY` still wins over that.

**Neither protection extends to the escape hatch.** The same underlying method is still reachable through `google_api_call` or its generated twin (`admin_users_update`'s raw method, say, or `gmail_users_watch`), which has no concept of "privileged scope" or "push-channel registration" at all: it follows the plain four-branch model in [Escape hatch](#escape-hatch-writes-ask-for-confirmation), so under `safe-writes` it ASKS a human rather than refusing outright. A privileged or push-registration write is therefore one ask away through the escape hatch even while its named curated tool stays hard-refused; `GOOGLE_WRITE_DENY` is the only way to hard-block it on both paths (see above).

### Trash is the one delete-shaped exception

`gmail_trash` and `drive_trash` (curated) only move an item to Trash, which the Drive and Gmail UIs can still recover from; `safe-writes` allows them outright like any other non-privileged write. Untrashing was already a plain `update` and was never refused. Every other delete, including emptying Trash, a permanent Gmail or Drive delete, and `drive_transfer`'s `move` flag, stays refused under `safe-writes`. Gmail's generated thread-level trash twin (`gmail_users_threads_trash`) is the escape hatch, not a curated tool, so it does not get this outright exception either; it asks for confirmation like any other escape-hatch write under `safe-writes` (below), and runs once confirmed.

Among curated writes, `safe-writes` allows every plain create/update, plus `gmail_trash` and `drive_trash` outright, while still refusing every permanent delete, write with a privileged scope, and push-channel registration (any `*_watch`/`*_subscriptions_create` tool). No other `gmail`, `drive`, `calendar`, `docs`, `sheets`, `tasks` or `contacts` curated write is affected.

## Escape hatch: writes ask for confirmation

The escape hatch is `google_api_call` and every generated per-method tool (anything not in the curated registry above; generated tools are always callable by name, e.g. `gmail_users_threads_delete`, as well as through `google_api_call`'s `methodId`). Reads through it are never gated, same as everywhere else. A write through it follows a different, simpler rule than the curated profile/allow/deny model:

1. **`GOOGLE_READ_ONLY=true`** refuses outright, never asking.
2. **A matching `GOOGLE_WRITE_DENY`** refuses outright, never asking (see above for how a deny reaches the escape hatch).
3. **`GOOGLE_PROFILE=full-writes` with `GOOGLE_OUTBOUND_ALLOWLIST` unset** allows outright, same as a curated tool would.
4. **Everything else** asks the connected human via MCP elicitation, on every call, before running it: the default profile, `safe-writes`, any `GOOGLE_WRITE_ALLOW` (allow lists no longer open the escape hatch at all; only `full-writes` does, and they keep governing curated tools exactly as above), and `full-writes` itself when `GOOGLE_OUTBOUND_ALLOWLIST` **is** active.

The prompt shows the account alias, the method id, the HTTP verb, the path params, and a body summary (long opaque/token-looking values redacted, the whole thing truncated); accepting runs the call as shown, declining or cancelling refuses it with `write_declined`. A client that has not declared elicitation support is refused immediately with `elicitation_unsupported` and a hint naming the two ways forward: set `GOOGLE_PROFILE=full-writes` (with `GOOGLE_OUTBOUND_ALLOWLIST` unset) so escape-hatch writes stop asking, or use a curated tool for the operation instead.

This replaces the escape hatch's own pre-6.0.2 content inspection (the raw outbound-allowlist rules for `chat.spaces.setup`, Drive access proposals and revisions, guardian invitations, `recoveryEmail`, `updateVacation`, `permissions.update`, and the generic `emailAddress`/`email` key walk): a human looking at the real body decides instead, so none of that reasoning exists on this path any more. Curated tools are unaffected either way: they keep their own profile/allow/deny gate and their own outbound checks (`drive_share`, `drive_permission_update`, `drive_access_proposal_resolve`, `gmail_send`/`create_draft`/`send_draft`, calendar attendees, `gmail_set_vacation`, `drive_revision_update`) exactly as described above.

**HTTP (EE) transport note.** Elicitation is a server-initiated request that needs the connected client to send a reply while the original tool call is still pending; this server's HTTP transport dispatches every `/mcp` request statelessly, through a fresh, disposable transport per call (`enableJsonResponse: true`, no session id; see `docs/internals.md`), which cannot deliver that mid-call request at all. Rather than let a declared-capable client hang until elicitInput's own request timeout before failing closed anyway, escape-hatch writes over HTTP skip the attempt entirely and refuse immediately with `elicitation_unsupported`, whatever the client declared: run `GOOGLE_PROFILE=full-writes` (with `GOOGLE_OUTBOUND_ALLOWLIST` unset) to allow them outright over HTTP, or use a curated tool instead. stdio keeps one live connection for the whole call and is unaffected; it still attempts a real elicitation there.

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
