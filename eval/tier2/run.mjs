// Tier-2 agent eval (eval harness check 3 of 3): scripted real-account tasks
// driven through Claude Code headless, scoring FIRST-CALL tool selection,
// first-try success, turns and token spend. Runs PER RELEASE by the operator
// (never CI: it needs a real authenticated instance and spends real tokens).
//
//   node eval/tier2/run.mjs --mcp-config <file> [--runs 3] [--only id,id]
//                           [--model sonnet] [--max-turns 12] [--timeout-sec 300]
//                           [--out eval/tier2/out] [--keep-streams]
//                           [--baseline <prior-summary.json>]
//
// The MCP config is the operator's own and must name the server `gmulti`
// (e.g. {"mcpServers":{"gmulti":{"command":"npx","args":["-y",
// "mcp-google-multi@<version under test>"],"env":{"GOOGLE_PROFILE":"read-only"}}}}).
// Tasks are read-only by design and safe under GOOGLE_PROFILE=read-only. The
// eval server's tools and Claude Code's ToolSearch are the only tools the
// agent has, so it cannot answer through anything else.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = 'gmulti';
const PREFIX = `mcp__${SERVER}__`;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const mcpConfig = arg('mcp-config');
if (!mcpConfig) {
  console.error('usage: node eval/tier2/run.mjs --mcp-config <file> [--runs 3] [--only id,...] [--max-turns 12] [--keep-streams] [--baseline <file>]');
  process.exit(2);
}
const runs = Number(arg('runs', '3'));
const model = arg('model', 'sonnet');
const maxTurns = Number(arg('max-turns', '12'));
const timeoutMs = Number(arg('timeout-sec', '300')) * 1000;
const outDir = arg('out', path.join(HERE, 'out'));
const only = arg('only', '')?.split(',').filter(Boolean);
const baselineFile = arg('baseline');
const keepStreams = process.argv.includes('--keep-streams');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const serverConfig = JSON.parse(fs.readFileSync(mcpConfig, 'utf-8')).mcpServers?.[SERVER];
if (!serverConfig) {
  // The allow-list is mcp__gmulti__*: any other name scores every run as a
  // failure without one tool call, which reads as a broken server.
  console.error(`--mcp-config must define mcpServers.${SERVER}`);
  process.exit(2);
}

const { tasks } = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks.json'), 'utf-8'));
const selected = only.length > 0 ? tasks.filter((t) => only.includes(t.id)) : tasks;

const tail = (s) => String(s ?? '').trim().split('\n').slice(-3).join(' | ');

// What is under test goes into the summary, and a server that cannot start
// fails here, before any agent run spends tokens. An HTTP entry is recorded
// by URL only.
function probeServer(s) {
  if (!s.command) return Promise.resolve({ transport: s.type ?? 'http', url: s.url ?? null });
  return new Promise((resolve, reject) => {
    const child = spawn(s.command, s.args ?? [], { env: { ...process.env, ...(s.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const settle = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn(v);
    };
    const timer = setTimeout(() => settle(reject, new Error(`no initialize answer in 120 s: ${tail(err)}`)), 120_000);
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== 1) continue;
        if (m.result) settle(resolve, { transport: 'stdio', ...m.result.serverInfo, protocolVersion: m.result.protocolVersion });
        else settle(reject, new Error(`initialize failed: ${JSON.stringify(m.error)}`));
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    // A server that dies at once closes stdin under the initialize write;
    // its exit, with the stderr tail, is the error worth reporting.
    child.stdin.on('error', () => {});
    child.on('error', (e) => settle(reject, e));
    child.on('exit', (code) => settle(reject, new Error(`server exited (${code}) before answering initialize: ${tail(err)}`)));
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tier2-probe', version: '1' } },
    }) + '\n');
  });
}

let server;
try {
  server = await probeServer(serverConfig);
} catch (e) {
  console.error(`the ${SERVER} server did not start: ${e.message}`);
  process.exit(2);
}
console.log(`server under test: ${server.name ?? server.url ?? '?'} ${server.version ?? ''}`.trim());

// Neutral cwd so no project CLAUDE.md or settings leak into the eval context;
// --strict-mcp-config so ONLY the eval server loads (without it the user's
// whole personal MCP fleet joins and poisons tool selection).
const evalCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-tier2-cwd-'));

