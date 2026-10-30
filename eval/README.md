# Eval harness

Three checks guard the tool surface:

1. **Lazy byte budget** (`npm run measure:lazy`, CI: `scripts/measure-tools.mjs --check`): lazy-mode `tools/list` must stay within 10 percent of `tests/fixtures/lazy-bytes-baseline.json`. Update the baseline deliberately with `--update`, in the PR that justifies the growth.
2. **Contract suite** (`npm run eval:contract`, this directory): deterministic, network-free promptfoo assertions on the tool-surface contract, run in CI on every push/PR. Details below.
3. **Tier-2 agent eval** (`tier2/`): 12 scripted real-account tasks driven through Claude Code headless, scoring first-call and first-service tool selection, first-try success, tool-call counts and token spend; runs per release by the operator, never in CI (it needs a real authenticated instance and spends real tokens).

## Tier-2 agent eval

```bash
# operator machine, `claude` logged in; tasks are read-only and safe under GOOGLE_PROFILE=read-only
cat > /tmp/gmulti-eval-mcp.json << 'EOF'
{"mcpServers":{"gmulti":{"command":"npx","args":["-y","mcp-google-multi@<version under test>"],"env":{"GOOGLE_PROFILE":"read-only"}}}}
EOF
node eval/tier2/run.mjs --mcp-config /tmp/gmulti-eval-mcp.json            # 12 tasks x 3 runs
node eval/tier2/run.mjs --mcp-config ... --only unread-count --runs 1    # smoke
node eval/tier2/run.mjs --mcp-config ... --baseline eval/tier2/out/tier2-<prev>.json
```

Pin the version under test: a bare `mcp-google-multi` resolves npm `latest`, which is not the prerelease line being evaluated. The server must be named `gmulti` (the agent's allow-list is `mcp__gmulti__*`; the runner refuses any other config). It reads the operator's usual accounts, tokens and OAuth client, so export whatever the operator's own install needs before running.

Before any agent run, the runner starts the configured stdio server once and records its `serverInfo` (name, version, protocol) in the summary, so every result names what it measured. A server that cannot start, or a `claude` that cannot run non-interactively, stops the run at once instead of scoring every task as failed.

Isolation: `--strict-mcp-config` (ONLY the eval server loads; without it the operator's personal MCP fleet joins the context and poisons tool selection); `--tools ToolSearch` (no shell, web or file tools; ToolSearch stays because Claude Code defers most MCP tools behind it); `--setting-sources local`, `--disable-slash-commands` and `--no-session-persistence` (the operator's hooks, plugins, skills and settings stay out, and runs leave no sessions behind); and a neutral temp cwd, so no project memory leaks in. The model is pinned via `--model` (default `sonnet`); keep it, and `--max-turns` (default 12), fixed across releases for comparable numbers. `--timeout-sec` (default 300) bounds each run; `--out` overrides the summary directory.

Metrics, per task and overall:

- **first-call**: the first call to the server's tools is one of the task's `expectFirst`. Client-side calls (ToolSearch loading a deferred tool) are not counted.
- **first-service**: first-call, or the first call is the `<service>_discover` of an expected tool. Claude Code loads the `*_discover` tools (`anthropic/alwaysLoad`) up front and defers the rest, so opening with the right service's catalog is a correct entry, one round trip longer.
- **success**: a non-error result from `successTools` and a final answer within `--max-turns`.
- **endings** (each run's result subtype, e.g. `error_max_turns`) and **errors** (`tool:slug` for each failed call; slugs only, never result text). `not_loaded` is Claude Code refusing a deferred tool the agent called before ToolSearch loaded it: that call never reached the server.
- **tokens**: everything a run reads and writes (uncached input, cache creation, cache reads, output), plus Claude Code's own `costUsd`. Nearly all input is cached after the first turn, so the uncached input alone (all v1 summaries counted) understates a run by orders of magnitude; the tool surface's weight shows up in the cache fields.

`--baseline` prints deltas and exits non-zero when any rate drops more than 10 points; a v1 summary, which counted ToolSearch as the first call, is compared on success only. Summaries land in `eval/tier2/out/tier2-<timestamp>.json` (gitignored); compare release over release. `--keep-streams` also writes each run's raw stream to `out/streams/`. Those hold real account data (subjects, file names), so they are off by default.

## Contract suite

`contract/promptfooconfig.yaml` boots the built server (`npm run build` first) with a fixture registry: one account, fake OAuth client credentials, an empty token store, every optional bundle, curated discovery mode, read-only write profile. No Google request ever succeeds, which is the point: every Google-bound call exercises exactly the failure contract a real user hits, and everything else (discovery, validation, coercion, write-control, the escape hatch's pre-network paths) is fully deterministic.

What it pins:

- **The error-envelope contract**: every tool failure parses as `{error, message, retriable, account}` and carries a `hint` (the hint floor). Free-text errors are a contract break.
- **Validation**: missing required arguments and unknown account aliases fail visibly with the same envelope.
- **Coercion**: string-encoded numbers/booleans from clients must coerce, never fail validation.
- **Graceful dispatch**: curated tools resolve in curated mode; hidden tools stay callable.
- **Discovery behavior**: catalog shape, query filtering, the no-match hint, expand/collapse.
- **Escape hatch**: unknown-api and ambiguous-alias responses (network-free paths only; Discovery-doc fetches stay out of CI).
- **Write-control**: a write under `read-only` returns `write_disabled` with the enable hint.
- **Account management**: `account_add` refuses in env-registry mode and names the migration path; `account_reauth` with an unknown alias lists the known ones.

Constraints (measured, not guessed): promptfoo only calls tools present in `tools/list`, so the suite MUST run `GOOGLE_DISCOVERY=curated`; promptfoo requires Node >= 22.22; `PROMPTFOO_DISABLE_UPDATE=1` avoids a version check that can hang for minutes. The pinned promptfoo version lives in the `eval:contract` npm script.

Cases that need a real authenticated account (live Google error shapes such as the invalid Drive query hint) intentionally stay OUT of this suite; they belong to the tier-2 per-release eval.
