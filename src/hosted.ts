import * as path from 'node:path';
/**
 * Hosted MCP (Cloud Run / public HTTPS) vs desk-local provider minting.
 *
 * Three layers (keep them named and separate — see docs/hosted-mcp.md):
 *   1. Provider credentials — Google aliases minted on a desk, encrypted token store.
 *   2. MCP HTTP token — gate for POST /mcp; Grok OAuth wraps THIS token only.
 *   3. Session grant — slices which aliases from (1) this brain may use.
 *
 * Cloud Run must never open a browser or bind desk-only ports (8000/8787/4242).
 * Layer 1 is never collected on the Grok authorize page.
 */
export const DEFAULT_PUBLIC_MCP_HOST = 'google-multi-mcp-tdhsljvruq-uc.a.run.app';
export const EXTRA_PUBLIC_HOSTS = ['google-multi-mcp-794931160113.us-central1.run.app'];
export const GROK_REDIRECT = 'https://grok.com/connectors-oauth-exchange-code/';
export const DEFAULT_OAUTH_CLIENT_ID = 'grok';

/** Desk-only ports: local MCP proxies / Grok retry / Google loopback callback. */
export const DESK_ONLY_PORTS = [8000, 8787, 4242] as const;

export function csvEnvList(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[name] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function publicMcpHost(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MCP_PUBLIC_HOST || DEFAULT_PUBLIC_MCP_HOST).trim();
}

/** Canonical issuer origin. Hosted is always https; loopback may be http. */
export function issuer(env: NodeJS.ProcessEnv = process.env): string {
  const host = publicMcpHost(env);
  if (host.startsWith('http://') || host.startsWith('https://')) return host.replace(/\/+$/, '');
  const hostname = host.split(':')[0];
  const scheme =
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' ? 'http' : 'https';
  return `${scheme}://${host}`;
}

export function resourceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${issuer(env)}/mcp`;
}

/**
 * Cloud Run sets K_SERVICE. MCP_HOSTED=1 forces hosted; MCP_HOSTED=0 forces desk.
 */
export function isHostedHttp(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.MCP_HOSTED || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on') return true;
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return false;
  return Boolean((env.K_SERVICE || '').trim());
}

export function deskMintMessage(alias: string, email?: string): string {
  const who = email ? `"${alias}" (${email})` : `"${alias}"`;
  return (
    `No Google token for account ${who}. Hosted MCP cannot open a browser or bind ` +
    `localhost:8000/8787/4242. Mint provider credentials on a desk with ` +
    `npx mcp-google-multi auth --account ${alias}, then mount the encrypted *.enc ` +
    `files (TOKEN_STORE_PATH / Cloud Run secrets). This is layer 1 (provider credentials), ` +
    `not Grok connector OAuth. See docs/hosted-mcp.md.`
  );
}

export function deskMintError(alias: string, email?: string): Error {
  return new Error(deskMintMessage(alias, email));
}

/** Refuse desk-only ports on Cloud Run. Cloud Run should use $PORT (8080). */
export function assertHostedListenPort(port: number, env: NodeJS.ProcessEnv = process.env): void {
  if (!isHostedHttp(env)) return;
  if ((DESK_ONLY_PORTS as readonly number[]).includes(port)) {
    throw new Error(
      `Hosted MCP must not bind port ${port} (desk-only 8000/8787/4242). ` +
        'Set PORT to the platform port (Cloud Run: 8080). See docs/hosted-mcp.md.',
    );
  }
}

/** Payload shape returned by download tools on hosted MCP (no desk filesystem). */
export type HostedBytesPayload = {
  filename: string;
  mimeType: string;
  size: number;
  encoding: 'base64';
  data: string;
  note?: string;
};

/**
 * Build the MCP JSON payload for a file download on hosted Cloud Run.
 * savePath is ignored when provided — desk filesystem is not available to agents.
 */
export function hostedBytesPayload(opts: {
  filename: string;
  mimeType: string;
  data: Buffer;
  savePathProvided?: boolean;
}): HostedBytesPayload {
  // Basename only — never echo a caller path component into the result.
  const filename = path.basename(opts.filename);
  const payload: HostedBytesPayload = {
    filename,
    mimeType: opts.mimeType || 'application/octet-stream',
    size: opts.data.length,
    encoding: 'base64',
    data: opts.data.toString('base64'),
  };
  if (opts.savePathProvided) {
    payload.note = 'savePath is not applicable on hosted MCP; file bytes returned in data';
  }
  return payload;
}

/** Wrap a JSON-serializable value as an MCP text content result. */
export function mcpJsonResult(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

/** Desk/stdio requires savePath; hosted returns bytes instead. */
export function deskSavePathRequiredMessage(): string {
  return (
    'savePath is required on desk/stdio MCP (local filesystem). ' +
    'On hosted Cloud Run, omit savePath — the tool returns base64 bytes in the result.'
  );
}

/** Hosted upload cannot use desk localPath — callers must send base64 bytes. */
export function hostedUploadRequiresBase64Message(localPathProvided = false): string {
  const pathNote = localPathProvided
    ? 'localPath was provided but is not readable on Cloud Run. '
    : '';
  return (
    pathNote +
    'Hosted Cloud Run cannot see laptop/box filesystem paths. ' +
    'Pass contentBase64 (standard base64 file bytes) plus filename. ' +
    'Desk/stdio still uses localPath.'
  );
}

/** @deprecated Prefer hostedUploadRequiresBase64Message */
export const hostedUploadNeedsBase64Message = hostedUploadRequiresBase64Message;

/** Desk/stdio upload requires localPath when contentBase64 is omitted. */
export function deskUploadNeedsLocalPathMessage(): string {
  return (
    'localPath is required on desk/stdio MCP (local filesystem). ' +
    'On hosted Cloud Run, pass contentBase64 instead of localPath.'
  );
}

/**
 * Decode standard base64 file bytes for hosted (and optional desk) uploads.
 * Rejects empty / whitespace-only and non-base64 alphabet input.
 */
export function decodeContentBase64(s: string): Buffer {
  const trimmed = (s || '').trim();
  if (!trimmed) {
    throw new Error(
      'contentBase64 is empty. Pass standard base64 of the file contents.',
    );
  }
  const compact = trimmed.replace(/\s+/g, '');
  // Allow standard and URL-safe alphabet with optional padding.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
    throw new Error(
      'contentBase64 is not valid base64. Pass standard base64 of the file contents.',
    );
  }
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length === 0) {
    throw new Error(
      'contentBase64 decoded to empty bytes. Pass standard base64 of the file contents.',
    );
  }
  return buffer;
}

