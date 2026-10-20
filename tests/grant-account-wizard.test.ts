import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { invalidateAccountSet } from '../src/accounts.js';
import { configFilePath } from '../src/config-file.js';
import {
  clearSessionGrant,
  isGrantEnforced,
  loadGrantsFile,
  resetGrantsFileCache,
  runWithGrant,
  type SessionGrantState,
} from '../src/session-grant.js';
import { registerAccountWizardTools, setWizardHttpConsent } from '../src/tools/account-wizard.js';
import type { ToolRegistry } from '../src/registry.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync(p: Parameters<typeof actual.existsSync>[0]) {
      const s = String(p);
      if (process.env.TEST_GRANTS_MOUNT === '1' && (s === '/mnt/grants' || s === '/mnt/grants/grants.json')) return true;
      return actual.existsSync(p);
    },
  };
});

vi.mock('../src/client-config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/client-config.js')>();
  return {
    ...mod,
    applyFileEntry: vi.fn(() => ({ ok: true, action: 'updated', path: '/tmp/client.json' })),
  };
});

import { applyFileEntry } from '../src/client-config.js';

type Handler = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const PBG3 = ['personal', 'stromback', 'opcenter', 'buildcoin', 'usa-house', 'olga'] as const;
const SB2_OUTSIDERS = ['personal', 'opcenter', 'buildcoin', 'usa-house', 'olga'] as const;

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
  'MCP_HOSTED',
  'K_SERVICE',
  'TEST_GRANTS_MOUNT',
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
          accounts: [...PBG3],
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

function envelope(result: { content: { text: string }[] }): { error?: string; message?: string; hint?: string; account?: string } {
  return JSON.parse(result.content[0].text) as { error?: string; message?: string; hint?: string; account?: string };
}

