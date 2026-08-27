/**
 * HTTP MCP Host/Origin/Bearer gating — shipped createHttpRequestListener.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';

const TOKEN = 'mcp-test-token-not-secret';
const PUBLIC_HOST = 'google-multi-mcp-test.a.run.app';

process.env.MCP_HTTP_TOKEN = TOKEN;
process.env.MCP_PUBLIC_HOST = PUBLIC_HOST;
process.env.GOOGLE_GRANTS_ENFORCE = 'false';

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-google-http', version: '0' },
  },
};
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

const { createHttpRequestListener, publicMcpHost } = await import('../src/http.js');

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
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

function request(opts: {
  method?: string;
  path?: string;
  token?: string | null;
  host?: string;
  origin?: string;
  body?: unknown;
  skipAuth?: boolean;
}): Promise<{ status: number; text: string }> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {};
  if (opts.host) headers.host = opts.host;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.token !== null && !opts.skipAuth) {
    headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  }
  if (payload) {
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
        method: opts.method || 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function postMcp(opts: {
  token?: string | null;
  host?: string;
  origin?: string;
  body?: unknown;
}) {
  return request({
    ...opts,
    host: opts.host ?? publicMcpHost(),
    body: opts.body ?? INIT,
  });
}

describe('google-multi HTTP MCP', () => {
  it('public host with valid Bearer is not Invalid Host', async () => {
    const { status, text } = await postMcp({});
    expect(status).not.toBe(421);
    expect(text).not.toContain('Invalid Host header');
    expect(status).not.toBe(403);
    expect(text).not.toContain('Invalid Origin header');
    expect(status).not.toBe(401);
    expect(status).toBe(200);
  });

  it('public host with grok Origin is not Invalid Origin', async () => {
    const { status, text } = await postMcp({ origin: 'https://grok.com' });
    expect(status).not.toBe(421);
    expect(text).not.toContain('Invalid Host header');
    expect(status).not.toBe(403);
    expect(text).not.toContain('Invalid Origin header');
    expect(status).not.toBe(401);
    expect(status).toBe(200);
  });

  it('unknown host is 421', async () => {
    const { status, text } = await postMcp({ host: 'evil.example' });
    expect(status).toBe(421);
    expect(text).toContain('Invalid Host header');
  });

  it('unknown origin is 403', async () => {
    const { status, text } = await postMcp({ origin: 'https://evil.example' });
    expect(status).toBe(403);
    expect(text).toContain('Invalid Origin header');
  });

  it('missing Bearer is 401', async () => {
    const { status, text } = await postMcp({ token: null });
    expect(status).toBe(401);
    expect(JSON.parse(text).error).toBe('Unauthorized');
  });

  it('wrong Bearer is 401', async () => {
    const { status, text } = await postMcp({ token: 'wrong-token' });
    expect(status).toBe(401);
    expect(JSON.parse(text).error).toBe('Unauthorized');
  });

  it('tools/list names set_grant', async () => {
    const init = await postMcp({});
    expect(init.status).toBe(200);
    const listed = await postMcp({ body: TOOLS_LIST });
    expect(listed.status).not.toBe(421);
    expect(listed.status).not.toBe(403);
    expect(listed.status).not.toBe(401);
    expect(listed.text).toContain('set_grant');
    expect(listed.text).toMatch(/account_list|list_accounts/);
  });
});
