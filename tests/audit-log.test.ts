import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { invalidateAccountSet } from '../src/accounts.js';
import { auditAccounts, auditToolCall, outcomeOf, type AuditRecord } from '../src/audit-log.js';
import { buildRegistry } from '../src/compose.js';
import { buildIdentityContext } from '../src/identity.js';
import { clearSessionGrant, runWithGrant, type SessionGrantState } from '../src/session-grant.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const CODE = 'GRANT-CODE-CANARY-9f3a';
const BODY = 'BODY-CANARY hello there';
const SUBJECT = 'SUBJECT-CANARY weekly';
const TO = 'recipient-canary@example.com';
const CC = 'cc-canary@example.com';
const HTML = '<b>HTML-CANARY</b>';
const TOKEN = 'ya29.CANARYTOKEN';
const SHARE_EMAIL = 'share-canary@example.com';
const SHARE_MESSAGE = 'message-canary please open';
const FILE_ID = 'fileid-canary-1AB';
const DELETE_ID = 'delete-fileid-canary';
const DOMAIN = 'domain-canary.example';
const ACCOUNT_EMAIL = 'stromback-canary@example.com';
const GRANT_NAME = 'StrombackBrain2';

const CANARIES = [CODE, BODY, SUBJECT, TO, CC, HTML, TOKEN, SHARE_EMAIL, SHARE_MESSAGE, FILE_ID, DELETE_ID, DOMAIN, ACCOUNT_EMAIL];

const ENV_KEYS = [
  'MCP_HOSTED',
  'K_SERVICE',
  'GOOGLE_PROFILE',
  'GOOGLE_WRITE_DENY',
  'GOOGLE_WRITE_ALLOW',
  'GOOGLE_READ_ONLY',
  'GOOGLE_ACCOUNTS',
] as const;

function captureHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers[name] = handler;
      return 'ok';
    },
    sendToolListChanged: () => {},
    server: { setRequestHandler: () => {}, getClientCapabilities: () => undefined },
  } as unknown as McpServer;
  const ctx = buildIdentityContext(process.env, { transport: 'http' });
  buildRegistry(server, ctx, 'curated');
  return handlers;
}

function parseAudit(text: string): AuditRecord[] {
  const records: AuditRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      records.push(JSON.parse(line) as AuditRecord);
    } catch {
      // stderr also carries non-audit lines
    }
  }
  return records;
}

