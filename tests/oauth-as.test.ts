/**
 * Grok connector OAuth (layer 2) around MCP_HTTP_TOKEN + session grant in JWT (layer 3).
 * Does not mint Google provider tokens (layer 1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TOKEN = 'mcp-test-token-not-secret';
const PUBLIC_HOST = 'google-multi-mcp-test.a.run.app';
const GRANT_CODE = 'test-code-stromback-not-prod';

const dir = mkdtempSync(path.join(tmpdir(), 'gmulti-oauth-'));
const grantsPath = path.join(dir, 'grants.json');
writeFileSync(
  grantsPath,
  JSON.stringify({
    version: 1,
    grants: [
      {
        name: 'Personal Brain Grant 3',
        code: 'test-code-personal-brain-not-prod',
        accounts: ['test'],
      },
      {
        name: 'StrombackBrain2',
        code: GRANT_CODE,
        accounts: ['test'],
      },
    ],
  }),
  'utf8',
);

process.env.MCP_HTTP_TOKEN = TOKEN;
process.env.MCP_PUBLIC_HOST = PUBLIC_HOST;
process.env.GOOGLE_GRANTS_PATH = grantsPath;
process.env.GOOGLE_GRANTS_ENFORCE = 'true';
delete process.env.GOOGLE_GRANT_CODE;

const { createHttpRequestListener, publicMcpHost } = await import('../src/http.js');
const { clearSessionGrant, resetGrantsFileCache } = await import('../src/session-grant.js');
const { verifyJwt } = await import('../src/oauth.js');

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
        err ? reject(err) : resolve();
      });
    }),
);

function request(opts: {
  method?: string;
  path?: string;
  token?: string | null;
  host?: string;
  origin?: string;
  body?: unknown;
  form?: Record<string, string>;
  skipAuth?: boolean;
}): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  let payload: string | undefined;
  const headers: Record<string, string> = {};
  if (opts.host) headers.host = opts.host;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.token !== null && !opts.skipAuth && opts.token !== undefined) {
    headers.authorization = `Bearer ${opts.token}`;
  } else if (opts.token !== null && !opts.skipAuth && opts.token === undefined && !opts.form && opts.body) {
    headers.authorization = `Bearer ${TOKEN}`;
  }
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
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

describe('google-multi Grok OAuth (layer 2) + JWT grant (layer 3)', () => {
  it('serves authorization-server metadata', async () => {
    const { status, text } = await request({
      path: '/.well-known/oauth-authorization-server',
      skipAuth: true,
      token: null,
    });
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.issuer).toBe(`https://${PUBLIC_HOST}`);
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.registration_endpoint).toContain('/oauth/register');
    expect(body.code_challenge_methods_supported).toContain('S256');
  });

  it('DCR register returns client_id grok', async () => {
    const { status, text } = await request({
      method: 'POST',
      path: '/oauth/register',
      skipAuth: true,
      token: null,
      body: { redirect_uris: ['https://grok.com/connectors-oauth-exchange-code/'], client_name: 'Grok' },
    });
    expect(status).toBe(201);
    const body = JSON.parse(text);
    expect(body.client_id).toBe('grok');
    expect(body.redirect_uris).toContain('https://grok.com/connectors-oauth-exchange-code/');
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('authorize page is not Google login', async () => {
    const { challenge } = pkce();
    const q = new URLSearchParams({
      client_id: 'grok',
      redirect_uri: 'https://grok.com/connectors-oauth-exchange-code/',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st',
    });
    const { status, text } = await request({
      path: `/oauth/authorize?${q}`,
      skipAuth: true,
      token: null,
    });
    expect(status).toBe(200);
    expect(text).toMatch(/not<\/strong> Google login|not Google login/i);
    expect(text).toContain('MCP HTTP token');
    expect(text).toContain('Session grant');
    expect(text).toContain('StrombackBrain2');
    expect(text).toContain('Personal Brain Grant 3');
    expect(text).not.toContain(GRANT_CODE);
    expect(text).not.toContain('mega-OAuth');
  });

  it('loopback redirect finishes on grok.com, not only localhost:8787', async () => {
    const { verifier, challenge } = pkce();
    const form = {
      client_id: 'grok',
      redirect_uri: 'http://localhost:8787/callback',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'retry',
      password: TOKEN,
      grant_code: GRANT_CODE,
    };
    const { status, text } = await request({
      method: 'POST',
      path: '/oauth/authorize',
      skipAuth: true,
      token: null,
      form,
    });
    expect(status).toBe(200);
    expect(text).toContain('https://grok.com/connectors-oauth-exchange-code/');
    expect(text).toContain('code=');
    expect(verifier.length).toBeGreaterThan(10);
  });

  it('PKCE token JWT carries grant name and restores the slice without set_grant', async () => {
    const { verifier, challenge } = pkce();
    const redirect = 'https://grok.com/connectors-oauth-exchange-code/';
    const posted = await request({
      method: 'POST',
      path: '/oauth/authorize',
      skipAuth: true,
      token: null,
      form: {
        client_id: 'grok',
        redirect_uri: redirect,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 's1',
        password: TOKEN,
        grant_code: GRANT_CODE,
      },
    });
    expect(posted.status).toBe(302);
    const loc = String(posted.headers.location || '');
    expect(loc.startsWith(redirect)).toBe(true);
    const code = new URL(loc).searchParams.get('code');
    expect(code).toBeTruthy();

    const tok = await request({
      method: 'POST',
      path: '/oauth/token',
      skipAuth: true,
      token: null,
      form: {
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirect,
        code_verifier: verifier,
        client_id: 'grok',
      },
    });
    expect(tok.status).toBe(200);
    const tokens = JSON.parse(tok.text);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toBeTruthy();
    const payload = verifyJwt(tokens.access_token);
    expect(payload?.typ).toBe('access');
    expect(payload?.gname).toBe('StrombackBrain2');
    expect(payload).not.toHaveProperty('code');
    expect(JSON.stringify(payload)).not.toContain(GRANT_CODE);

    clearSessionGrant();

    const listed = await request({
      method: 'POST',
      path: '/mcp',
      token: tokens.access_token,
      host: publicMcpHost(),
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'grant_status', arguments: {} } },
    });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('StrombackBrain2');
    expect(listed.text).toMatch(/source\\":\\"token\\"/);
    expect(listed.text).toContain('test');
  });

  it('static Bearer still works for CLI (layer 2 without OAuth)', async () => {
    const { status } = await request({
      method: 'POST',
      path: '/mcp',
      token: TOKEN,
      host: publicMcpHost(),
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cli', version: '0' },
        },
      },
    });
    expect(status).toBe(200);
  });

  it('enforced grants without JWT gname fail closed on account_list', async () => {
    clearSessionGrant();
    const listed = await request({
      method: 'POST',
      path: '/mcp',
      token: TOKEN,
      host: publicMcpHost(),
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'account_list', arguments: {} } },
    });
    expect(listed.status).toBe(200);
    expect(listed.text).toMatch(/grant_required|No session grant/);
  });

  it('POST /mcp without Bearer is 401 with resource_metadata', async () => {
    const { status, text, headers } = await request({
      method: 'POST',
      path: '/mcp',
      token: null,
      skipAuth: true,
      host: publicMcpHost(),
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(status).toBe(401);
    expect(JSON.parse(text).error).toBe('Unauthorized');
    expect(String(headers['www-authenticate'] || '')).toContain('oauth-protected-resource');
  });
});
