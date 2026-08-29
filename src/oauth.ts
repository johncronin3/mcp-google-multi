/**
 * Grok Bot connector OAuth (layer 2) — wraps MCP_HTTP_TOKEN only.
 *
 * This is NOT Google (layer 1) login and NOT a mega-OAuth across aliases.
 * Each Google alias is still minted on a desk with `auth --account` and stored
 * encrypted. Grok.com always asks Custom connectors for OAuth (authorization_code
 * + S256 PKCE) against https://grok.com/connectors-oauth-exchange-code/.
 *
 * Optional session grant code on the authorize page is layer 3 (which aliases
 * this brain may use). It is bound into the HMAC access token as grant *name*
 * so Cloud Run replicas need no sticky sessions. Codes never go in the JWT.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parse as parseForm } from 'node:querystring';
import {
  DEFAULT_OAUTH_CLIENT_ID,
  GROK_REDIRECT,
  issuer,
  resourceUrl,
} from './hosted.js';
import { isGrantEnforced, loadGrantsFile, resolveGrantByCode } from './session-grant.js';

const SCOPES = ['mcp:tools', 'openid', 'offline_access'] as const;
const CODE_TTL = 300;
const ACCESS_TTL = 60 * 60 * 24 * 30;
const REFRESH_TTL = 60 * 60 * 24 * 90;

export type JwtPayload = Record<string, unknown>;

function hmacSecret(): Buffer {
  const raw = process.env.MCP_HTTP_TOKEN || process.env.MCP_API_KEY || '';
  return Buffer.from(raw, 'utf8');
}

function b64url(raw: Buffer | string): string {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  return buf.toString('base64url');
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

export function signJwt(payload: JwtPayload, ttl: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    iss: issuer(),
    aud: resourceUrl(),
    iat: now,
    exp: now + ttl,
    ...payload,
  };
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const claims = b64urlJson(body);
  const sig = b64url(createHmac('sha256', hmacSecret()).update(`${header}.${claims}`).digest());
  return `${header}.${claims}.${sig}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split('.');
  const secret = hmacSecret();
  if (parts.length !== 3 || secret.length === 0) return null;
  const [header, claims, sig] = parts;
  const expected = b64url(createHmac('sha256', secret).update(`${header}.${claims}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }
  if (Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) return null;
  if (payload.iss !== issuer()) return null;
  return payload;
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function redirectAllowed(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const host = (parsed.hostname || '').toLowerCase();
  if (
    scheme === 'https' &&
    ['grok.com', 'www.grok.com', 'grok.x.ai', 'www.cursor.com', 'cursor.com'].includes(host)
  ) {
    return true;
  }
  if (['http', 'https'].includes(scheme) && ['localhost', '127.0.0.1', '::1'].includes(host)) {
    return true;
  }
  if (scheme === 'cursor') return true;
  return false;
}

function normalizeUri(uri: string): string {
  return (uri || '').trim().replace(/\/+$/, '');
}

function isLoopback(uri: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(uri).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function redirectsMatch(left: string, right: string): boolean {
  if (normalizeUri(left) === normalizeUri(right)) return true;
  // Grok in-chat Retry often starts OAuth with localhost:8787, then exchanges from grok.com.
  return redirectAllowed(left) && redirectAllowed(right);
}

function callbackUrl(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function tokenOk(provided: string): boolean {
  const expected = hmacSecret().toString('utf8');
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function authorizationServerMetadata(): Record<string, unknown> {
  const base = issuer();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
  };
}

export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: resourceUrl(),
    authorization_servers: [issuer()],
    bearer_methods_supported: ['header'],
    scopes_supported: [...SCOPES],
  };
}

function grantNames(): string[] {
  const file = loadGrantsFile();
  return file?.grants.map((g) => g.name) ?? [];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlPage(title: string, body: string, status: number, res: ServerResponse): void {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}
label{display:block;margin:.75rem 0 .25rem;font-weight:600}
input[type=password],input[type=text]{width:100%;padding:.5rem;box-sizing:border-box}
button{margin-top:1rem;padding:.6rem 1rem;font-weight:600;cursor:pointer}
.err{color:#b00020}
.muted{color:#555;font-size:.9rem}
code{font-size:.85em}
</style></head><body>${body}</body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function json(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function authorizeForm(params: Record<string, string>, res: ServerResponse, error = ''): void {
  const hidden = Object.entries(params)
    .filter(([k]) => k !== 'password' && k !== 'grant_code')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('');
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  const dest = params.redirect_uri || '';
  const names = grantNames();
  const namesLine = names.length
    ? `Configured grant names (not codes): ${names.map((n) => `<code>${escapeHtml(n)}</code>`).join(', ')}.`
    : 'No grants.json loaded — leave grant code blank only if enforcement is off.';
  const required = isGrantEnforced() ? 'required' : '';
  const body = `
<h1>google-multi MCP</h1>
<p class="muted">This page is <strong>Grok connector OAuth</strong> (layer 2). It is <strong>not</strong> Google login.
Each Google alias was minted on a desk with <code>auth --account</code> and stored encrypted (layer 1).
This form does not remint provider tokens and does not pick a Google account.</p>
<p class="muted">After authorize, the browser returns to <code>${escapeHtml(dest)}</code>.
Hosted mode never uses localhost:8787 as the finish URL — use the grok.com link if Retry pointed at loopback.</p>
${err}
<form method="post" action="/oauth/authorize">
${hidden}
<label for="password">MCP HTTP token</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<p class="muted">Secret Manager / <code>MCP_HTTP_TOKEN</code>. Grok CLI can skip this page and send the same value as <code>Authorization: Bearer</code>.</p>
<label for="grant_code">Session grant code</label>
<input id="grant_code" name="grant_code" type="password" autocomplete="off" ${required}>
<p class="muted">Layer 3 — slices which already-minted aliases this brain may use
(e.g. Personal Brain Grant 3, StrombackBrain2). ${namesLine}
Codes stay host-local. Bound into the access token as the grant <em>name</em> so every Cloud Run replica sees the same slice.</p>
<button type="submit">Authorize Grok</button>
</form>
`;
  htmlPage('Authorize google-multi MCP', body, error ? 400 : 200, res);
}

function finishAuthorize(code: string, state: string, requested: string, res: ServerResponse): void {
  const params: Record<string, string> = { code };
  if (state) params.state = state;
  const primary = callbackUrl(requested, params);
  if (!isLoopback(requested)) {
    res.writeHead(302, { location: primary });
    res.end();
    return;
  }
  const grokUrl = callbackUrl(GROK_REDIRECT, params);
  htmlPage(
    'Authorization complete',
    `<h1>Authorization complete</h1>
<p>Grok Bot: <a href="${escapeHtml(grokUrl)}">Finish connecting on grok.com</a></p>
<p class="muted">Cursor / local: <a href="${escapeHtml(primary)}">${escapeHtml(requested)}</a></p>
<p class="muted">If localhost shows <code>Not Found</code>, use the grok.com link. Hosted MCP never binds :8787.</p>
<meta http-equiv="refresh" content="0;url=${escapeHtml(grokUrl)}">`,
    200,
    res,
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function formOrJson(req: IncomingMessage): Promise<Record<string, string>> {
  const ctype = String(req.headers['content-type'] || '').toLowerCase();
  const raw = await readBody(req);
  if (ctype.includes('application/json')) {
    try {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v == null ? '' : String(v)]));
    } catch {
      return {};
    }
  }
  const parsed = parseForm(raw);
  return Object.fromEntries(
    Object.entries(parsed).map(([k, v]) => [k, Array.isArray(v) ? (v[v.length - 1] ?? '') : (v ?? '')]),
  );
}

function issueTokens(clientId: string, scope: string, grantName: string | undefined): Record<string, unknown> {
  const extra: JwtPayload = { cid: clientId, sc: scope, sub: 'google-multi' };
  if (grantName) extra.gname = grantName;
  const access = signJwt({ typ: 'access', ...extra }, ACCESS_TTL);
  const refresh = signJwt({ typ: 'refresh', ...extra }, REFRESH_TTL);
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    scope,
  };
}

function queryParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function authorizeGet(url: URL, res: ServerResponse): void {
  const q = queryParams(url);
  const missing = ['client_id', 'redirect_uri', 'response_type', 'code_challenge'].filter((k) => !q[k]);
  if (missing.length || q.response_type !== 'code') {
    htmlPage(
      'Authorize google-multi MCP',
      `<h1>Invalid authorization request</h1><p class="err">Missing OAuth parameters from Grok.</p>`,
      400,
      res,
    );
    return;
  }
  if (q.code_challenge_method && q.code_challenge_method !== 'S256') {
    htmlPage('Authorize google-multi MCP', `<p class="err">PKCE S256 is required.</p>`, 400, res);
    return;
  }
  if (!redirectAllowed(q.redirect_uri)) {
    htmlPage(
      'Authorize google-multi MCP',
      `<h1>Invalid authorization request</h1><p class="err">Unsupported redirect_uri: <code>${escapeHtml(q.redirect_uri)}</code></p>`,
      400,
      res,
    );
    return;
  }
  authorizeForm(q, res);
}

async function authorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const data = await formOrJson(req);
  const password = data.password || '';
  if (!tokenOk(password)) {
    authorizeForm(data, res, 'Wrong MCP token.');
    return;
  }
  const redirectUri = data.redirect_uri || '';
  if (!redirectAllowed(redirectUri)) {
    htmlPage(
      'Authorize google-multi MCP',
      `<h1>Invalid authorization request</h1><p class="err">Unsupported redirect_uri: <code>${escapeHtml(redirectUri)}</code></p>`,
      400,
      res,
    );
    return;
  }
  if ((data.response_type || 'code') !== 'code') {
    htmlPage('Authorize google-multi MCP', `<p class="err">response_type must be code.</p>`, 400, res);
    return;
  }
  const challenge = data.code_challenge || '';
  if (!challenge) {
    htmlPage('Authorize google-multi MCP', `<p class="err">code_challenge is required.</p>`, 400, res);
    return;
  }

  let grantName: string | undefined;
  const grantCode = (data.grant_code || '').trim();
  if (isGrantEnforced() && !grantCode) {
    authorizeForm(data, res, 'Session grant code is required (layer 3). This is not a Google password.');
    return;
  }
  if (grantCode) {
    const rec = resolveGrantByCode(grantCode);
    if (!rec) {
      authorizeForm(data, res, 'Grant code not recognized. Check host-local grants.json (names only in docs).');
      return;
    }
    grantName = rec.name;
  }

  const scope = data.scope || 'mcp:tools';
  const payload: JwtPayload = {
    typ: 'code',
    cid: data.client_id || DEFAULT_OAUTH_CLIENT_ID,
    ru: redirectUri,
    ch: challenge,
    sc: scope,
  };
  if (grantName) payload.gname = grantName;
  const code = signJwt(payload, CODE_TTL);
  finishAuthorize(code, data.state || '', redirectUri, res);
}

async function tokenPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const data = await formOrJson(req);
  const grant = data.grant_type || '';
  const headers = { 'Access-Control-Allow-Origin': '*' };
  if (grant === 'refresh_token') {
    const payload = verifyJwt(data.refresh_token || '');
    if (!payload || payload.typ !== 'refresh') {
      json(res, 400, { error: 'invalid_grant' }, headers);
      return;
    }
    json(
      res,
      200,
      issueTokens(
        String(payload.cid || DEFAULT_OAUTH_CLIENT_ID),
        String(payload.sc || 'mcp:tools'),
        typeof payload.gname === 'string' ? payload.gname : undefined,
      ),
      headers,
    );
    return;
  }
  if (grant !== 'authorization_code') {
    json(res, 400, { error: 'unsupported_grant_type' }, headers);
    return;
  }
  const payload = verifyJwt(data.code || '');
  if (!payload || payload.typ !== 'code') {
    json(res, 400, { error: 'invalid_grant' }, headers);
    return;
  }
  if (data.redirect_uri && !redirectsMatch(data.redirect_uri, String(payload.ru || ''))) {
    console.error('oauth token redirect mismatch', data.redirect_uri, payload.ru);
    json(res, 400, { error: 'invalid_grant' }, headers);
    return;
  }
  const verifier = data.code_verifier || '';
  if (!verifier || pkceS256(verifier) !== payload.ch) {
    json(res, 400, { error: 'invalid_grant' }, headers);
    return;
  }
  json(
    res,
    200,
    issueTokens(
      String(payload.cid || DEFAULT_OAUTH_CLIENT_ID),
      String(payload.sc || 'mcp:tools'),
      typeof payload.gname === 'string' ? payload.gname : undefined,
    ),
    headers,
  );
}

async function registerPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
  } catch {
    body = {};
  }
  console.error('oauth register', JSON.stringify(body).slice(0, 1000));
  let redirectUris = body.redirect_uris;
  if (typeof redirectUris === 'string') redirectUris = [redirectUris];
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) redirectUris = [GROK_REDIRECT];
  const echoed = (redirectUris as unknown[]).filter((u): u is string => typeof u === 'string' && Boolean(u.trim()));
  if (!echoed.includes(GROK_REDIRECT)) echoed.push(GROK_REDIRECT);
  json(
    res,
    201,
    {
      client_id: (typeof body.client_id === 'string' && body.client_id) || DEFAULT_OAUTH_CLIENT_ID,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: echoed,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Grok',
    },
  );
}

export function isOAuthPath(path: string): boolean {
  return path.startsWith('/.well-known') || path.startsWith('/oauth');
}

/**
 * Static MCP_HTTP_TOKEN (Grok CLI / Hermes) or a JWT issued by this OAuth server.
 * JWTs are layer 2 access tokens; they may carry layer 3 grant name (`gname`) but
 * never layer 1 Google credentials.
 */
