/**
 * Session-scoped account grants (My Flow–style).
 *
 * Host-local grants.json maps opaque codes → allowed Google account aliases.
 * This is layer 3 (session grant): a slice of already-minted layer-1 aliases.
 * It is not Google login and not the MCP HTTP token.
 *
 * Hosted HTTP restores the slice from the Grok access JWT (`gname`) via
 * AsyncLocalStorage so Cloud Run replicas need no sticky sessions.
 * Stdio still uses in-process set_grant. A static MCP bearer does not:
 * it is wrapped in runWithGrant of MCP_HTTP_TOKEN_GRANT (unset = null).
 * On hosted, a request has only that ALS grant or null.
 * Codes never appear in repo examples as real values.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getAccountSet } from './accounts.js';
import { isHostedHttp } from './hosted.js';

export interface GrantRecord {
  /** Human name aligned with OS / My Flow recipes (e.g. "StrombackBrain2"). */
  name: string;
  /** Secret code; may match a My Flow grant code so one operator secret unlocks both. */
  code: string;
  /** Account aliases from GOOGLE_ACCOUNTS this grant may use. */
  accounts: string[];
  /**
   * Optional ISO-8601 cutoff. Tokens whose iat is earlier are refused.
   * Revokes one grant without rotating the JWT signing key.
   */
  notBefore?: string;
}

export interface GrantsFile {
  version: 1;
  grants: GrantRecord[];
}

export interface SessionGrantState {
  code: string;
  name: string;
  accounts: string[];
  label?: string;
  /** How this slice was activated. `token` = HMAC access JWT (multi-instance). */
  source?: 'session' | 'env' | 'token';
}

let session: SessionGrantState | null = null;
let cachedFile: GrantsFile | null | undefined;

/** Request-scoped grant for hosted HTTP (one Cloud Run replica, many concurrent chats). */
const als = new AsyncLocalStorage<{ grant: SessionGrantState | null }>();

export function runWithGrant<T>(grant: SessionGrantState | null, fn: () => T): T {
  return als.run({ grant }, fn);
}

export function getGrantsPath(): string {
  if (process.env.GOOGLE_GRANTS_PATH?.trim()) {
    return path.resolve(process.env.GOOGLE_GRANTS_PATH.trim());
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'mcp-google-multi', 'grants.json');
}

/** Load grants file; null if missing. Throws if present but invalid. */
export function loadGrantsFile(force = false): GrantsFile | null {
  if (!force && cachedFile !== undefined) return cachedFile;
  const filePath = getGrantsPath();
  if (!existsSync(filePath)) {
    cachedFile = null;
    return null;
  }
  const raw = readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw) as GrantsFile;
  if (data.version !== 1 || !Array.isArray(data.grants)) {
    throw new Error(`Invalid grants file at ${filePath}: expected version 1 and grants[]`);
  }
  for (const g of data.grants) {
    if (!g?.name || !g?.code || !Array.isArray(g.accounts)) {
      throw new Error(`Invalid grant entry in ${filePath}: need name, code, accounts[]`);
    }
    assertGrantSecret(g);
  }
  cachedFile = data;
  return data;
}

/** Reset file cache (tests). */
export function resetGrantsFileCache(): void {
  cachedFile = undefined;
}

/**
 * Enforcement when:
 * - GOOGLE_GRANTS_ENFORCE=true, or
 * - grants file exists with ≥1 grant (and enforce not explicitly false)
 */
export function isGrantEnforced(): boolean {
  const flag = (process.env.GOOGLE_GRANTS_ENFORCE || '').trim().toLowerCase();
  // Hosted still loads, so a refused file cannot open every alias when enforce is off.
  if (isHostedHttp()) loadGrantsFile();
  if (flag === 'false' || flag === '0' || flag === 'off' || flag === 'no') return false;
  if (flag === 'true' || flag === '1' || flag === 'on' || flag === 'yes') return true;
  const file = loadGrantsFile();
  return Boolean(file && file.grants.length > 0);
}

export function getSessionGrant(): SessionGrantState | null {
  const store = als.getStore();
  if (store) return store.grant;
  return session;
}

