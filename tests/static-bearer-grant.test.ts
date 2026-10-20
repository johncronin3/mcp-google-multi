/**
 * Static MCP bearer does not inherit in-process set_grant or GOOGLE_GRANT_CODE.
 * MCP_HTTP_TOKEN_GRANT (grant name) is the only binding, and it is off by default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TOKEN = 'mcp-test-token-not-secret';
const PUBLIC_HOST = 'google-multi-mcp-test.a.run.app';
const PBG3_CODE = 'test-code-pbg3-not-prod';
const OUTSIDERS = ['personal', 'opcenter', 'buildcoin', 'usa-house', 'olga'];
const ALL = ['personal', 'stromback', 'opcenter', 'buildcoin', 'usa-house', 'olga'];

const dir = mkdtempSync(path.join(tmpdir(), 'gmulti-static-grant-'));
const grantsPath = path.join(dir, 'grants.json');
writeFileSync(
  grantsPath,
  JSON.stringify({
    version: 1,
    grants: [
      { name: 'Personal Brain Grant 3', code: PBG3_CODE, accounts: ALL },
      { name: 'stromback-test', code: 'test-code-stromback-test-not-prod', accounts: ['stromback'] },
    ],
  }),
  'utf8',
);

process.env.GOOGLE_ACCOUNTS = ALL.map((alias) => `${alias}:${alias}@example.com`).join(',');
process.env.MCP_HTTP_TOKEN = TOKEN;
process.env.MCP_PUBLIC_HOST = PUBLIC_HOST;
process.env.GOOGLE_GRANTS_PATH = grantsPath;
process.env.GOOGLE_GRANTS_ENFORCE = 'true';
process.env.GOOGLE_GRANT_CODE = PBG3_CODE;
delete process.env.MCP_HTTP_TOKEN_GRANT;
delete process.env.MCP_HOSTED;
delete process.env.K_SERVICE;

const { createHttpRequestListener, publicMcpHost } = await import('../src/http.js');
const { clearSessionGrant, getSessionGrant, resetGrantsFileCache, setSessionGrant } = await import(
  '../src/session-grant.js'
);
const { invalidateAccountSet } = await import('../src/accounts.js');
const { signJwt } = await import('../src/oauth.js');

invalidateAccountSet();
resetGrantsFileCache();
clearSessionGrant();
setSessionGrant(PBG3_CODE, 'pbg3');

const server = http.createServer(createHttpRequestListener());
let port = 0;

beforeAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('no listen address'));
          return;
        }
        port = addr.port;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => {
        clearSessionGrant();
        delete process.env.MCP_HTTP_TOKEN_GRANT;
        delete process.env.GOOGLE_GRANT_CODE;
        rmSync(dir, { recursive: true, force: true });
        if (err) reject(err);
        else resolve();
      });
    }),
);

function request(opts: {
  token?: string | null;
  body: unknown;
}): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    host: publicMcpHost(),
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'content-length': String(Buffer.byteLength(payload)),
  };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function toolCall(name: string, args: Record<string, unknown> = {}, id = 1) {
  return request({
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
}

function mcpText(raw: string): string {
  const payloads = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const candidates = payloads.length > 0 ? payloads : [raw];
  for (const rawJson of candidates) {
    try {
      const msg = JSON.parse(rawJson) as { result?: { content?: Array<{ text?: string }> } };
      const text = msg.result?.content?.[0]?.text;
      if (typeof text === 'string') return text;
    } catch {
      /* not this frame */
    }
  }
  return raw;
}

function assertNoOutsider(text: string, label: string): void {
  for (const alias of OUTSIDERS) {
    expect(text, `${label} leaked ${alias}`).not.toContain(alias);
    expect(text, `${label} leaked ${alias}@`).not.toContain(`${alias}@`);
  }
}

describe('static MCP bearer grant', () => {
  it('under in-process PBG3, a static bearer and a grantless JWT are refused and see no other alias', async () => {
    expect(getSessionGrant()?.name).toBe('Personal Brain Grant 3');
    expect(getSessionGrant()?.accounts).toEqual(ALL);

    const listed = await toolCall('account_list');
    expect(listed.status).toBe(200);
    const accounts = JSON.parse(mcpText(listed.text));
    expect(accounts.error).toBe('grant_required');
    expect(accounts.accounts).toBeUndefined();
    assertNoOutsider(listed.text, 'account_list');

    const diagnosed = await toolCall('diagnose', {}, 2);
    expect(diagnosed.status).toBe(200);
    const report = JSON.parse(mcpText(diagnosed.text));
    expect(report.error).toBe('grant_required');
    assertNoOutsider(diagnosed.text, 'diagnose');
    expect(diagnosed.text).not.toContain('stromback');

    const tools = await request({
      body: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    });
    expect(tools.status).toBe(200);
    assertNoOutsider(tools.text, 'tools/list');

    const jwt = signJwt({ typ: 'access', cid: 'grok', sc: 'mcp:tools', sub: 'google-multi' }, 3600);
    const grantless = await request({
      token: jwt,
      body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'account_list', arguments: {} } },
    });
    expect(grantless.status).toBe(403);
    expect(JSON.parse(grantless.text).error).toBe('grant_required');
    assertNoOutsider(grantless.text, 'grantless jwt');
    expect(grantless.text).not.toContain('stromback');
    expect(grantless.text).not.toContain(PBG3_CODE);
  });

  it('MCP_HTTP_TOKEN_GRANT=stromback-test gives the static bearer only that grant', async () => {
    process.env.MCP_HTTP_TOKEN_GRANT = 'stromback-test';
    try {
      const listed = await toolCall('account_list', {}, 5);
      expect(listed.status).toBe(200);
      const body = JSON.parse(mcpText(listed.text));
      expect(body.error).toBeUndefined();
      expect(body.accounts.map((row: { alias: string }) => row.alias)).toEqual(['stromback']);
      assertNoOutsider(listed.text, 'named account_list');

      const tools = await request({
        body: { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} },
      });
      expect(tools.status).toBe(200);
      expect(tools.text).toContain('stromback');
      assertNoOutsider(tools.text, 'named tools/list');
    } finally {
      delete process.env.MCP_HTTP_TOKEN_GRANT;
    }
  });

  it('set_grant is refused on hosted and does not adopt PBG3', async () => {
    const prev = process.env.MCP_HOSTED;
    process.env.MCP_HOSTED = '1';
    const before = getSessionGrant();
    try {
      const listed = await toolCall('set_grant', { grant_code: PBG3_CODE }, 7);
      expect(listed.status).toBe(200);
      const body = JSON.parse(mcpText(listed.text));
      expect(body.ok).toBe(false);
      expect(body.error).toBe('hosted_set_grant_refused');
      expect(body.message).toMatch(/oauth\/authorize/);
      assertNoOutsider(listed.text, 'set_grant');
      expect(getSessionGrant()).toEqual(before);

      const accounts = JSON.parse(mcpText((await toolCall('account_list', {}, 8)).text));
      expect(accounts.error).toBe('grant_required');
      assertNoOutsider(JSON.stringify(accounts), 'hosted account_list');
    } finally {
      if (prev === undefined) delete process.env.MCP_HOSTED;
      else process.env.MCP_HOSTED = prev;
    }
  });
});