// A failed tool result's envelope slug (`{"error":"no_default_account",...}`),
// never its text: summaries stay free of account data. Claude Code answers
// some calls itself without reaching the server (`<tool_use_error>`): a
// deferred tool called before ToolSearch loaded it is `not_loaded`.
function errorSlug(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : '';
  if (text.startsWith('<tool_use_error>')) return /No such tool available/.test(text) ? 'not_loaded' : 'client_error';
  try {
    const slug = JSON.parse(text)?.error;
    if (typeof slug === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(slug)) return slug;
  } catch {
    // not an envelope
  }
  return 'unparsed';
}

const serviceOf = (tool) => tool.split('_')[0];

function runOnce(task, run) {
  const started = Date.now();
  const r = spawnSync('claude', [
    '-p', task.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    // ToolSearch is the only built-in left on: Claude Code defers most MCP
    // tools behind it, and without it the agent could reach nothing but the
    // up-front set. Shell, web and file tools are off, not merely unapproved.
    '--tools', 'ToolSearch',
    '--allowedTools', `${PREFIX}*`,
    // The operator's own hooks, plugins, skills and settings stay out.
    '--setting-sources', 'local',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--model', model,
    '--max-turns', String(maxTurns),
  ], { encoding: 'utf8', timeout: timeoutMs, input: '', cwd: evalCwd });
  if (keepStreams) {
    // Raw streams hold real account data (subjects, file names): out/ is
    // gitignored, and they are written only when asked for.
    fs.mkdirSync(path.join(outDir, 'streams'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'streams', `${stamp}-${task.id}-${run}.jsonl`), String(r.stdout ?? ''));
  }
  const events = String(r.stdout ?? '').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const calls = [];
  const toolResults = new Map();
  let tokens = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
  let costUsd = null;
  let finalText = '';
  let ending = r.error?.code === 'ETIMEDOUT' ? 'timeout' : 'no_result';
  let turns = null;
  let claudeVersion = null;
  let runErrored = r.status !== 0;
  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'init') claudeVersion = e.claude_code_version ?? null;
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'tool_use') calls.push({ id: c.id, name: String(c.name) });
      }
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'tool_result') toolResults.set(c.tool_use_id, c.is_error === true ? { ok: false, error: errorSlug(c.content) } : { ok: true });
      }
    }
    if (e.type === 'result') {
      // The result event carries the authoritative aggregate usage. Nearly
      // all input is cached after the first turn, so input_tokens alone
      // (the uncached remainder) understates what a run reads by orders of
      // magnitude: the cache fields are the tool surface's real weight.
      finalText = e.result ?? '';
      ending = e.subtype ?? 'result';
      turns = e.num_turns ?? null;
      runErrored = runErrored || e.is_error === true;
      tokens = {
        input: e.usage?.input_tokens ?? 0,
        cacheCreation: e.usage?.cache_creation_input_tokens ?? 0,
        cacheRead: e.usage?.cache_read_input_tokens ?? 0,
        output: e.usage?.output_tokens ?? 0,
      };
      costUsd = typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null;
    }
  }

  // Selection is scored on the SERVER's tools only. Client-side calls
  // (ToolSearch loading a deferred tool) are the client's mechanics, not a
  // choice between this server's tools.
  const serverCalls = calls
    .filter((c) => c.name.startsWith(PREFIX))
    .map((c) => ({ name: c.name.slice(PREFIX.length), ...(toolResults.get(c.id) ?? { ok: false, error: 'no_result' }) }));
  const firstTool = serverCalls[0]?.name;
  const firstCallOk = task.expectFirst.includes(firstTool);
  // A `<service>_discover` tool is loaded up front while the service's own
  // tools are deferred, so opening with the right service's discover is a
  // correct entry, one round trip longer than the exact tool.
  const firstServiceOk = firstCallOk || (firstTool !== undefined && task.expectFirst.some((t) => firstTool === `${serviceOf(t)}_discover`));
  const success = !runErrored
    && serverCalls.some((c) => task.successTools.includes(c.name) && c.ok)
    && finalText.length > 0;
  return {
    result: {
      firstTool: firstTool ?? null,
      firstCallOk,
      firstServiceOk,
      success,
      ending,
      toolCalls: serverCalls,
      clientCalls: calls.filter((c) => !c.name.startsWith(PREFIX)).map((c) => c.name),
      turns,
      tokens,
      costUsd,
      ms: Date.now() - started,
      exit: r.status,
    },
    claudeVersion,
    started: events.some((e) => e.type === 'assistant'),
    stderr: r.stderr,
  };
}

