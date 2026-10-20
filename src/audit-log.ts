import { activeGrant } from './session-grant.js';

/** Alias shape only. An email, file id, or other argument must not qualify. */
const ALIAS_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Policy refusals. An API failure after the call was allowed is an error class. */
const DENIED_SLUGS = new Set([
  'write_disabled',
  'account_outside_grant',
  'grant_required',
  'grant_unknown',
  'hosted_set_grant_refused',
]);

const ACCOUNT_KEYS = ['account', 'fromAccount', 'toAccount'] as const;

export interface AuditRecord {
  grant: string | null;
  accounts: string[];
  tool: string;
  outcome: string;
  timestamp: string;
}

/** Aliases named by the call. Drops anything that is not an alias or `*`. */
export function auditAccounts(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const rec = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ACCOUNT_KEYS) {
    const value = rec[key];
    if (typeof value !== 'string') continue;
    for (const part of value.split(',')) {
      const alias = part.trim();
      if (alias === '*' || ALIAS_RE.test(alias)) out.push(alias);
    }
  }
  return [...new Set(out)];
}

function textOf(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : undefined;
}

function slugOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === 'string' && SLUG_RE.test(parsed.error) ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** `allowed`, `denied:<slug>`, or `error:<class>`. Never the message text. */
export function outcomeOf(result: unknown): string {
  const isError = Boolean(result && typeof result === 'object' && (result as { isError?: boolean }).isError === true);
  if (!isError) return 'allowed';
  const slug = slugOf(textOf(result));
  if (!slug) return 'error:unclassified';
  return DENIED_SLUGS.has(slug) ? `denied:${slug}` : `error:${slug}`;
}

export function errorClass(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string') {
    const name = (err as { name: string }).name;
    if (SLUG_RE.test(name)) return name;
  }
  return 'Error';
}

export function auditRecord(tool: string, args: unknown, outcome: string, now = new Date()): AuditRecord {
  const name = activeGrant()?.name?.trim() || null;
  return {
    grant: name,
    accounts: auditAccounts(args),
    tool,
    outcome,
    timestamp: now.toISOString(),
  };
}

function emit(record: AuditRecord): void {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/** One stderr line per hosted tools/call. Re-throws after logging a thrown error. */
export async function auditToolCall(tool: string, args: unknown, run: () => unknown): Promise<unknown> {
  try {
    const result = await run();
    emit(auditRecord(tool, args, outcomeOf(result)));
    return result;
  } catch (err) {
    emit(auditRecord(tool, args, `error:${errorClass(err)}`));
    throw err;
  }
}
