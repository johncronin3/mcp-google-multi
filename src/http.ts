#!/usr/bin/env node
/**
 * Streamable HTTP MCP for google-multi (Grok Bot / xAI remote MCP).
 *
 * Env:
 *   PORT, MCP_HTTP_TOKEN / MCP_API_KEY
 *   MCP_PUBLIC_HOST — Cloud Run hostname (required for public Host)
 *   MCP_ALLOWED_HOSTS / MCP_ALLOWED_ORIGINS — extras (comma-separated)
 */
import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildGoogleMcpServer } from './index.js';

export const DEFAULT_PUBLIC_MCP_HOST = 'google-multi-mcp-tdhsljvruq-uc.a.run.app';
const EXTRA_PUBLIC_HOSTS = ['google-multi-mcp-794931160113.us-central1.run.app'];

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const GROK_ORIGINS = [
  'https://grok.com',
  'https://www.grok.com',
  'https://grok.x.ai',
  'https://x.ai',
];

function csvEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function publicMcpHost(): string {
  return (process.env.MCP_PUBLIC_HOST || DEFAULT_PUBLIC_MCP_HOST).trim();
}

function allowedHostnames(): string[] {
  return [...new Set([publicMcpHost(), DEFAULT_PUBLIC_MCP_HOST, ...EXTRA_PUBLIC_HOSTS, ...LOCAL_HOSTS, ...csvEnv('MCP_ALLOWED_HOSTS')])];
}

function allowedOrigins(): string[] {
  const host = publicMcpHost();
  return [
    ...new Set([
      `https://${host}`,
      'http://localhost',
      'http://127.0.0.1',
      'http://[::1]',
      ...GROK_ORIGINS,
      ...csvEnv('MCP_ALLOWED_ORIGINS'),
    ]),
  ];
}

function hostnameOf(hostHeader: string): string | null {
  const raw = hostHeader.trim();
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname || null;
  } catch {
    return null;
  }
}

function hostAllowed(hostHeader: string): boolean {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  const allowed = new Set(
    allowedHostnames().map((h) => h.replace(/^\[/, '').replace(/\]$/, '')),
  );
  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '');
  return allowed.has(hostname) || allowed.has(normalized);
}

function originAllowed(originHeader: string): boolean {
  if (!originHeader) return true;
  const allowed = new Set(allowedOrigins());
  if (allowed.has(originHeader)) return true;
  try {
    return allowed.has(new URL(originHeader).origin);
  } catch {
    return false;
  }
}

export function expectedToken(): string | null {
  return process.env.MCP_HTTP_TOKEN || process.env.MCP_API_KEY || null;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (!expected) return false;
  const auth = String(req.headers.authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const header = String(req.headers['x-mcp-api-key'] || '').trim();
  const provided = bearer || header;
  return Boolean(provided && safeEqual(provided, expected));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function plain(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
}

export function createHttpRequestListener(): RequestListener {
  return (req, res) => {
    void dispatchHttp(req, res);
  };
}

async function dispatchHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    json(res, 200, {
      ok: true,
      service: 'google-multi-mcp',
      transport: 'streamable-http',
      mcp: '/mcp',
    });
    return;
  }

  if (path !== '/mcp') {
    json(res, 404, { error: 'Not found' });
    return;
  }

  if (!expectedToken()) {
    json(res, 503, { error: 'MCP HTTP token is not configured' });
    return;
  }
  if (!authorized(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  const hostHeader = String(req.headers.host || '');
  if (!hostAllowed(hostHeader)) {
    plain(res, 421, 'Invalid Host header');
    return;
  }
  const originHeader = String(req.headers.origin || '');
  if (originHeader && !originAllowed(originHeader)) {
    plain(res, 403, 'Invalid Origin header');
    return;
  }

  try {
    const mcp = buildGoogleMcpServer();
    const pub = publicMcpHost();
    // Some SDK versions treat missing Origin as invalid when allowedOrigins is set.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts: [hostHeader, pub, `${pub}:443`, 'localhost', '127.0.0.1', '[::1]'],
      ...(originHeader
        ? { allowedOrigins: [...allowedOrigins(), originHeader] }
        : {}),
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('google-multi-mcp http error:', err);
    if (!res.headersSent) {
      json(res, 500, { error: 'MCP request failed' });
    }
  }
}

export function listenHttp(port = Number(process.env.PORT || 8080)) {
  const server = createServer(createHttpRequestListener());
  server.listen(port, '0.0.0.0', () => {
    console.error(`google-multi MCP HTTP listening on :${port}  POST/GET /mcp`);
  });
  return server;
}

const startedAsCli =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('http.js') || process.argv[1].endsWith('http.ts'));

if (startedAsCli) {
  if (!expectedToken()) {
    console.error('google-multi-mcp HTTP: MCP_HTTP_TOKEN unset — refusing to listen');
    process.exit(2);
  }
  listenHttp();
}