describe('hosted tools/call audit log', () => {
  const saved: Record<string, string | undefined> = {};
  let armed = false;

  afterEach(() => {
    clearSessionGrant();
    if (!armed) return;
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    invalidateAccountSet();
    armed = false;
  });

  it('logs grant, aliases, tool, and outcome for send, share, and a denial, and nothing else', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    armed = true;
    process.env.MCP_HOSTED = '1';
    process.env.K_SERVICE = 'google-multi-mcp';
    process.env.GOOGLE_PROFILE = 'full-writes';
    process.env.GOOGLE_WRITE_DENY = 'drive:delete';
    delete process.env.GOOGLE_WRITE_ALLOW;
    delete process.env.GOOGLE_READ_ONLY;
    process.env.GOOGLE_ACCOUNTS = `stromback:${ACCOUNT_EMAIL}`;
    invalidateAccountSet();

    const handlers = captureHandlers();
    const grant: SessionGrantState = {
      code: CODE,
      name: GRANT_NAME,
      accounts: ['stromback'],
      source: 'token',
    };
    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const call = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch {
          // A thrown handler is logged as error:<class> and rethrown.
        }
      };
      await runWithGrant(grant, async () => {
        await call(() => handlers.gmail_send({
          account: 'stromback',
          to: TO,
          cc: CC,
          subject: SUBJECT,
          body: `${BODY}\n${TOKEN}`,
          htmlBody: HTML,
        }));
        await call(() => handlers.drive_share({
          account: 'stromback',
          fileId: FILE_ID,
          type: 'user',
          role: 'reader',
          emailAddress: SHARE_EMAIL,
          emailMessage: SHARE_MESSAGE,
          domain: DOMAIN,
        }));
        await call(() => handlers.drive_delete({ account: 'stromback', fileId: DELETE_ID }));
      });
    } finally {
      process.stderr.write = write;
    }

    const logs = parseAudit(chunks.join(''));
    const byTool = new Map(logs.map((row) => [row.tool, row]));
    expect([...byTool.keys()].sort()).toEqual(['drive_delete', 'drive_share', 'gmail_send']);

    for (const tool of ['gmail_send', 'drive_share', 'drive_delete']) {
      const row = byTool.get(tool);
      expect(row, tool).toBeTruthy();
      expect(Object.keys(row as object), tool).toEqual(['grant', 'accounts', 'tool', 'outcome', 'timestamp']);
      expect(row?.grant, tool).toBe(GRANT_NAME);
      expect(row?.accounts, tool).toEqual(['stromback']);
      expect(row?.tool, tool).toBe(tool);
      expect(Number.isNaN(Date.parse(row?.timestamp ?? '')), tool).toBe(false);
    }
    expect(byTool.get('gmail_send')?.outcome).toMatch(/^error:[A-Za-z][A-Za-z0-9_]*$/);
    expect(byTool.get('drive_share')?.outcome).toMatch(/^error:[A-Za-z][A-Za-z0-9_]*$/);
    expect(byTool.get('drive_delete')?.outcome).toBe('denied:write_disabled');

    const flat = JSON.stringify(logs);
    for (const secret of CANARIES) {
      expect(flat, secret).not.toContain(secret);
    }
  });

  it('keeps an allowed call to the same five fields', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    armed = true;
    process.env.GOOGLE_ACCOUNTS = 'stromback:stromback@example.com,personal:personal@example.com';
    invalidateAccountSet();
    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      await auditToolCall('gmail_search', {
        account: 'stromback, share-canary@example.com',
        fromAccount: 'personal',
        q: BODY,
        token: TOKEN,
      }, () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, body: BODY }) }] }));
    } finally {
      process.stderr.write = write;
    }
    const [row] = parseAudit(chunks.join(''));
    expect(Object.keys(row)).toEqual(['grant', 'accounts', 'tool', 'outcome', 'timestamp']);
    expect(row.outcome).toBe('allowed');
    expect(row.accounts).toEqual(['stromback', 'personal']);
    expect(row.grant).toBeNull();
    expect(JSON.stringify(row)).not.toContain(BODY);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain('share-canary@example.com');
  });

  it('classifies denial slugs without reading the message', () => {
    expect(auditAccounts({ account: '*', fileId: FILE_ID, body: BODY })).toEqual(['*']);
    expect(outcomeOf({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'write_disabled', message: BODY, hint: TOKEN }) }],
    })).toBe('denied:write_disabled');
    expect(outcomeOf({
      isError: true,
      content: [{ type: 'text', text: `not json ${BODY}` }],
    })).toBe('error:unclassified');
    const unknown = 'pasted_error_class_canary';
    expect(outcomeOf({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: unknown, message: BODY }) }],
    })).toBe('error:unclassified');
    expect(outcomeOf({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'auth_required', message: BODY }) }],
    })).toBe('error:auth_required');
  });

  it('replaces a pasted code in account fields with sha8', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    armed = true;
    process.env.GOOGLE_ACCOUNTS = `stromback:${ACCOUNT_EMAIL}`;
    invalidateAccountSet();
    const pasted = 'pasted-grant-code-canary';
    const digest = createHash('sha256').update(pasted, 'utf8').digest('hex').slice(0, 8);
    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      await auditToolCall('drive_transfer', {
        account: pasted,
        fromAccount: pasted,
        toAccount: `stromback,${pasted}`,
        fileId: FILE_ID,
      }, () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] }));
    } finally {
      process.stderr.write = write;
    }
    const flat = chunks.join('');
    const [row] = parseAudit(flat);
    expect(row.accounts).toEqual([digest, 'stromback']);
    expect(flat).not.toContain(pasted);
    expect(flat).not.toContain(FILE_ID);
  });

  it('returns the tool result when the audit write fails', async () => {
    const payload = { ok: true, body: BODY };
    let runs = 0;
    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    let failed = false;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (!failed) {
        failed = true;
        throw new Error(BODY);
      }
      chunks.push(text);
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await auditToolCall('gmail_search', { account: 'stromback', q: BODY }, () => {
        runs += 1;
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
      });
      expect(runs).toBe(1);
      expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
    } finally {
      process.stderr.write = write;
    }
    expect(chunks).toEqual(['audit log write failed\n']);
    expect(chunks.join('')).not.toContain(BODY);
  });
});
