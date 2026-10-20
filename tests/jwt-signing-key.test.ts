/**
 * House Grok JWTs are signed with a key that is not the static bearer.
 * Hosted reads MCP_JWT_SIGNING_KEY_FILE only and fails closed when it cannot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { issuer, resourceUrl } from '../src/hosted.js';

const TOKEN = 'mcp-test-token-not-secret';
const SIGNING_KEY = '0123456789abcdef0123456789abcdef';
const PUBLIC_HOST = 'google-multi-mcp-test.a.run.app';
const PBG3 = 'Personal Brain Grant 3';
const ALL = ['personal', 'stromback', 'opcenter', 'buildcoin', 'usa-house', 'olga'];

const dir = mkdtempSync(path.join(tmpdir(), 'gmulti-jwt-key-'));
const grantsPath = path.join(dir, 'grants.json');
const keyPath = path.join(dir, 'jwt-signing-key');
writeFileSync(
  grantsPath,
  JSON.stringify({
    version: 1,
    grants: [{ name: PBG3, code: 'test-code-pbg3-not-prod-ok', accounts: ALL }],
  }),
  'utf8',
);
writeFileSync(keyPath, SIGNING_KEY);

process.env.GOOGLE_ACCOUNTS = ALL.map((alias) => `${alias}:${alias}@example.com`).join(',');
process.env.MCP_HTTP_TOKEN = TOKEN;
process.env.MCP_PUBLIC_HOST = PUBLIC_HOST;
process.env.GOOGLE_GRANTS_PATH = grantsPath;
process.env.GOOGLE_GRANTS_ENFORCE = 'true';
process.env.MCP_JWT_SIGNING_KEY_FILE = keyPath;
delete process.env.MCP_JWT_SIGNING_KEY;
delete process.env.MCP_HTTP_TOKEN_GRANT;
delete process.env.MCP_HOSTED;
delete process.env.K_SERVICE;
delete process.env.GOOGLE_GRANT_CODE;
delete process.env.MCP_OAUTH_REFRESH_TTL;

const { createHttpRequestListener, publicMcpHost } = await import('../src/http.js');
const { grantRecordByName, resetGrantsFileCache } = await import('../src/session-grant.js');
const { invalidateAccountSet } = await import('../src/accounts.js');
const { pkceS256, signJwt, verifyJwt } = await import('../src/oauth.js');

invalidateAccountSet();
resetGrantsFileCache();

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
        rmSync(dir, { recursive: true, force: true });
        if (err) reject(err);
        else resolve();
      });
    }),
);

function b64url(raw: Buffer | string): string {
  const buf = typeof raw === 'string' ? Buffer.from(raw) : raw;
  return buf.toString('base64url');
}

/** Old signer: HMAC under the static bearer. The server must not accept these. */
function signWithBearer(payload: Record<string, unknown>, ttl: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: issuer(), aud: resourceUrl(), iat: now, exp: now + ttl, ...payload };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify(body));
  const sig = b64url(createHmac('sha256', TOKEN).update(`${header}.${claims}`).digest());
  return `${header}.${claims}.${sig}`;
}

