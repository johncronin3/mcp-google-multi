# TRAIL — Fail-closed desk → Secret Manager writer for google-mcp-token-<alias>

Branch: `cursor/desk-sm-token-writer-a10d` (off live hosted tip `feat/hosted-mcp-grok-oauth` @ `83bbc45`)
Same permanence shape as QBO PR #5 (`persistRotatedTokens` → SM version or revert). Google-multi is per-alias `*.enc`, not a companies registry.

**Not in this change:** merge, Cloud Run deploy, prove `--live`, Google remint, session grants, Dependabot #7, calendar RSVP, drive upload, Partner access.

Partner OFF. Bulkhead labeled remount (secret id + alias) before HAL `gmail_get_profile` after any live ship.

## What changed (Cecil)

Hosted alias `stromback` (`john@stromback.com`) went `invalid_grant` after a Fedora desk remint of `stromback.enc` that revoked the refresh still held in Cloud Run secret `google-mcp-token-stromback`, because SM was never re-uploaded / remount never landed. Olga stayed green. Bleed stop is closed (SM tip bumped, remount proved). This branch makes "remint done" impossible without an SM version bump when SM upload mode is on.

| Piece | Role |
| --- | --- |
| `src/token-secret.ts` | Explicit GCP project + `addSecretVersion` of `google-mcp-token-<alias>` from desk `*.enc` bytes. `writeTokenAndUploadSm` snapshots prior desk bytes, writes, SM; SM failure reverts prior bytes when a prior file existed. Never logs token / enc / MASTER_KEY. |
| `src/token-store.ts` | `snapshotEncFile` / `restoreEncFile` (raw envelope bytes, not re-encrypt) |
| `src/auth.ts` | `--upload-sm` / `GOOGLE_UPLOAD_SM` / `GOOGLE_SM_UPLOAD`: remint incomplete until SM version name returns. Project required before the browser. |
| `src/index.ts` | `upload-sm` CLI (one alias, existing desk file, no OAuth) |
| `src/token-secret-prove.ts` | Dry-run-default prove: `--project` **and** `--alias` required; `--live` byte-copies latest and reads **name / createTime / etag only** |
| `scripts/prove-google-mcp-token-secret.ts` | CLI wrapper. CI must not pass `--live`. |
| `scripts/upload-google-mcp-token-secret.ts` | Same as `mcp-google-multi upload-sm` via tsx |
| Tests | project required, fail-closed SM error + desk revert, success metadata-only, prove dry-run / mocked `--live` |

## Where (call order)

Young Ma operator path:

```bash
mcp-google-multi auth --account <alias> --upload-sm --project myflow-260730
```

1. Resolve `--project` / `GOOGLE_CLOUD_PROJECT` / `GCP_PROJECT` (fail before browser if missing)
2. Google OAuth for **that alias only**
3. Snapshot prior desk `*.enc` bytes
4. `writeToken` (AES-256-GCM envelope)
5. `addSecretVersion` → `projects/$PROJECT/secrets/google-mcp-token-<alias>`
6. Only then print version name (metadata). Remint counts as done.

If step 5 fails: revert step 4 when a prior file existed, exit non-zero, **do not** treat remint as done.

Two-step (desk file already written, no OAuth):

```bash
mcp-google-multi upload-sm --account <alias> --project myflow-260730
```

GCP project: `GOOGLE_CLOUD_PROJECT` (or `GCP_PROJECT` / `--project`). Never a silent gcloud ADC default. Runtime does **not** hardcode a project. If an operator script must name one, interim pin is `myflow-260730` — **do not deploy**.

Default without `--upload-sm` / env gate: desk-only auth (OSS / local). CI stays dry/mocked.

## Secret id naming (honest corner)

In-repo / incident: Secret Manager id is `google-mcp-token-<alias>` (confirmed for `stromback` → `google-mcp-token-stromback`). `docker/entrypoint.sh` copies `*.enc` from `/mnt/tok-*` into `TOKEN_STORE_PATH=/tmp/google-tokens`. This PR did **not** inspect live Cloud Run mount maps per alias; if an alias was mounted under a different secret id, `--secret-id` overrides. A version bump is **not** a remount — existing Cloud Run instances keep the old volume until Bulkhead remounts / new revision.

`--live` prove byte-copies the current SM payload (does not read desk `*.enc`, does not remint Google).

## Secret Manager prove path (not executed live on this PR)

Still **mocked in CI**. `--live` was not run.

```bash
# Dry-run (no network). --project and --alias are required. Does not call gcloud.
npm run prove:google-mcp-token-secret -- --project test-proj --alias stromback
```

