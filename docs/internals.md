# Implementation notes

Contributor-facing rationale for non-obvious implementation choices — why the code is the way it is, not how to use it. Back to the [README](../README.md).

## Token store

### Windows rename retry (`renameWithRetry`, `src/token-store.ts`)

`renameWithRetry` exists because Windows uses classic rename semantics (`MoveFileExW` without POSIX semantics): replacing a token file that another process momentarily holds open — a concurrent `readToken`, an antivirus scanner, or a search indexer — fails with a transient `EPERM`, `EACCES`, or `EBUSY`. Reads deliberately take no lock, so the token write lock cannot prevent this collision; a short bounded retry (`RENAME_ATTEMPTS` with linear backoff) absorbs it instead. POSIX rename never fails this way, so the retry loop is effectively inert on Linux and macOS.

### Desk remint → Secret Manager (`src/token-secret.ts`)

Hosted Cloud Run mounts per-alias secrets named `google-mcp-token-<alias>` (e.g. `google-mcp-token-stromback`) and copies `*.enc` from `/mnt/tok-*` at boot (`docker/entrypoint.sh`). A desk remint that only writes the local `*.enc` leaves Cloud Run on the previous refresh; Google then revokes that refresh (`invalid_grant`) while Olga/other aliases stay green.

When `--upload-sm` / `GOOGLE_UPLOAD_SM` is on, `writeTokenAndUploadSm` snapshots prior desk bytes, writes the new envelope, then `addSecretVersion`. SM failure reverts the desk file to those prior bytes when a prior file existed — remint must not count as done if Secret Manager did not bump. Project is explicit (`--project` / `GOOGLE_CLOUD_PROJECT` / `GCP_PROJECT`); never `gcloud config get-value project`. The writer uploads encrypted `*.enc` bytes only (never decrypts, never logs payload / MASTER_KEY). Adding a secret version does not remount Cloud Run — Bulkhead remount is a separate operator step.

Interim operator pin if a comment must name a project: `myflow-260730`.

## Admin SDK

### Why admin tools are per-account opt-in (`ADMIN_SCOPES`, `src/auth.ts`)

The Admin SDK requires a Workspace account with admin privileges; consumer @gmail.com accounts always get a 403. Strictly speaking, the only person with admin rights over a @gmail.com account is a Corporate Operations Engineer on Google's internal Techstop helpdesk — and if that's you, an MCP server is really not how you should be doing this. Requesting admin scopes on an account that cannot use them would only add consent-screen noise, so `GOOGLE_ADMIN_ACCOUNTS` grants them per-account instead of globally.

## Executor

### Request bodies on GET/HEAD (`resolveRequestBody`, `src/executor.ts`)

`executeApiMethod` strips request bodies from GET/HEAD requests before dispatch:

- gaxios stringifies any object passed as `data` without checking the HTTP verb, and undici (Node's `fetch`) rejects GET/HEAD requests that carry a body (`Request with GET/HEAD method cannot have body`). A caller-supplied `{}` body on a read tool would therefore crash the request.
- Stripping is lossless: no Google Discovery GET/HEAD method declares a request schema, so there is never a legitimate GET/HEAD body to preserve.
- Write verbs keep the usual semantics: `null`/`undefined` means no body is sent.