export function bearerIsValid(provided: string, staticToken: string): boolean {
  if (!provided) return false;
  if (staticToken) {
    const a = Buffer.from(provided);
    const b = Buffer.from(staticToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  const payload = verifyJwt(provided);
  return Boolean(payload && payload.typ === 'access');
}

export function accessGrantName(token: string): string | undefined {
  const payload = verifyJwt(token);
  if (!payload || payload.typ !== 'access') return undefined;
  return typeof payload.gname === 'string' && payload.gname.trim() ? payload.gname.trim() : undefined;
}

export function isJwtAccessToken(token: string): boolean {
  const payload = verifyJwt(token);
  return Boolean(payload && payload.typ === 'access');
}

export async function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (
    method === 'GET' &&
    (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')
  ) {
    json(res, 200, authorizationServerMetadata());
    return;
  }

  if (
    method === 'GET' &&
    (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')
  ) {
    json(res, 200, protectedResourceMetadata());
    return;
  }

  if (path === '/oauth/register' && method === 'POST') {
    await registerPost(req, res);
    return;
  }

  if (path === '/oauth/authorize') {
    if (method === 'GET') {
      authorizeGet(url, res);
      return;
    }
    if (method === 'POST') {
      await authorizePost(req, res);
      return;
    }
  }

  if (path === '/oauth/token' && method === 'POST') {
    await tokenPost(req, res);
    return;
  }

  json(res, 404, { error: 'Not found' });
}
