#!/usr/bin/env node
/**
 * Streamable HTTP MCP for google-multi (Grok Bot / xAI remote MCP).
 *
 * Layer 2: MCP_HTTP_TOKEN (static Bearer for CLI/Hermes, or Grok OAuth wrapper).
 * Layer 3: session grant restored from JWT `gname` (no sticky sessions).
 * Layer 1: never reminted here — missing Google tokens fail closed (desk-mint).
 *
 * Env:
 *   PORT, MCP_HTTP_TOKEN / MCP_API_KEY
 *   MCP_PUBLIC_HOST — Cloud Run hostname (required for public Host)
 *   MCP_ALLOWED_HOSTS / MCP_ALLOWED_ORIGINS — extras (comma-separated)
 *   MCP_HOSTED / K_SERVICE — hosted mode (no 8000/8787)
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
import {
  DEFAULT_PUBLIC_MCP_HOST,
  EXTRA_PUBLIC_HOSTS,
  assertHostedListenPort,
  csvEnvList,
  isHostedHttp,
  issuer,
  publicMcpHost,
} from './hosted.js';
import {
  accessGrantName,
  bearerIsValid,
  handleOAuth,
  isJwtAccessToken,
  isOAuthPath,
} from './oauth.js';
import { resolveGrantByName, runWithGrant } from './session-grant.js';

export { DEFAULT_PUBLIC_MCP_HOST, publicMcpHost };

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const GROK_ORIGINS = [
  'https://grok.com',
  'https://www.grok.com',
  'https://grok.x.ai',
  'https://x.ai',
];

function allowedHostnames(): string[] {
  return [
    ...new Set([
      publicMcpHost(),
      DEFAULT_PUBLIC_MCP_HOST,
      ...EXTRA_PUBLIC_HOSTS,
      ...LOCAL_HOSTS,
      ...csvEnvList('MCP_ALLOWED_HOSTS'),
    ]),
  ];
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
      ...csvEnvList('MCP_ALLOWED_ORIGINS'),
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
  const allowed = new Set(allowedHostnames().map((h) => h.replace(/^\[/, '').replace(/\]$/, '')));
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

function providedBearer(req: IncomingMessage): string {
  const auth = String(req.headers.authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const header = String(req.headers['x-mcp-api-key'] || '').trim();
  return bearer || header;
}

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (!expected) return false;
  return bearerIsValid(providedBearer(req), expected);
}

function json(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function plain(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
}

function unauthorized(res: ServerResponse): void {
  const metadata = `${issuer()}/.well-known/oauth-protected-resource`;
  json(
    res,
    401,
    { error: 'Unauthorized' },
    { 'WWW-Authenticate': `Bearer realm="google-multi-mcp", resource_metadata="${metadata}"` },
  );
}

export function createHttpRequestListener(): RequestListener {
  return (req, res) => {
    void dispatchHttp(req, res);
  };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  const mcp = buildGoogleMcpServer();
  const pub = publicMcpHost();
  // Some SDK versions treat missing Origin as invalid when allowedOrigins is set.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: true,
    allowedHosts: [hostHeader, pub, `${pub}:443`, 'localhost', '127.0.0.1', '[::1]'],
    ...(originHeader ? { allowedOrigins: [...allowedOrigins(), originHeader] } : {}),
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
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
      oauth: '/.well-known/oauth-authorization-server',
    });
    return;
  }

  if (isOAuthPath(path)) {
    await handleOAuth(req, res, url);
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
    unauthorized(res);
    return;
  }

  const token = providedBearer(req);
  const jwt = isJwtAccessToken(token);
  const grantName = jwt ? accessGrantName(token) : undefined;
  const tokenGrant = grantName ? resolveGrantByName(grantName) : null;

  try {
    if (jwt) {
      // JWT path is request-scoped: fail closed if gname missing/unknown.
      await runWithGrant(tokenGrant, () => handleMcp(req, res));
    } else {
      await handleMcp(req, res);
    }
  } catch (err) {
    console.error('google-multi-mcp http error:', err);
    if (!res.headersSent) {
      json(res, 500, { error: 'MCP request failed' });
    }
  }
}

export function listenHttp(port = Number(process.env.PORT || 8080)) {
  assertHostedListenPort(port);
  const server = createServer(createHttpRequestListener());
  server.listen(port, '0.0.0.0', () => {
    const mode = isHostedHttp() ? 'hosted' : 'desk';
    console.error(
      `google-multi MCP HTTP listening on :${port} (${mode})  POST/GET /mcp  OAuth /.well-known + /oauth/*`,
    );
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