export function clearSessionGrant(): void {
  const store = als.getStore();
  if (store) {
    store.grant = null;
    return;
  }
  session = null;
}

/** Live registry, not the import-time `ACCOUNTS` snapshot: a grant names aliases that exist now. */
function configuredAliases(): readonly string[] {
  return getAccountSet().aliases;
}

function accountsForRecord(rec: GrantRecord): string[] {
  const known = new Set(configuredAliases());
  return rec.accounts.map((a) => a.trim()).filter((a) => a && known.has(a));
}

/**
 * A code shorter than 24 characters, or equal to the grant name ignoring case,
 * is refused. The message names the grant only.
 */
function assertGrantSecret(g: GrantRecord): void {
  const name = String(g.name).trim();
  const code = String(g.code).trim();
  if (code.length < 24 || code.toLowerCase() === name.toLowerCase()) {
    throw new Error(
      `Grant "${name}" is refused. Its code must be at least 24 characters and must not equal the grant name.`,
    );
  }
}

/** SHA-256 then timingSafeEqual so unequal lengths still compare in constant time. */
function secretEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Lookup by secret code. Does not activate. Used by OAuth authorize (layer 3). */
export function resolveGrantByCode(code: string): GrantRecord | null {
  const file = loadGrantsFile(true);
  if (!file) return null;
  const c = code.trim();
  if (!c) return null;
  let found: GrantRecord | null = null;
  for (const g of file.grants) {
    if (secretEquals(c, g.code) && !found) found = g;
  }
  return found;
}

/** Name lookup. Re-reads grants.json so a removal applies without a restart. */
export function grantRecordByName(name: string): GrantRecord | null {
  const file = loadGrantsFile(true);
  if (!file) return null;
  const n = name.trim();
  if (!n) return null;
  return file.grants.find((g) => g.name === n) ?? null;
}

/**
 * True when notBefore cuts this token off. Unparseable notBefore fails closed.
 * iat equal to notBefore is still valid.
 */
export function tokenPredatesGrant(iatSec: number, rec: GrantRecord): boolean {
  if (rec.notBefore == null || rec.notBefore === '') return false;
  if (typeof rec.notBefore !== 'string' || !Number.isFinite(iatSec)) return true;
  const ms = Date.parse(rec.notBefore);
  if (!Number.isFinite(ms)) return true;
  return iatSec * 1000 < ms;
}

/**
 * Restore a slice from an access-token grant *name* (never the code).
 * Re-reads grants.json so a removal applies without a restart.
 * Fail closed (null) if the name is unknown or has no matching aliases.
 */
export function resolveGrantByName(name: string): SessionGrantState | null {
  const file = loadGrantsFile(true);
  if (!file) return null;
  const n = name.trim();
  if (!n) return null;
  const rec = file.grants.find((g) => g.name === n);
  if (!rec) return null;
  const accounts = accountsForRecord(rec);
  if (accounts.length === 0) return null;
  return { code: '', name: rec.name, accounts, label: 'token', source: 'token' };
}

/**
 * Named grant for a static MCP_HTTP_TOKEN / MCP_API_KEY bearer.
 * Unset, blank, or unknown → null (fail closed). Resolved on every call.
 * Never the in-process set_grant session and never GOOGLE_GRANT_CODE.
 */
export function staticBearerGrant(env: NodeJS.ProcessEnv = process.env): SessionGrantState | null {
  const name = (env.MCP_HTTP_TOKEN_GRANT || '').trim();
  if (!name) return null;
  return resolveGrantByName(name);
}

/**
 * HTTP-gate reason when a layer-2 access JWT must carry a resolvable layer-3 `gname`.
 * See docs/internals.md (session grants). Static Bearer is not this path:
 * it enters runWithGrant(staticBearerGrant()) instead of this 403.
 */
export function jwtAccessGrantGate(
  grantName: string | undefined,
  resolved: SessionGrantState | null,
): { error: 'grant_required' | 'grant_unknown'; message: string } | null {
  if (!isGrantEnforced()) return null;
  if (!grantName) {
    return {
      error: 'grant_required',
      message:
        'Access JWT is missing session grant name (gname). Re-authorize at /oauth/authorize with the session grant code. In-process set_grant does not survive Cloud Run replicas. Codes never go in the JWT.',
    };
  }
  if (!resolved) {
    return {
      error: 'grant_unknown',
      message:
        'Access JWT grant name is not in host-local grants.json (or has no matching aliases). Re-authorize at /oauth/authorize with a current session grant code.',
    };
  }
  return null;
}

