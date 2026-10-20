// Measures the tools/list payload and gates CI on it; growth here is a
// regression since lazy mode's whole promise is a small context footprint.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const BASELINE = path.join(ROOT, 'tests', 'fixtures', 'lazy-bytes-baseline.json');
const GROWTH_BUDGET = 0.10;

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--update') ? 'update' : 'print';

if (!fs.existsSync(ENTRY)) {
  console.error('dist/index.js not found: run `npm run build` first.');
  process.exit(2);
}

const { BUNDLE_CATALOG } = await import(path.join(ROOT, 'dist', 'scope-catalog.js'));
// Every bundle, read from the built scope catalog so new bundles are measured
// automatically, granted through one fixture account's scope profile.
const bundles = Object.keys(BUNDLE_CATALOG).filter((b) => b !== 'admin');

const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-measure-'));
const configDir = path.join(configRoot, 'mcp-google-multi');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({
    version: 1,
    accounts: { example: { email: 'user@example.com', admin: true, scopeProfile: 'all' } },
    scopeProfiles: { all: { bundles } },
    defaultAccount: 'example',
  }),
);

// Worst-case surface on purpose: every bundle enabled, full toolset, lazy mode.
const env = {
  ...process.env,
  GOOGLE_CLIENT_ID: 'measure',
  GOOGLE_CLIENT_SECRET: 'measure',
  MASTER_KEY: 'a'.repeat(64),
  XDG_CONFIG_HOME: configRoot,
  GOOGLE_TOOLSETS: 'all',
  GOOGLE_DISCOVERY: 'lazy',
};
// A per-account scopeProfile needs the config.json path: an ambient
// GOOGLE_ACCOUNTS/GOOGLE_OPTIONAL_SCOPES/GOOGLE_ADMIN_ACCOUNTS/TOKEN_STORE_PATH
// would otherwise override or shadow the fixture above.
delete env.GOOGLE_ACCOUNTS;
delete env.GOOGLE_OPTIONAL_SCOPES;
delete env.GOOGLE_ADMIN_ACCOUNTS;
delete env.TOKEN_STORE_PATH;

const p = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const tools = [];
const pending = new Map();
let nextId = 1;

function send(method, params, cb) {
  const id = cb ? nextId++ : undefined;
  if (cb) pending.set(id, cb);
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }) + '\n');
}

function listPage(cursor) {
  send('tools/list', cursor ? { cursor } : {}, (res) => {
    tools.push(...res.tools);
    if (res.nextCursor) listPage(res.nextCursor);
    else finish();
  });
}

function finish() {
  const rows = tools.map((t) => ({ name: t.name, bytes: Buffer.byteLength(JSON.stringify(t)) }));
  rows.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = rows.reduce((s, r) => s + r.bytes, 0);
  const result = {
    toolCount: rows.length,
    totalBytes,
    estTokens: Math.round(totalBytes / 4),
    top10: rows.slice(0, 10),
  };
  p.kill();

  if (mode === 'update') {
    fs.writeFileSync(BASELINE, JSON.stringify({ toolCount: result.toolCount, totalBytes, estTokens: result.estTokens }, null, 2) + '\n');
    console.log(`baseline updated: ${totalBytes} bytes (${result.estTokens} est tokens, ${result.toolCount} tools)`);
    process.exit(0);
  }
  if (mode === 'check') {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'));
    const limit = Math.round(baseline.totalBytes * (1 + GROWTH_BUDGET));
    const verdict = totalBytes <= limit ? 'OK' : 'FAIL';
    console.log(`lazy tools/list: ${totalBytes} bytes (${result.estTokens} est tokens, ${result.toolCount} tools); baseline ${baseline.totalBytes}, budget ${limit}: ${verdict}`);
    if (verdict === 'FAIL') {
      console.error(`lazy tools/list grew past the ${GROWTH_BUDGET * 100} percent budget. Shrink the surface, or update the baseline IN THIS PR with \`node scripts/measure-tools.mjs --update\` and justify it.`);
      process.exit(1);
    }
    process.exit(0);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

p.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        console.error('RPC error:', JSON.stringify(msg.error));
        p.kill();
        process.exit(1);
      }
      cb(msg.result);
    }
  }
});
p.stderr.on('data', () => {});
p.on('exit', (code) => {
  if (pending.size > 0) {
    console.error(`server exited (code ${code}) before answering`);
    process.exit(1);
  }
});

send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'measure', version: '0.0.0' } }, () => {
  send('notifications/initialized', {});
  listPage();
});
setTimeout(() => {
  console.error('timeout waiting for tools/list');
  p.kill();
  process.exit(1);
}, 30_000).unref?.();
