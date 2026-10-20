import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { invalidateAccountSet } from '../src/accounts.js';
import { configFilePath } from '../src/config-file.js';
import {
  clearSessionGrant,
  resetGrantsFileCache,
  resolveGrantByName,
  runWithGrant,
} from '../src/session-grant.js';
import { registerAccountWizardTools, setWizardHttpConsent } from '../src/tools/account-wizard.js';
import type { ToolRegistry } from '../src/registry.js';

vi.mock('../src/client-config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/client-config.js')>();
  return {
    ...mod,
    applyFileEntry: vi.fn(() => {
      throw new Error('applyFileEntry must not run for a narrow grant');
    }),
  };
});

import { applyFileEntry } from '../src/client-config.js';

type Handler = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function captureHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const registry = {
    registerMeta: (name: string, _cfg: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  } as unknown as ToolRegistry;
  const server = {
    server: { getClientCapabilities: () => undefined },
    sendToolListChanged: () => {},
  } as unknown as McpServer;
  registerAccountWizardTools(registry, server);
  return handlers;
}

const saved: Record<string, string | undefined> = {};
let armed = false;
const ENV_KEYS = [
  'GOOGLE_ACCOUNTS',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_GRANTS_PATH',
  'GOOGLE_GRANTS_ENFORCE',
  'GOOGLE_GRANT_CODE',
  'MCP_TRANSPORT',
  'MCP_PUBLIC_URL',
] as const;

function grantFile(dir: string): string {
  const grantsPath = path.join(dir, 'grants.json');
  writeFileSync(
    grantsPath,
    JSON.stringify({
      version: 1,
      grants: [
        {
          name: 'Personal Brain Grant 3',
          code: 'REPLACE_WITH_HOST_LOCAL_CODE',
          accounts: ['personal', 'stromback', 'opcenter', 'buildcoin'],
        },
        {
          name: 'StrombackBrain2',
          code: 'REPLACE_WITH_HOST_LOCAL_CODE',
          accounts: ['stromback'],
        },
      ],
    }),
  );
  return grantsPath;
}

describe('SB2 cannot add or re-link an account outside stromback', () => {
  let dir: string;

  afterEach(() => {
    setWizardHttpConsent(null);
    clearSessionGrant();
    resetGrantsFileCache();
    if (armed) {
      for (const key of ENV_KEYS) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      invalidateAccountSet();
      armed = false;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function activateSb2(): void {
    dir = mkdtempSync(path.join(tmpdir(), 'gmulti-sb2-'));
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    armed = true;
    delete process.env.GOOGLE_ACCOUNTS;
    delete process.env.GOOGLE_GRANT_CODE;
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_PUBLIC_URL;
    process.env.GOOGLE_CLIENT_ID = 'wizard-test-id';
    process.env.GOOGLE_CLIENT_SECRET = 'wizard-test-secret';
    process.env.GOOGLE_GRANTS_PATH = grantFile(dir);
    process.env.GOOGLE_GRANTS_ENFORCE = 'true';
    writeFileSync(
      configFilePath(),
      JSON.stringify({
        version: 1,
        accounts: {
          personal: { email: 'personal@example.com' },
          stromback: { email: 'stromback@example.com' },
          opcenter: { email: 'opcenter@example.com' },
          buildcoin: { email: 'buildcoin@example.com' },
        },
      }),
    );
    invalidateAccountSet();
    resetGrantsFileCache();
    clearSessionGrant();
  }

  it('refuses add, reauth, and client-config writes for accounts outside the grant', async () => {
    activateSb2();
    const resolved = resolveGrantByName('StrombackBrain2');
    expect(resolved?.accounts).toEqual(['stromback']);
    const minted: string[] = [];
    setWizardHttpConsent({
      mintConsentUrl: (alias) => {
        minted.push(alias);
        return `https://mcp.example.com/authorize?alias=${alias}`;
      },
    });
    const handlers = captureHandlers();

    await runWithGrant(resolved, async () => {
      const added = await handlers.account_add({ alias: 'outsider', email: 'outsider@example.com' });
      expect(added.isError).toBe(true);
      expect(added.content[0].text).toContain('account_outside_grant');
      expect(added.content[0].text).not.toContain('opcenter');
      expect(added.content[0].text).not.toContain('buildcoin');
      expect(added.content[0].text).not.toContain('personal');

      for (const alias of ['personal', 'opcenter', 'buildcoin']) {
        const reauth = await handlers.account_reauth({ alias });
        expect(reauth.isError, alias).toBe(true);
        const body = JSON.parse(reauth.content[0].text) as { error: string; message: string; hint: string; account: string };
        expect(body.error, alias).toBe('account_outside_grant');
        expect(body.account, alias).toBe(alias);
        expect(body.message, alias).toContain(alias);
        expect(body.hint, alias).toBe('This session can only add or re-link: stromback.');
      }

      const config = await handlers.account_write_config({ write: true, client: 'claude-desktop' });
      expect(config.isError).toBe(true);
      expect(config.content[0].text).toContain('account_outside_grant');
      expect(config.content[0].text).not.toContain('personal');
      expect(applyFileEntry).not.toHaveBeenCalled();

      const own = await handlers.account_reauth({ alias: 'stromback' });
      expect(own.isError).toBeUndefined();
      expect(minted).toEqual(['stromback']);
    });

    const stored = JSON.parse(readFileSync(configFilePath(), 'utf8')) as { accounts: Record<string, unknown> };
    expect(Object.keys(stored.accounts).sort()).toEqual(['buildcoin', 'opcenter', 'personal', 'stromback']);
    expect(stored.accounts.outsider).toBeUndefined();
  });
});