/** Hosted Cloud Run must not treat in-process set_grant as durable. See docs/internals.md. */
export function hostedSetGrantRefusal(): string | null {
  if (!isHostedHttp()) return null;
  return (
    'In-process set_grant does not survive Cloud Run replicas. ' +
    'Bind the session grant on /oauth/authorize so the access JWT carries the grant name (gname). ' +
    'Codes never go in the JWT.'
  );
}

function findGrantByCode(code: string): GrantRecord | null {
  return resolveGrantByCode(code);
}

function persistGrant(state: SessionGrantState): SessionGrantState {
  const store = als.getStore();
  if (store) {
    store.grant = state;
    return state;
  }
  session = state;
  return session;
}

/**
 * Activate a grant. Returns resolved state or throws with a safe message (no codes).
 */
export function setSessionGrant(code: string, label?: string): SessionGrantState {
  const trimmed = (code || '').trim();
  if (!trimmed) throw new Error('grant_code is required');

  const file = loadGrantsFile(true);
  if (!file || file.grants.length === 0) {
    throw new Error(
      `No grants configured. Create ${getGrantsPath()} (see grants.example.json) ` +
        'or set GOOGLE_GRANTS_PATH.',
    );
  }

  const rec = findGrantByCode(trimmed);
  if (!rec) {
    throw new Error(
      'Grant code not recognized. Check the host-local grants file (name only in docs; codes stay local).',
    );
  }

  const known = new Set(configuredAliases());
  const accounts = rec.accounts
    .map((a) => a.trim())
    .filter((a) => a && known.has(a));

  if (accounts.length === 0) {
    throw new Error(
      `Grant "${rec.name}" has no accounts that match the configured registry ` +
        `(configured: ${configuredAliases().join(', ')}).`,
    );
  }

  return persistGrant({
    code: trimmed,
    name: rec.name,
    accounts,
    label: (label || '').trim() || undefined,
    source: 'session',
  });
}

/** Desk/stdio GOOGLE_GRANT_CODE. Hosted ignores it and stays grantless. */
export function grantFromEnvFallback(): SessionGrantState | null {
  if (isHostedHttp()) return null;
  const code = (process.env.GOOGLE_GRANT_CODE || '').trim();
  if (!code) return null;
  try {
    // Do not leave session set from env on every call — resolve without mutating unless desired.
    // For status / allow checks we resolve ephemerally.
    const file = loadGrantsFile();
    if (!file) return null;
    let rec: GrantRecord | null = null;
    for (const g of file.grants) {
      if (secretEquals(code, g.code) && !rec) rec = g;
    }
    if (!rec) return null;
    const known = new Set(configuredAliases());
    const accounts = rec.accounts.map((a) => a.trim()).filter((a) => known.has(a));
    if (accounts.length === 0) return null;
    return { code, name: rec.name, accounts, label: 'env', source: 'env' };
  } catch {
    return null;
  }
}

export function activeGrant(): SessionGrantState | null {
  const store = als.getStore();
  if (store) return store.grant;
  // Hosted has no sticky session. A request's grant is only the ALS value
  // set at the HTTP entry (JWT gname or MCP_HTTP_TOKEN_GRANT). No module
  // set_grant and no GOOGLE_GRANT_CODE.
  if (isHostedHttp()) return null;
  return session ?? grantFromEnvFallback();
}

/**
 * Aliases the current session may use.
 * When enforcement is off, returns all configured accounts.
 * When enforcement is on and no grant → throws.
 */
export function allowedAccounts(): string[] {
  if (!isGrantEnforced()) return [...configuredAliases()];
  const g = activeGrant();
  if (!g) {
    throw new Error(
      'No session grant. Fail-closed: without a grant, no accounts are visible. ' +
        'Hosted Grok: enter the session grant code on /oauth/authorize (bound into the access token). ' +
        'CLI/stdio: call set_grant(grant_code=..., label=...).',
    );
  }
  return [...g.accounts];
}

