# Contributing to mcp-google-multi

Thanks for your interest! This is an MCP server exposing Google Workspace tools (Gmail, Drive, Calendar, Sheets, Docs and more; see [COVERAGE.md](./COVERAGE.md)) with multi-account OAuth.

> **This project is maintainer-led.** The roadmap is published as **[GitHub Milestones](https://github.com/bakissation/mcp-google-multi/milestones)** — there is no code-ready issue backlog, and **unsolicited feature PRs aren't being accepted** right now. **Bug reports and security reports are very welcome** (open an issue for bugs; see [SECURITY.md](./SECURITY.md) for vulnerabilities). If you'd like to contribute a fix, please **open an issue first** so we can confirm it fits the roadmap. Issues describing pain points and missing capabilities directly shape the roadmap. The branching/PR mechanics below apply to changes that have been agreed.

## Branching model

This repo uses a three-tier promotion flow:

```
your fork ──PR──▶ dev ──▶ staging ──▶ main (releases tagged here)
                  ▲         (maintainer-promoted)
            contributors
            target dev
```

- **Open all PRs against `dev`.** PRs to `staging` or `main` from contributors will be redirected.
- The maintainer promotes `dev → staging → main` and cuts releases from `main`.
- `dev`, `staging`, and `main` are all protected: CI must pass and changes land via pull request.
- **Merges use merge commits** (squash & rebase are disabled), so keep each branch's commits clean Conventional Commits — they land individually and drive the release version.

## Dev setup

Requires Node.js 22 or newer (`engines` in `package.json`).

```bash
git clone https://github.com/bakissation/mcp-google-multi.git
cd mcp-google-multi
npm install
cp .env.example .env          # add GOOGLE_CLIENT_ID/SECRET and GOOGLE_ACCOUNTS (MASTER_KEY is generated if unset)
npm run build
node dist/index.js auth --account <alias>   # OAuth each account you'll test with
```

You need a Google Cloud project with the relevant APIs enabled and an OAuth 2.0 Desktop client — see [docs/google-cloud-setup.md](./docs/google-cloud-setup.md).

**Never commit `.env` or anything under `tokens/`** (both are gitignored). Don't paste tokens, client secrets, or OAuth codes into issues or PRs.

## Before you open a PR

All of these must pass:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

## Conventions

The full spec lives in [`CLAUDE.md`](./CLAUDE.md). The essentials:

- **One service per file** in `src/tools/<service>.ts`, exporting `register<Service>Tools(server: ToolRegistry, deps: CuratedToolDeps = {})`. `cud` (read/create/update/delete) is inferred from the tool name; CUD tools are auto-gated by write-control.
- **Tool shape:** `server.registerTool(name, { description, inputSchema }, handler)`. `inputSchema` is a flat `zod` object with an optional `account` (`accountEnum`) as the first field. Tool names are `snake_case`, prefixed by service.
- **Errors:** wrap handlers in `try/catch` and delegate to the per-service `handle<Service>Error` shim (which calls `handleGoogleApiError`). Set `isError: true` on error responses.
- **Scopes** are tiered: `BASE_SCOPES` in `src/auth.ts` (always), optional bundles in `BUNDLE_CATALOG` (`src/scope-catalog.ts`, enabled per account through scope profiles), `ADMIN_SCOPES` (per-account opt-in). Any new scope must be documented and noted as requiring re-auth.
- **No `console.log`** in tool handlers — stdio is the MCP channel; use `process.stderr.write` if needed.
- **Generated tools** (`src/tools/generated/`) and `COVERAGE.md` are generated (`npm run gen:tools`, `npm run gen:coverage`); never hand-edit them.
- **Tests:** pure-logic helpers get unit tests (`vitest`). Handlers are verified by manual smoke testing — we do not mock the `@googleapis/*` clients.

## Commits & versioning

Versioning and releases are **fully automated** by [semantic-release](https://semantic-release.gitbook.io/) from your commit messages — **do not bump `package.json` or edit a changelog by hand.** Just write good [Conventional Commits](https://www.conventionalcommits.org/):

- `fix:` → patch, `feat:` → minor, a `BREAKING CHANGE:` footer → major (a bare `feat!:` without the footer is not detected by the release analyzer). `docs:`/`chore:`/`refactor:` don't trigger a release.
- On merge, a release is cut automatically per channel: **`dev` → `x.y.z-alpha.n`**, **`staging` → `x.y.z-beta.n`**, **`main` → `x.y.z`** (stable). Release notes are generated into [GitHub Releases](https://github.com/bakissation/mcp-google-multi/releases).
- Regenerate **[COVERAGE.md](./COVERAGE.md)** with `npm run gen:coverage` when you add/change a tool. (`package.json` `version` is a managed placeholder — the git tag / GitHub Release is the source of truth.)

## PR checklist

- [ ] Targets `dev`
- [ ] `typecheck`, `lint`, `test`, `build` all pass
- [ ] Conventional commit messages
- [ ] COVERAGE.md regenerated if the tool surface changed (no manual version bump / changelog — automated from your commits)
- [ ] No secrets, tokens, or `.env` committed

## Security

Do **not** report vulnerabilities in public issues. See [`SECURITY.md`](./SECURITY.md).