const results = [];
let claudeVersion = null;
for (const task of selected) {
  for (let i = 0; i < runs; i++) {
    process.stderr.write(`${task.id} run ${i + 1}/${runs}...\n`);
    const r = runOnce(task, i + 1);
    if (results.length === 0 && !r.started) {
      // claude itself never answered (not logged in for non-interactive use,
      // a bad flag, a missing binary): every further run would fail the same
      // way and read as a server regression.
      console.error(`claude did not run (exit ${r.result.exit}, ending ${r.result.ending}): ${tail(r.stderr)}`);
      console.error('check that `claude -p hi` works non-interactively on this machine.');
      process.exit(2);
    }
    claudeVersion = claudeVersion ?? r.claudeVersion;
    results.push({ task: task.id, run: i + 1, ...r.result });
  }
}

const rate = (rs, key) => rs.filter((r) => r[key]).length / rs.length;
const tokensOf = (r) => r.tokens.input + r.tokens.cacheCreation + r.tokens.cacheRead + r.tokens.output;
const costOf = (rs) => Math.round(rs.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 10000) / 10000;
const counts = (items) => items.reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});

const byTask = {};
for (const t of selected) {
  const rs = results.filter((r) => r.task === t.id);
  byTask[t.id] = {
    firstCallRate: rate(rs, 'firstCallOk'),
    firstServiceRate: rate(rs, 'firstServiceOk'),
    successRate: rate(rs, 'success'),
    avgTokens: Math.round(rs.reduce((s, r) => s + tokensOf(r), 0) / rs.length),
    avgOutputTokens: Math.round(rs.reduce((s, r) => s + r.tokens.output, 0) / rs.length),
    costUsd: costOf(rs),
    avgToolCalls: Math.round((rs.reduce((s, r) => s + r.toolCalls.length, 0) / rs.length) * 10) / 10,
    firstTools: [...new Set(rs.map((r) => r.firstTool))],
    endings: counts(rs.map((r) => r.ending)),
    errors: counts(rs.flatMap((r) => r.toolCalls.filter((c) => !c.ok).map((c) => `${c.name}:${c.error}`))),
  };
}
const overall = {
  firstCallRate: rate(results, 'firstCallOk'),
  firstServiceRate: rate(results, 'firstServiceOk'),
  successRate: rate(results, 'success'),
  totalTokens: results.reduce((s, r) => s + tokensOf(r), 0),
  costUsd: costOf(results),
};
const summary = { v: 2, when: new Date().toISOString(), server, claudeVersion, model, maxTurns, runs, overall, byTask, results };

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `tier2-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));

const pct = (x) => `${(x * 100).toFixed(0).padStart(3)}%`;
console.log(`tier-2: first-call ${pct(overall.firstCallRate)}  first-service ${pct(overall.firstServiceRate)}  success ${pct(overall.successRate)}  tokens ${overall.totalTokens}  cost $${overall.costUsd}  -> ${outFile}`);
for (const [id, s] of Object.entries(byTask)) {
  const errs = Object.entries(s.errors).map(([k, n]) => `${k}x${n}`).join(',');
  console.log(`  ${id.padEnd(20)} first ${pct(s.firstCallRate)}  service ${pct(s.firstServiceRate)}  ok ${pct(s.successRate)}  ~${s.avgTokens} tok (${s.avgOutputTokens} out)  first=[${s.firstTools.join(',')}]${errs ? `  errors=[${errs}]` : ''}`);
}

if (baselineFile) {
  const base = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
  const dSuccess = overall.successRate - base.overall.successRate;
  const drops = [['success', dSuccess]];
  if ((base.v ?? 1) >= 2) {
    drops.push(['first-call', overall.firstCallRate - base.overall.firstCallRate]);
    drops.push(['first-service', overall.firstServiceRate - base.overall.firstServiceRate]);
  } else {
    // v1 counted client calls (ToolSearch) as the first call, so its
    // selection rates do not compare with these.
    console.log('baseline is v1: comparing success only');
  }
  console.log(`vs baseline: ${drops.map(([k, d]) => `${k} ${(d * 100).toFixed(0)}pt`).join('  ')}`);
  if (drops.some(([, d]) => d < -0.1)) {
    console.error('REGRESSION: a rate dropped more than 10 points vs the baseline.');
    process.exit(1);
  }
}