export function assertAccountAllowed(alias: string): void {
  if (!isGrantEnforced()) return;
  const allowed = allowedAccounts();
  if (!allowed.includes(alias)) {
    throw new Error(
      `Account "${alias}" is outside this session grant. Allowed: ${allowed.join(', ')}.`,
    );
  }
}

const ACCOUNT_ARG_KEYS = ['account', 'fromAccount', 'toAccount'] as const;

function grantBlockResult(message: string, account?: string) {
  const error = message.includes('outside this session grant') ? 'account_outside_grant' : 'grant_required';
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error,
          message,
          retriable: false,
          ...(account ? { account } : {}),
        }),
      },
    ],
    isError: true as const,
  };
}

/**
 * Refusal for one alias (or a CSV of aliases) before any client is built.
 * `*` is a fan-out selector and is resolved against allowedAccounts() there.
 * Returns null when the call may proceed.
 */
export function refusedAccountResult(alias: unknown) {
  if (typeof alias !== 'string' || alias === '' || alias === '*') return null;
  const tokens = alias.includes(',') ? alias.split(',').map((t) => t.trim()).filter(Boolean) : [alias];
  for (const token of tokens) {
    if (token === '*') continue;
    try {
      assertAccountAllowed(token);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return grantBlockResult(message, token);
    }
  }
  return null;
}

/** Every account-shaped argument on a tool call, checked before the handler runs. */
export function grantRefusalForCallArgs(args: unknown) {
  if (!args || typeof args !== 'object') return null;
  const rec = args as Record<string, unknown>;
  for (const key of ACCOUNT_ARG_KEYS) {
    const refused = refusedAccountResult(rec[key]);
    if (refused) return refused;
  }
  return null;
}

/** Configured default, or null when it is unset or outside the session grant. */
export function usableDefaultAlias(def: string | undefined): string | null | 'missing_grant' {
  if (!isGrantEnforced()) return def ?? null;
  try {
    const allowed = allowedAccounts();
    if (def && allowed.includes(def)) return def;
    return null;
  } catch {
    return 'missing_grant';
  }
}

/** Aliases a no-default hint may name. Out-of-grant aliases are omitted. */
export function aliasesForHint(aliases: readonly string[]): string[] | 'missing_grant' {
  if (!isGrantEnforced()) return [...aliases];
  try {
    const allowed = new Set(allowedAccounts());
    return aliases.filter((alias) => allowed.has(alias));
  } catch {
    return 'missing_grant';
  }
}

/** Aliases a session-facing listing may name. Unenforced: the configured list.
 * Enforced with a grant: the intersection. Enforced with no grant: none. */
export function aliasesVisibleToSession(configured: readonly string[]): string[] {
  if (!isGrantEnforced()) return [...configured];
  try {
    const allowed = new Set(allowedAccounts());
    return configured.filter((alias) => allowed.has(alias));
  } catch {
    return [];
  }
}

export function missingGrantResult() {
  let message = 'No session grant. Fail-closed: without a grant, no accounts are visible.';
  try {
    allowedAccounts();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  return grantBlockResult(message);
}

/** First 8 hex chars of SHA-256. Not a prefix of the code, at any length. */
export function codeSha8(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 8);
}

export function grantStatusSummary(): {
  enforced: boolean;
  authenticated: boolean;
  source: 'session' | 'env' | 'token' | null;
  name: string | null;
  label: string | null;
  code_sha8: string | null;
  accounts: string[];
  grants_path: string;
  grants_configured: number;
} {
  const file = loadGrantsFile();
  const enforced = isGrantEnforced();
  const g = activeGrant();
  const code = g?.code;
  const source: 'session' | 'env' | 'token' | null =
    g?.source === 'token' ? 'token' : g?.source === 'env' ? 'env' : g ? 'session' : null;
  return {
    enforced,
    authenticated: Boolean(g),
    source,
    name: g?.name ?? null,
    label: g?.label ?? null,
    code_sha8: code ? codeSha8(code) : null,
    accounts: g?.accounts ?? [],
    grants_path: getGrantsPath(),
    grants_configured: file?.grants.length ?? 0,
  };
}
