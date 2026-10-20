import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AccountSet } from '../src/accounts.js';
import { ToolRegistry } from '../src/registry.js';
import { registerDriveTools } from '../src/tools/drive.js';
import { registerGmailTools } from '../src/tools/gmail.js';
import { registerEscapeTools } from '../src/tools/google-api.js';
import { registerAccountTools } from '../src/tools/accounts-tool.js';
import { registerAccountWizardTools, setWizardHttpConsent } from '../src/tools/account-wizard.js';
import { runWithGrant, type SessionGrantState } from '../src/session-grant.js';
import type { Policy } from '../src/write-control.js';

const OUTSIDERS = ['personal', 'opcenter', 'buildcoin', 'usa-house', 'olga'];

type ToolResult = { content: { type?: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

function accountSet(rows: Record<string, string>, defaultAccount: string): AccountSet {
  const configs: AccountSet['configs'] = {};
  for (const [alias, email] of Object.entries(rows)) {
    configs[alias] = {
      email,
      tokenPath: `/nonexistent/${alias}/token.json`,
      encPath: `/nonexistent/${alias}.enc`,
      source: 'config',
    };
  }
  return {
    aliases: Object.keys(rows),
    configs,
    scopeProfiles: { base: { bundles: [] } },
    source: 'file',
    stamp: '1:0',
    defaultAccount,
    defaultAccountSource: 'config',
  };
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
        personal: 'personal@example.com',
        stromback: 'stromback@example.com',
        opcenter: 'opcenter@example.com',
        buildcoin: 'buildcoin@example.com',
        'usa-house': 'usa-house@example.com',
        olga: 'olga@example.com',
      },
      'personal',
    );
    const request = vi.fn(async () => ({ data: { id: 'should-not-run' } }));
    const getClient = vi.fn(async (alias: string) => {
      throw new Error(`getClient must not run for ${alias}`);
    });
    const policy: Policy = { profile: 'read-only', readOnly: false, allow: [], deny: [] };
    const handlers: Record<string, Handler> = {};
    const schemas: Record<string, z.ZodRawShape> = {};
    const server = {
      registerTool: (name: string, config: { inputSchema?: z.ZodRawShape }, handler: Handler) => {
        handlers[name] = handler;
        schemas[name] = config.inputSchema ?? {};
        return 'ok';
      },
      sendToolListChanged: vi.fn(),
      server: { setRequestHandler: () => {}, getClientCapabilities: () => undefined },
    };
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

  it('refuses personal before getClient on the escape hatch, downloads, and a meta tool', async () => {
    const { call, getClient, request, minted, grant } = build();
    await runWithGrant(grant, async () => {
      const calls: Array<[string, Record<string, unknown>]> = [
        ['google_api_call', { account: 'personal', api: 'drive', methodId: 'drive.files.get', pathParams: { fileId: 'f1' } }],
        ['drive_download', { account: 'personal', fileId: 'f1' }],
        ['drive_export', { account: 'personal', fileId: 'f1', mimeType: 'application/pdf' }],
        ['gmail_download_attachment', { account: 'personal', messageId: 'm1', attachmentId: 'a1', filename: 'a.bin' }],
        ['account_reauth', { account: 'personal' }],
      ];
      for (const [name, args] of calls) {
        const res = await call(name, args);
        const body = JSON.parse(res.content[0].text) as { error?: string; account?: string };
        expect(res.isError, name).toBe(true);
        expect(body.error, name).toBe('account_outside_grant');
        expect(body.account, name).toBe('personal');
        for (const other of OUTSIDERS) {
          if (other === 'personal') continue;
          expect(res.content[0].text, `${name} ${other}`).not.toContain(other);
        }
      }

      const listed = JSON.parse((await call('account_list')).content[0].text) as {
        defaultAccount: string | null;
        defaultAccountSource: string | null;
        accounts: { alias: string }[];
      };
      expect(listed.defaultAccount).toBeNull();
      expect(listed.defaultAccountSource).toBeNull();
      expect(listed.accounts.map((row) => row.alias)).toEqual(['stromback']);
      expect(JSON.stringify(listed)).not.toContain('personal');

      const hint = JSON.parse((await call('drive_download', { fileId: 'f1' })).content[0].text) as {
        error: string;
        hint: string;
        message: string;
      };
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
});