function request(opts: {
  method?: string;
  path?: string;
  token?: string | null;
  form?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; text: string }> {
  let payload: string | undefined;
  const headers: Record<string, string> = { host: publicMcpHost() };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.form) {
    payload = new URLSearchParams(opts.form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['content-length'] = String(Buffer.byteLength(payload));
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
    headers.accept = 'application/json, text/event-stream';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: opts.path || '/mcp',
        method: opts.method || 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
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

const accessClaims = { typ: 'access', cid: 'grok', sc: 'mcp:tools', sub: 'google-multi', gname: PBG3 };

async function hostedWithoutKey(file: string | undefined, run: () => Promise<void>): Promise<void> {
  const prevHosted = process.env.MCP_HOSTED;
  const prevFile = process.env.MCP_JWT_SIGNING_KEY_FILE;
  const prevEnv = process.env.MCP_JWT_SIGNING_KEY;
  process.env.MCP_HOSTED = '1';
  if (file === undefined) delete process.env.MCP_JWT_SIGNING_KEY_FILE;
  else process.env.MCP_JWT_SIGNING_KEY_FILE = file;
  process.env.MCP_JWT_SIGNING_KEY = SIGNING_KEY;
  try {
    await run();
  } finally {
    if (prevHosted === undefined) delete process.env.MCP_HOSTED;
    else process.env.MCP_HOSTED = prevHosted;
    if (prevFile === undefined) delete process.env.MCP_JWT_SIGNING_KEY_FILE;
    else process.env.MCP_JWT_SIGNING_KEY_FILE = prevFile;
    if (prevEnv === undefined) delete process.env.MCP_JWT_SIGNING_KEY;
    else process.env.MCP_JWT_SIGNING_KEY = prevEnv;
  }
}

async function expectSigningRefused(previouslyValid: string): Promise<void> {
  const authorize = await request({
    path: '/oauth/authorize?client_id=grok&redirect_uri=https%3A%2F%2Fgrok.com%2Fconnectors-oauth-exchange-code%2F&response_type=code&code_challenge=abc',
  });
  expect(authorize.status).toBe(503);
  expect(authorize.text).toContain('jwt_signing_key_unavailable');
  expect(authorize.text).not.toContain('name="password"');

  const posted = await request({
    method: 'POST',
    path: '/oauth/authorize',
    form: {
      client_id: 'grok',
      redirect_uri: 'https://grok.com/connectors-oauth-exchange-code/',
      response_type: 'code',
      code_challenge: 'abc',
      password: TOKEN,
      grant_code: 'test-code-pbg3-not-prod-ok',
    },
  });
  expect(posted.status).toBe(503);
  expect(posted.text).toContain('jwt_signing_key_unavailable');

  const token = await request({
    method: 'POST',
    path: '/oauth/token',
    form: { grant_type: 'refresh_token', refresh_token: 'not-a-jwt' },
  });
  expect(token.status).toBe(503);
  expect(JSON.parse(token.text).error).toBe('jwt_signing_key_unavailable');

  expect(verifyJwt(previouslyValid)).toBeNull();
  const jwt = await request({
    method: 'POST',
    path: '/mcp',
    token: previouslyValid,
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  });
  expect(jwt.status).toBe(401);

  const bearer = await request({
    method: 'POST',
    path: '/mcp',
    token: TOKEN,
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'account_list', arguments: {} } },
  });
  expect(bearer.status).toBe(200);
  const accounts = JSON.parse(mcpText(bearer.text));
  expect(accounts.error).toBe('grant_required');
  expect(accounts.accounts).toBeUndefined();
}

describe('house Grok JWT signing key', () => {
  it('refuses a JWT signed with the bearer secret on /mcp and at refresh', async () => {
    const access = signWithBearer(accessClaims, 3600);
    expect(verifyJwt(access)).toBeNull();
    const mcp = await request({
      method: 'POST',
      path: '/mcp',
      token: access,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'account_list', arguments: {} } },
    });
    expect(mcp.status).toBe(401);

    const refresh = signWithBearer(
      { typ: 'refresh', cid: 'grok', sc: 'mcp:tools', sub: 'google-multi', gname: PBG3 },
      3600,
    );
    const tok = await request({
      method: 'POST',
      path: '/oauth/token',
      form: { grant_type: 'refresh_token', refresh_token: refresh },
    });
    expect(tok.status).toBe(400);
    expect(JSON.parse(tok.text).error).toBe('invalid_grant');
  });

  it('accepts a JWT signed with the new key and keeps gname on refresh', async () => {
    const access = signJwt(accessClaims, 3600);
    const mcp = await request({
      method: 'POST',
      path: '/mcp',
      token: access,
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'account_list', arguments: {} } },
    });
    expect(mcp.status).toBe(200);
    const listed = JSON.parse(mcpText(mcp.text));
    expect(listed.error).toBeUndefined();
    expect(listed.accounts.map((row: { alias: string }) => row.alias).sort()).toEqual([...ALL].sort());

    const refresh = signJwt(
      { typ: 'refresh', cid: 'grok', sc: 'mcp:tools', sub: 'google-multi', gname: PBG3 },
      60 * 60 * 24 * 30,
    );
    const tok = await request({
      method: 'POST',
      path: '/oauth/token',
      form: { grant_type: 'refresh_token', refresh_token: refresh },
    });
    expect(tok.status).toBe(200);
    const body = JSON.parse(tok.text);
    expect(body.expires_in).toBe(60 * 60);
    expect(verifyJwt(body.access_token)?.gname).toBe(PBG3);
    expect(verifyJwt(body.refresh_token)?.gname).toBe(PBG3);
    const refreshed = verifyJwt(body.refresh_token);
    expect(Number(refreshed?.exp) - Number(refreshed?.iat)).toBe(60 * 60 * 24 * 30);
  });

  it('refuses authorize, token, and JWT on hosted when the key is missing or short', async () => {
    const previouslyValid = signJwt(accessClaims, 3600);
    expect(verifyJwt(previouslyValid)?.gname).toBe(PBG3);
    const refuse = () => expectSigningRefused(previouslyValid);
    await hostedWithoutKey(undefined, refuse);
    const short = path.join(dir, 'short-key');
    writeFileSync(short, 'too-short-to-sign-a-jwt');
    await hostedWithoutKey(short, refuse);
    await hostedWithoutKey(dir, refuse);
  });

  it('refuses an expired access token', async () => {
    const expired = signJwt(accessClaims, -30);
    expect(verifyJwt(expired)).toBeNull();
    const mcp = await request({
      method: 'POST',
      path: '/mcp',
      token: expired,
      body: { jsonrpc: '2.0', id: 4, method: 'initialize', params: {} },
    });
    expect(mcp.status).toBe(401);
  });

  it('honors MCP_OAUTH_REFRESH_TTL and ignores a blank value', async () => {
    process.env.MCP_OAUTH_REFRESH_TTL = '120';
    try {
      const refresh = signJwt(
        { typ: 'refresh', cid: 'grok', sc: 'mcp:tools', sub: 'google-multi', gname: PBG3 },
        600,
      );
      const tok = await request({
        method: 'POST',
        path: '/oauth/token',
        form: { grant_type: 'refresh_token', refresh_token: refresh },
      });
      const body = JSON.parse(tok.text);
      const refreshed = verifyJwt(body.refresh_token);
      expect(Number(refreshed?.exp) - Number(refreshed?.iat)).toBe(120);
      expect(refreshed?.gname).toBe(PBG3);
    } finally {
      delete process.env.MCP_OAUTH_REFRESH_TTL;
    }
    process.env.MCP_OAUTH_REFRESH_TTL = '   ';
    const refresh = signJwt(
      { typ: 'refresh', cid: 'grok', sc: 'mcp:tools', sub: 'google-multi', gname: PBG3 },
      600,
    );
    const tok = await request({
      method: 'POST',
      path: '/oauth/token',
      form: { grant_type: 'refresh_token', refresh_token: refresh },
    });
    const refreshed = verifyJwt(JSON.parse(tok.text).refresh_token);
    expect(Number(refreshed?.exp) - Number(refreshed?.iat)).toBe(60 * 60 * 24 * 30);
    delete process.env.MCP_OAUTH_REFRESH_TTL;
  });

  it('refuses an expired refresh token', async () => {
    const refresh = signJwt(
      { typ: 'refresh', cid: 'grok', sc: 'mcp:tools', sub: 'google-multi', gname: PBG3 },
      -30,
    );
    expect(verifyJwt(refresh)).toBeNull();
    const tok = await request({
      method: 'POST',
      path: '/oauth/token',
      form: { grant_type: 'refresh_token', refresh_token: refresh },
    });
    expect(tok.status).toBe(400);
    expect(JSON.parse(tok.text).error).toBe('invalid_grant');
  });

  it('refresh for a removed gname is refused after the grants cache has loaded', async () => {
    const access = signJwt(accessClaims, 3600);
    const refresh = signJwt(
      { typ: 'refresh', cid: 'grok', sc: 'mcp:tools', sub: 'google-multi', gname: PBG3 },
      3600,
    );
    expect(grantRecordByName(PBG3)?.name).toBe(PBG3);
    const original = readFileSync(grantsPath, 'utf8');
    try {
      writeFileSync(grantsPath, JSON.stringify({ version: 1, grants: [] }), 'utf8');
      const removedRefresh = await request({
        method: 'POST',
        path: '/oauth/token',
        form: { grant_type: 'refresh_token', refresh_token: refresh },
      });
      expect(removedRefresh.status).toBe(400);
      expect(JSON.parse(removedRefresh.text).error).toBe('invalid_grant');
      const removedMcp = await request({
        method: 'POST',
        path: '/mcp',
        token: access,
        body: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'account_list', arguments: {} } },
      });
      expect(removedMcp.status).toBe(401);
      expect(JSON.parse(removedMcp.text).error).toBe('Unauthorized');
    } finally {
      writeFileSync(grantsPath, original, 'utf8');
      resetGrantsFileCache();
    }
  });

  it('a token older than notBefore is refused on refresh and on /mcp', async () => {
    const access = signJwt(accessClaims, 3600);
    const refresh = signJwt(
      { typ: 'refresh', cid: 'grok', sc: 'mcp:tools', sub: 'google-multi', gname: PBG3 },
      3600,
    );
    expect(grantRecordByName(PBG3)?.name).toBe(PBG3);
    const original = readFileSync(grantsPath, 'utf8');
    const write = (notBefore: string) => {
      writeFileSync(
        grantsPath,
        JSON.stringify({
          version: 1,
          grants: [{ name: PBG3, code: 'test-code-pbg3-not-prod-ok', accounts: ALL, notBefore }],
        }),
        'utf8',
      );
    };
    try {
      write(new Date(Date.now() + 60 * 60 * 1000).toISOString());
      const oldRefresh = await request({
        method: 'POST',
        path: '/oauth/token',
        form: { grant_type: 'refresh_token', refresh_token: refresh },
      });
      expect(oldRefresh.status).toBe(400);
      expect(JSON.parse(oldRefresh.text).error).toBe('invalid_grant');
      const oldMcp = await request({
        method: 'POST',
        path: '/mcp',
        token: access,
        body: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'account_list', arguments: {} } },
      });
      expect(oldMcp.status).toBe(401);
      expect(JSON.parse(oldMcp.text).error).toBe('Unauthorized');

      write(new Date(Date.now() - 60 * 60 * 1000).toISOString());
      const fresh = await request({
        method: 'POST',
        path: '/oauth/token',
        form: { grant_type: 'refresh_token', refresh_token: refresh },
      });
      expect(fresh.status).toBe(200);
      expect(verifyJwt(JSON.parse(fresh.text).access_token)?.gname).toBe(PBG3);
      const ok = await request({
        method: 'POST',
        path: '/mcp',
        token: access,
        body: { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'account_list', arguments: {} } },
      });
      expect(ok.status).toBe(200);
      const listed = JSON.parse(mcpText(ok.text));
      expect(listed.error).toBeUndefined();
      expect(listed.accounts.map((row: { alias: string }) => row.alias).sort()).toEqual([...ALL].sort());
    } finally {
      writeFileSync(grantsPath, original, 'utf8');
      resetGrantsFileCache();
    }
  });

  const CODE_VERIFIER = 'exchange-verifier-not-a-production-secret';
  const CODE_REDIRECT = 'https://grok.com/connectors-oauth-exchange-code/';

  function authorizationCode(): string {
    return signJwt(
      {
        typ: 'code',
        cid: 'grok',
        ru: CODE_REDIRECT,
        ch: pkceS256(CODE_VERIFIER),
        sc: 'mcp:tools',
        gname: PBG3,
      },
      300,
    );
  }

  function exchangeCode(code: string) {
    return request({
      method: 'POST',
      path: '/oauth/token',
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: CODE_REDIRECT,
        code_verifier: CODE_VERIFIER,
        client_id: 'grok',
      },
    });
  }

  it('authorization code minted before notBefore is refused at exchange', async () => {
    expect(grantRecordByName(PBG3)?.name).toBe(PBG3);
    const code = authorizationCode();
    expect(Number(verifyJwt(code)?.iat)).toBeLessThan(Date.now() / 1000 + 5);
    const original = readFileSync(grantsPath, 'utf8');
    try {
      writeFileSync(
        grantsPath,
        JSON.stringify({
          version: 1,
          grants: [{
            name: PBG3,
            code: 'test-code-pbg3-not-prod-ok',
            accounts: ALL,
            notBefore: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }],
        }),
        'utf8',
      );
      const refused = await exchangeCode(code);
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text).error).toBe('invalid_grant');
      expect(refused.text).not.toContain('access_token');
    } finally {
      writeFileSync(grantsPath, original, 'utf8');
      resetGrantsFileCache();
    }
  });

  it('authorization code whose grant was removed is refused at exchange', async () => {
    const code = authorizationCode();
    expect(grantRecordByName(PBG3)?.name).toBe(PBG3);
    const original = readFileSync(grantsPath, 'utf8');
    try {
      writeFileSync(grantsPath, JSON.stringify({ version: 1, grants: [] }), 'utf8');
      const refused = await exchangeCode(code);
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text).error).toBe('invalid_grant');
      expect(refused.text).not.toContain('access_token');
    } finally {
      writeFileSync(grantsPath, original, 'utf8');
      resetGrantsFileCache();
    }
  });
});
