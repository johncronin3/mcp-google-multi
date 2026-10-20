import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { accountSet, fakeServer, parseResult, type ToolResult } from './_tool-harness.js';
import { ToolRegistry } from '../src/registry.js';
import { registerDriveTools } from '../src/tools/drive.js';
import { registerGmailTools } from '../src/tools/gmail.js';
import { registerEscapeTools } from '../src/tools/google-api.js';
import { registerAccountTools } from '../src/tools/accounts-tool.js';
import { registerAccountWizardTools, setWizardHttpConsent } from '../src/tools/account-wizard.js';
import { registerDiscoverTools } from '../src/discover.js';
import { registerGrantTools } from '../src/tools/grant-tools.js';
import { registerDiagnoseTool } from '../src/doctor.js';
import { runWithGrant, type SessionGrantState } from '../src/session-grant.js';
import type { Policy } from '../src/write-control.js';

const OUTSIDERS = ['personal', 'opcenter', 'buildcoin', 'usa-house', 'olga'] as const;
const EVERY_ALIAS = ['stromback', ...OUTSIDERS] as const;

function callsFor(alias: string): Array<[string, Record<string, unknown>]> {
  return [
    ['google_api_call', { account: alias, api: 'drive', methodId: 'drive.files.get', pathParams: { fileId: 'f1' } }],
    ['drive_download', { account: alias, fileId: 'f1' }],
    ['drive_export', { account: alias, fileId: 'f1', mimeType: 'application/pdf' }],
    ['gmail_download_attachment', { account: alias, messageId: 'm1', attachmentId: 'a1', filename: 'a.bin' }],
    ['gmail_search', { account: alias, query: 'in:inbox' }],
    ['account_reauth', { account: alias }],
  ];
}