`--live` would: access latest payload (held in memory, never printed) → `addSecretVersion` (byte-copy of latest, no Google remint) → `getSecretVersion` metadata (name / createTime / etag only).

**Do not pass `--live` until John says so.** Not for this pull request. No Cloud Run deploy. No Google remint. Partner stays off.

Interim pin if a comment must name a project: `myflow-260730`.

### Still mocked (this PR)

- Google OAuth / `auth --account` (no remint)
- Secret Manager `addSecretVersion` on the writer path (test seam)
- Prove `--live` (injected fake client + mocked SM SDK; no GCP call)

### Corner

`--live` proves SM **write + metadata read-back**, not a full Google remint. It byte-copies the current secret so it does not clobber tokens. It does **not** call Google, does **not** remint, and does **not** run `writeTokenAndUploadSm` against production.

## How to test without a live remint

No Google OAuth, no Secret Manager network, no Cloud Run.

```bash
npx vitest run tests/token-secret.test.ts tests/token-secret-prove.test.ts tests/token-store.test.ts
```

Full suite:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Dry-run prove (required `--project` + `--alias`; no network):

```bash
npm run prove:google-mcp-token-secret -- --project test-proj --alias stromback
```

Missing `--project` exits 1 even if `GOOGLE_CLOUD_PROJECT` is set. **`--live` was not run.**

Last run on this branch: focused writer **45 passed** (2 files) plus token-store **19 passed**; full **450 passed** (29 files); prove dry-run `--project test-proj --alias stromback` exit 0, no network; missing `--project` exit 1. Typecheck passed. Lint is clean on the writer files. Hosted tip already has 3 unrelated eslint errors (`src/http.ts`, `src/oauth.ts`, `tests/oauth-as.test.ts`) — not touched.

What the mocks cover:

- Missing `GOOGLE_CLOUD_PROJECT` throws (no silent default)
- Missing prove `--project` exits non-zero even if `GOOGLE_CLOUD_PROJECT` is set
- Mock `addSecretVersion` success vs `PERMISSION_DENIED` + desk revert
- Prove dry-run never touches the SM client
- Mocked prove `--live` reports name/createTime/etag and never the payload
- Success reports version name only (never asserts secret payload in logs)

## Later prove owner (after John says)

HAL: `gmail_get_profile` on `stromback` **after** Bulkhead labeled remount of `google-mcp-token-stromback`. Partner stays off. Olga must stay green (this writer never touches other aliases).

## Operator steps NOT done (need John's yes)

1. Merge (do **not** merge this PR in this pass)
2. Deploy this branch to Cloud Run (do **not**)
3. Run prove `--live` (this PR did not)
4. Remint any live Google account (this PR did not)
5. Partner access
6. Change session grants
7. Merge Dependabot #7
8. Bulkhead remount (secret id + alias) — required after a live SM version bump, before HAL prove

## Constraints honored

- No merge, no Cloud Run deploy, no `--live`, no remint
- No session grant changes
- No Dependabot #7
- No `gcloud config get-value project`
- Credentials never logged or printed
- `--live` not run
- Partner OFF

# Hosted return-bytes for downloads (fix/hosted-return-bytes)

- **Hosted Cloud Run** (`isHostedHttp`: `MCP_HOSTED=1` / `K_SERVICE`): `gmail_download_attachment`, `drive_download`, `drive_export` return `{ filename, mimeType, size, encoding: "base64", data }` in the MCP tool result. Writing `savePath` on the container is useless to Grok Bot agents.
- **Desk/stdio**: unchanged — require `savePath`, write file, return path (gmail text / drive JSON).
- **Hosted + savePath**: still return bytes; optional `note` that savePath is not applicable. Do not fail.
- Shared helpers: `hostedBytesPayload`, `mcpJsonResult`, `deskSavePathRequiredMessage` in `src/hosted.ts`.
- No Cloud Run deploy in this take. HAL rebuilds after merge.

# Gmail attachments (feat/gmail-attachments)

- **Drive `driveFileId` is the hosted path.** Cloud Run fetches bytes with Drive `files.get alt=media` on the same Google account. Upload on the desk (`drive_upload`), then pass the file id to `gmail_send` / `gmail_create_draft`.
- **Local `path` is desktop-only.** Hosted Cloud Run cannot see laptop filesystems. A missing path returns a clear error that hosted Cloud Run cannot see laptop paths. Use `driveFileId` or `messageId`+`attachmentId` instead of `/home/...` on the hosted server.
- **Downloads on hosted now return base64** (see above). Desk `savePath` unchanged.
- **Do not send the Taddeo rental PDF.**