describe('account wizard grant boundary', () => {
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

  function activate(opts: { enforce?: 'unset' | 'false'; surface?: 'k_service' | 'desk' }): SessionGrantState[] {
    dir = mkdtempSync(path.join(tmpdir(), 'gmulti-grant-wizard-'));
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    armed = true;
    delete process.env.GOOGLE_ACCOUNTS;
    delete process.env.GOOGLE_GRANT_CODE;
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_PUBLIC_URL;
    delete process.env.MCP_HOSTED;
    delete process.env.K_SERVICE;
    process.env.GOOGLE_CLIENT_ID = 'wizard-test-id';
    process.env.GOOGLE_CLIENT_SECRET = 'wizard-test-secret';
    process.env.GOOGLE_GRANTS_PATH = grantFile(dir);
    if (opts.surface !== 'desk') {
      process.env.MCP_HOSTED = '1';
      process.env.K_SERVICE = 'google-multi-mcp';
    }
    if (opts.enforce === 'false') process.env.GOOGLE_GRANTS_ENFORCE = 'false';
    else delete process.env.GOOGLE_GRANTS_ENFORCE;
    writeFileSync(
      configFilePath(),
      JSON.stringify({
        version: 1,
        accounts: Object.fromEntries(PBG3.map((alias) => [alias, { email: `${alias}@example.com` }])),
      }),
    );
    invalidateAccountSet();
    resetGrantsFileCache();
    clearSessionGrant();
    const file = loadGrantsFile(true);
    if (!file) throw new Error('grants file did not load');
    for (const grant of file.grants) {
      if (grant.code !== 'REPLACE_WITH_HOST_LOCAL_CODE') throw new Error(`grant ${grant.name} is not a placeholder code`);
    }
    return file.grants.map((grant) => ({
      code: '',
      name: grant.name,
      accounts: [...grant.accounts],
      label: 'token',
      source: 'token' as const,
    }));
  }

  it('is on by default in hosted mode and SB2 cannot reach the other five accounts', async () => {
    const [pbg3, sb2] = activate({ enforce: 'unset' });
    expect(isGrantEnforced()).toBe(true);
    expect(pbg3.accounts).toEqual([...PBG3]);
    expect(sb2.accounts).toEqual(['stromback']);
    const minted: string[] = [];
    setWizardHttpConsent({
      mintConsentUrl: (alias) => {
        minted.push(alias);
        return `https://mcp.example.com/authorize?alias=${alias}`;
      },
    });
    const handlers = captureHandlers();

    await runWithGrant(sb2, async () => {
      for (const alias of SB2_OUTSIDERS) {
        const added = await handlers.account_add({ alias, email: `${alias}@example.com` });
        const body = envelope(added);
        expect(body.error, alias).toBe('account_outside_grant');
        expect(body.account, alias).toBe(alias);
        expect(body.hint, alias).toBe('This session can only add or re-link: stromback.');
        for (const other of PBG3) {
          if (other === alias || other === 'stromback') continue;
          expect(body.hint, alias).not.toContain(other);
          expect(body.message, alias).not.toContain(other);
        }

        const reauth = await handlers.account_reauth({ alias });
        const reauthBody = envelope(reauth);
        expect(reauthBody.error, alias).toBe('account_outside_grant');
        expect(reauthBody.hint, alias).toBe('This session can only add or re-link: stromback.');
      }

      const config = await handlers.account_write_config({ write: true, client: 'claude-desktop' });
      expect(envelope(config).error).toBe('account_outside_grant');
      expect(envelope(config).hint).toBe("This session's accounts: stromback.");
      expect(applyFileEntry).not.toHaveBeenCalled();

      const own = await handlers.account_reauth({ alias: 'stromback' });
      expect(own.isError).toBeUndefined();
    });
    expect(minted).toEqual(['stromback']);

    minted.length = 0;
    await runWithGrant(pbg3, async () => {
      for (const alias of PBG3) {
        const added = await handlers.account_add({ alias, email: `${alias}@example.com` });
        expect(envelope(added).error, alias).not.toBe('account_outside_grant');
        const reauth = await handlers.account_reauth({ alias });
        expect(reauth.isError, alias).toBeUndefined();
      }
      const config = await handlers.account_write_config({ write: true, client: 'claude-desktop' });
      expect(config.isError).toBeUndefined();
      expect(config.content[0].text).toContain('ignored on a hosted server');
      expect(applyFileEntry).not.toHaveBeenCalled();
    });
    expect(minted).toEqual([...PBG3]);

    const stored = JSON.parse(readFileSync(configFilePath(), 'utf8')) as { accounts: Record<string, unknown> };
    expect(Object.keys(stored.accounts).sort()).toEqual([...PBG3].sort());
  });

  it('a full grant on a desk still writes client config', async () => {
    const [pbg3] = activate({ enforce: 'unset', surface: 'desk' });
    const handlers = captureHandlers();
    await runWithGrant(pbg3, async () => {
      const config = await handlers.account_write_config({ write: true, client: 'claude-desktop' });
      expect(config.isError).toBeUndefined();
      expect(applyFileEntry).toHaveBeenCalledTimes(1);
    });
  });

  it('the grants mount alone refuses account_write_config when K_SERVICE is unset', async () => {
    const [pbg3] = activate({ enforce: 'unset', surface: 'desk' });
    process.env.TEST_GRANTS_MOUNT = '1';
    const handlers = captureHandlers();
    await runWithGrant(pbg3, async () => {
      const config = await handlers.account_write_config({ write: true, client: 'claude-desktop' });
      expect(config.content[0].text).toContain('ignored on a hosted server');
      expect(applyFileEntry).not.toHaveBeenCalled();
    });
  });

  it('GOOGLE_GRANTS_ENFORCE=false is the off switch, including on a hosted process', async () => {
    const [, sb2] = activate({ enforce: 'false' });
    expect(isGrantEnforced()).toBe(false);
    const minted: string[] = [];
    setWizardHttpConsent({
      mintConsentUrl: (alias) => {
        minted.push(alias);
        return `https://mcp.example.com/authorize?alias=${alias}`;
      },
    });
    const handlers = captureHandlers();
    await runWithGrant(sb2, async () => {
      const reauth = await handlers.account_reauth({ alias: 'personal' });
      expect(reauth.isError).toBeUndefined();
    });
    expect(minted).toEqual(['personal']);
  });
});
