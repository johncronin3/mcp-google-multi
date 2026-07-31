/**
 * Session-scoped account grants (My Flow–style).
 *
 * Host-local grants.json maps opaque codes → allowed Google account aliases.
 * Agents call set_grant at session start; without a grant (when enforcement is
 * on), data tools refuse. Codes never appear in repo examples as real values.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ACCOUNTS } from './accounts.js';

export interface GrantRecord {
  /** Human name aligned with OS / My Flow recipes (e.g. "StrombackBrain2"). */
  name: string;
  /** Secret code; may match a My Flow grant code so one operator secret unlocks both. */
  code: string;
  /** Account aliases from GOOGLE_ACCOUNTS this grant may use. */
  accounts: string[];
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
}

let session: SessionGrantState | null = null;
let cachedFile: GrantsFile | null | undefined;

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
  if (flag === 'false' || flag === '0' || flag === 'off' || flag === 'no') return false;
  if (flag === 'true' || flag === '1' || flag === 'on' || flag === 'yes') return true;
  const file = loadGrantsFile();
  return Boolean(file && file.grants.length > 0);
}

export function getSessionGrant(): SessionGrantState | null {
  return session;
}

export function clearSessionGrant(): void {
  session = null;
}

function findGrantByCode(code: string): GrantRecord | null {
  const file = loadGrantsFile(true);
  if (!file) return null;
  const c = code.trim();
  return file.grants.find((g) => g.code === c) ?? null;
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

  const known = new Set(ACCOUNTS);
  const accounts = rec.accounts
    .map((a) => a.trim())
    .filter((a) => a && known.has(a));

  if (accounts.length === 0) {
    throw new Error(
      `Grant "${rec.name}" has no accounts that match GOOGLE_ACCOUNTS ` +
        `(configured: ${ACCOUNTS.join(', ')}).`,
    );
  }

  session = {
    code: trimmed,
    name: rec.name,
    accounts,
    label: (label || '').trim() || undefined,
  };
  return session;
}

/** Env fallback GOOGLE_GRANT_CODE (legacy process-wide); session wins. */
export function grantFromEnvFallback(): SessionGrantState | null {
  const code = (process.env.GOOGLE_GRANT_CODE || '').trim();
  if (!code) return null;
  try {
    // Do not leave session set from env on every call — resolve without mutating unless desired.
    // For status / allow checks we resolve ephemerally.
    const file = loadGrantsFile();
    if (!file) return null;
    const rec = file.grants.find((g) => g.code === code);
    if (!rec) return null;
    const known = new Set(ACCOUNTS);
    const accounts = rec.accounts.map((a) => a.trim()).filter((a) => known.has(a));
    if (accounts.length === 0) return null;
    return { code, name: rec.name, accounts, label: 'env' };
  } catch {
    return null;
  }
}

export function activeGrant(): SessionGrantState | null {
  return session ?? grantFromEnvFallback();
}

/**
 * Aliases the current session may use.
 * When enforcement is off, returns all configured accounts.
 * When enforcement is on and no grant → throws.
 */
export function allowedAccounts(): string[] {
  if (!isGrantEnforced()) return [...ACCOUNTS];
  const g = activeGrant();
  if (!g) {
    throw new Error(
      'No session grant. Call set_grant(grant_code=..., label=...) before Google tools. ' +
        'Fail-closed: without a grant, no accounts are visible.',
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

export function grantStatusSummary(): {
  enforced: boolean;
  authenticated: boolean;
  source: 'session' | 'env' | null;
  name: string | null;
  label: string | null;
  code_prefix: string | null;
  accounts: string[];
  grants_path: string;
  grants_configured: number;
} {
  const file = loadGrantsFile();
  const enforced = isGrantEnforced();
  const sess = session;
  const envG = !sess ? grantFromEnvFallback() : null;
  const g = sess ?? envG;
  const code = g?.code;
  return {
    enforced,
    authenticated: Boolean(g),
    source: sess ? 'session' : envG ? 'env' : null,
    name: g?.name ?? null,
    label: g?.label ?? null,
    code_prefix: code ? (code.length > 12 ? `${code.slice(0, 12)}…` : code) : null,
    accounts: g?.accounts ?? [],
    grants_path: getGrantsPath(),
    grants_configured: file?.grants.length ?? 0,
  };
}