describe('SB2 wall: paths that skip fan-out', () => {
  const prevEnforce = process.env.GOOGLE_GRANTS_ENFORCE;

  afterEach(() => {
    setWizardHttpConsent(null);
    if (prevEnforce === undefined) delete process.env.GOOGLE_GRANTS_ENFORCE;
    else process.env.GOOGLE_GRANTS_ENFORCE = prevEnforce;
  });

  function build() {
    process.env.GOOGLE_GRANTS_ENFORCE = 'true';
    const accounts = accountSet(
      {
        personal: { email: 'personal@example.com' },
        stromback: { email: 'stromback@example.com' },
        opcenter: { email: 'opcenter@example.com' },
        buildcoin: { email: 'buildcoin@example.com' },
        'usa-house': { email: 'usa-house@example.com' },
        olga: { email: 'olga@example.com' },
      },
      { defaultAccount: 'personal' },
    );
    const request = vi.fn(async () => ({ data: { id: 'should-not-run' } }));
    const getClient = vi.fn(async (alias: string) => {
      throw new Error(`getClient must not run for ${alias}`);
    });
    // The request stub is only reachable if getClient returns a client. Keep a
    // separate counter in case a tool builds a client another way.
    const policy: Policy = { profile: 'read-only', readOnly: false, allow: [], deny: [] };
    const { server, handlers, schemas } = fakeServer();
    const registry = new ToolRegistry(server as never, policy, 'lazy', null, () => accounts);
    registerDriveTools(registry, { getClientFn: getClient as never, localFiles: true });
    registerGmailTools(registry, { getClientFn: getClient as never, localFiles: true });
    registerEscapeTools(registry, policy, { getClientFn: getClient as never });
    registerAccountTools(registry, {
      hasToken: () => false,
      readToken: () => null,
      fileExists: () => false,
      now: () => 0,
    });
    const minted: string[] = [];
    setWizardHttpConsent({
      mintConsentUrl: (alias) => {
        minted.push(alias);
        return `https://mcp.example.com/authorize?alias=${alias}`;
      },
    });
    registerAccountWizardTools(registry, server as never);

    async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const handler = handlers[name];
      if (!handler) throw new Error(`tool not registered: ${name}`);
      return handler(z.object(schemas[name]).parse(args) as Record<string, unknown>, {});
    }

    const grant: SessionGrantState = {
      code: '',
      name: 'StrombackBrain2',
      accounts: ['stromback'],
      label: 'sb2',
      source: 'token',
    };
    return { call, getClient, request, minted, grant };
  }

  function buildListed() {
    process.env.GOOGLE_GRANTS_ENFORCE = 'true';
    const accounts = accountSet(
      {
        personal: { email: 'personal@example.com' },
        stromback: { email: 'stromback@example.com' },
        opcenter: { email: 'opcenter@example.com' },
        buildcoin: { email: 'buildcoin@example.com' },
        'usa-house': { email: 'usa-house@example.com' },
        olga: { email: 'olga@example.com' },
      },
      { defaultAccount: 'personal' },
    );
    const request = vi.fn(async () => ({ data: { id: 'should-not-run' } }));
    const getClient = vi.fn(async (_alias: string) => ({ request }));
    const tokenReads: string[] = [];
    const liveToken = () => ({
      refresh_token: 'refresh-token',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      expiry_date: Date.now() + 60_000,
    });
    const policy: Policy = { profile: 'read-only', readOnly: false, allow: [], deny: [] };
    const { server, handlers, schemas } = fakeServer();
    let listHandler: (() => Promise<{ tools: unknown[] }>) | undefined;
    server.server.setRequestHandler = ((method: string, fn: () => Promise<{ tools: unknown[] }>) => {
      if (method === 'tools/list') listHandler = fn;
    }) as never;
    const registry = new ToolRegistry(server as never, policy, 'lazy', null, () => accounts);
    registerDriveTools(registry, { getClientFn: getClient as never, localFiles: true });
    registerGmailTools(registry, { getClientFn: getClient as never, localFiles: true });
    registerEscapeTools(registry, policy, { getClientFn: getClient as never });
    registerDiscoverTools(registry, policy);
    registerAccountTools(registry, {
      hasToken: () => false,
      readToken: () => null,
      fileExists: () => false,
      now: () => 0,
    });
    registerGrantTools(registry);
    registerDiagnoseTool(registry, {
      subject: 'wall',
      accounts,
      getClient: getClient as never,
      tokenStore: {
        hasToken: (alias: string) => {
          tokenReads.push(alias);
          return true;
        },
        readToken: (alias: string) => {
          tokenReads.push(alias);
          return liveToken();
        },
        writeToken: () => undefined,
        updateToken: () => undefined,
      },
    } as never);
    registry.installListHandler();

    async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const handler = handlers[name];
      if (!handler) throw new Error(`tool not registered: ${name}`);
      return handler(z.object(schemas[name]).parse(args) as Record<string, unknown>, {});
    }

    const grant: SessionGrantState = {
      code: '',
      name: 'StrombackBrain2',
      accounts: ['stromback'],
      label: 'sb2',
      source: 'token',
    };
    return {
      call,
      getClient,
      request,
      tokenReads,
      grant,
      metaNames: Object.keys(handlers).filter(
        (name) =>
          name === 'discover_all' ||
          name === 'discover_reset' ||
          name === 'diagnose' ||
          name === 'grant_status' ||
          name.endsWith('_discover'),
      ),
      listTools: async () => {
        if (!listHandler) throw new Error('tools/list was not installed');
        return listHandler();
      },
    };
  }

  it('a grant that includes stromback cannot name any other alias', async () => {
    const { call, getClient, request, minted, grant } = build();
    await runWithGrant(grant, async () => {
      for (const alias of OUTSIDERS) {
        for (const [name, args] of callsFor(alias)) {
          const res = await call(name, args);
          const body = parseResult(res);
          expect(res.isError, `${name} ${alias}`).toBe(true);
          expect(body.error, `${name} ${alias}`).toBe('account_outside_grant');
          expect(body.account, `${name} ${alias}`).toBe(alias);
          for (const other of OUTSIDERS) {
            if (other === alias) continue;
            expect(res.content[0].text, `${name} ${alias} leaked ${other}`).not.toContain(other);
          }
        }
      }

      const listed = parseResult(await call('account_list'));
      expect(listed.defaultAccount).toBeNull();
      expect(listed.defaultAccountSource).toBeNull();
      expect(listed.accounts.map((row: { alias: string }) => row.alias)).toEqual(['stromback']);
      expect(JSON.stringify(listed)).not.toContain('personal');

      const hint = parseResult(await call('drive_download', { fileId: 'f1' }));
      expect(hint.error).toBe('E_NO_DEFAULT_ACCOUNT');
      expect(hint.hint).toContain('stromback');
      for (const other of OUTSIDERS) {
        expect(hint.hint, other).not.toContain(other);
        expect(hint.message, other).not.toContain(other);
      }
    });
    expect(getClient).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(minted).toEqual([]);
  });

  it('a grantless session with enforcement on is refused for every alias', async () => {
    const { call, getClient, request, minted } = build();
    await runWithGrant(null, async () => {
      for (const alias of EVERY_ALIAS) {
        for (const [name, args] of callsFor(alias)) {
          const res = await call(name, args);
          const body = parseResult(res);
          expect(res.isError, `${name} ${alias}`).toBe(true);
          expect(body.error, `${name} ${alias}`).toBe('grant_required');
          expect(body.account, `${name} ${alias}`).toBe(alias);
          expect(String(body.message ?? ''), `${name} ${alias}`).not.toContain('@');
        }
      }
      const listed = parseResult(await call('account_list'));
      expect(listed.error).toBe('grant_required');
      expect(listed.accounts).toBeUndefined();
      expect(JSON.stringify(listed)).not.toContain('@');
      const hint = parseResult(await call('gmail_search', { query: 'in:inbox' }));
      expect(hint.error).toBe('grant_required');
    });
    expect(getClient).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(minted).toEqual([]);
  });

  it('an SB2 session sees nothing outside stromback from discover, diagnose, and grant_status', async () => {
    const { call, getClient, tokenReads, grant, listTools, metaNames } = buildListed();
    const outsiders = [
      ...OUTSIDERS,
      ...OUTSIDERS.map((alias) => `${alias}@example.com`),
    ];
    expect(metaNames).toEqual(expect.arrayContaining(['discover_all', 'gmail_discover', 'drive_discover', 'diagnose', 'grant_status']));
    await runWithGrant(grant, async () => {
      for (const name of metaNames) {
        const res = await call(name);
        const text = res.content[0].text;
        for (const needle of outsiders) {
          expect(text, `${name} leaked ${needle}`).not.toContain(needle);
        }
      }
      const diagnosed = parseResult(await call('diagnose'));
      const blob = JSON.stringify(diagnosed);
      expect(blob).toContain('stromback');
      expect(blob).toContain('stromback@example.com');
      const status = parseResult(await call('grant_status'));
      expect(status.accounts).toEqual(['stromback']);

      const listed = await listTools();
      const listedText = JSON.stringify(listed);
      for (const needle of outsiders) {
        expect(listedText, `tools/list leaked ${needle}`).not.toContain(needle);
      }
      expect(listedText).toContain('stromback');
    });
    const probed = getClient.mock.calls.map((args) => args[0]);
    expect(probed.filter((alias) => alias !== 'stromback')).toEqual([]);
    expect(tokenReads.filter((alias) => alias !== 'stromback')).toEqual([]);
  });
});
