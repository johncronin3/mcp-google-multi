# Hosted MCP pattern (copy this)

Streamable HTTP so **Grok Bot Custom connectors** can call this server on Cloud Run.
This is the same pattern as billing-mcp (`billing-integ/mcp-server/oauth.py`).

These MCPs started as a **singular** provider login (one Google account / one QBO company).
**Multi** means a registry of those still-singular rows, plus a grant allowlist — not a
mega-OAuth that logs into every account at once. Hosted mode **never remints** provider tokens.

## Three layers (keep the names)

| Layer | What it is | Where it lives | Grok authorize page? |
| --- | --- | --- | --- |
| **1. Provider credentials** | Per-alias Google OAuth (desk `auth --account`), encrypted `*.enc` | Token store / Secret Manager | **No.** Never. |
| **2. MCP HTTP token** | Gate for `POST /mcp` | `MCP_HTTP_TOKEN` | **Yes.** Billing-style wrapper around this token only. |
| **3. Session grant** | Slice of layer-1 aliases this brain may use (`Personal Brain Grant 3`, `StrombackBrain2`) | Host-local `grants.json`; bound into layer-2 access JWT as grant **name** | Grant *code* field only — not Google login. |

Do not mix layer 1 into Grok connector OAuth. Do not replace per-account desk mint with a mega-OAuth.

## Why billing connects and a Bearer-only `/mcp` does not

Grok.com Custom connectors **always** ask for OAuth client/endpoints. They do not paste a static
Bearer. Without `/.well-known/oauth-authorization-server`, DCR `/oauth/register`, `/oauth/authorize`,
and `/oauth/token`, Grok storms `POST /mcp` → Cloud Run **429 no available instance**.

CLI / Hermes still send `Authorization: Bearer <MCP_HTTP_TOKEN>` (layer 2, no OAuth).

## Endpoints to implement

Public origin = `https://$MCP_PUBLIC_HOST` (never `localhost:8787` in hosted mode).

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/health` | none |
| GET | `/.well-known/oauth-authorization-server` | none |
| GET | `/.well-known/oauth-protected-resource` | none |
| POST | `/oauth/register` | none (DCR; return `client_id: grok`) |
| GET/POST | `/oauth/authorize` | HTML form: MCP token + optional session grant code |
| POST | `/oauth/token` | authorization_code + PKCE S256, or refresh_token |
| POST | `/mcp` | Bearer: static MCP token **or** HMAC access JWT |

Access tokens are HMAC-SHA256 JWTs signed with `MCP_HTTP_TOKEN` so replicas share no store.
Claim `gname` is the session grant **name** (layer 3). Never put grant codes or Google tokens in the JWT.

On each `/mcp` request, if the Bearer is a JWT, restore the grant with `resolveGrantByName(gname)`
into `AsyncLocalStorage`. Fail closed if grants are enforced and `gname` is missing/unknown.
In-process `set_grant` is for stdio/CLI; it does **not** survive another Cloud Run instance.

## Hosted must not

- Bind **8000 / 8787 / 4242** or open a browser (`K_SERVICE` / `MCP_HOSTED=1`).
- Run provider OAuth (`auth --account`) on Cloud Run.
- Steal a loopback `redirect_uri` with HTML-200 + meta-refresh to grok.com. Grok Bot
  Plugins **Reopen** uses `http://localhost:8787/callback` and the desk process holds
  the PKCE verifier — **302 to that URI**. grok.com Custom still 302s to
  `https://grok.com/connectors-oauth-exchange-code/` because that is what it requested.
- List hundreds of tools at boot (`GOOGLE_REVEAL_AT_BOOT=all`) unless the client requires it;
  a huge `tools/list` plus Grok retries contributes to 429s. Prefer deferred discover.

Missing layer-1 tokens: **desk-mint error** (mint on a desk, mount `*.enc`).

## Grok Custom connector fields

House operator runbook (catalog vs Custom, `localhost:8787` Retry → `connectors-oauth-error`, what to paste): AIC `docs/grok-custom-connector-oauth.md`.

On grok.com this MCP is **not** a catalog tile. **New Connector** → **Custom** → Name + Server URL only (finish URL grok.com). Grok Bot Plugins **Reopen** uses `localhost:8787` on purpose — the desktop app is listening; 302 there.

| Field | Value |
| --- | --- |
| Server URL | `https://$MCP_PUBLIC_HOST/mcp` |
| Client ID | `grok` |
| Client Secret | (blank) |
| Authorization Endpoint | `https://$MCP_PUBLIC_HOST/oauth/authorize` |
| Token Endpoint | `https://$MCP_PUBLIC_HOST/oauth/token` |
| Scopes | `mcp:tools` |
| Token Auth Method | `none (PKCE only)` |

## Env (hosted)

```
PORT=8080
MCP_HTTP_TOKEN=  # layer 2 — Secret Manager, never commit
MCP_PUBLIC_HOST=google-multi-mcp-tdhsljvruq-uc.a.run.app
GOOGLE_ACCOUNTS=alias:email,...
MASTER_KEY=
TOKEN_STORE_PATH=/tmp/google-tokens
GOOGLE_GRANTS_PATH=/mnt/grants/grants.json
GOOGLE_GRANTS_ENFORCE=true
# GOOGLE_REVEAL_AT_BOOT=  # keep small on Grok
```

Grant **codes** stay in host-local `grants.json`. Names `Personal Brain Grant 3` and
`StrombackBrain2` are public; codes are not.

## Copy to the next server

1. Keep singular provider OAuth as a desk CLI (`auth --account` / QBO company mint).
2. Add Streamable HTTP `/mcp` gated by `MCP_HTTP_TOKEN`.
3. Copy this OAuth wrapper (`src/oauth.ts` + well-known) around **that token only**.
4. Bind the session grant name into the access JWT; restore with ALS on each request.
5. Fail closed: no grant → no accounts; no provider token → desk-mint error.

Reference implementation (working Grok OAuth): `billing-integ/mcp-server/oauth.py`.
This repo: `src/oauth.ts`, `src/hosted.ts`, `src/session-grant.ts`, `src/http.ts`.

## Hosted downloads (return-bytes)

On Cloud Run (`MCP_HOSTED` / `K_SERVICE`), these tools return file bytes in the MCP result instead of writing `savePath` on the container:

- `gmail_download_attachment`
- `drive_download`
- `drive_export`

Shape: `{ filename, mimeType, size, encoding: "base64", data }`. Desk/stdio still requires `savePath` and writes locally. If a caller passes `savePath` while hosted, it is ignored (optional `note` in the payload).

