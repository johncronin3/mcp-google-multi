/**
 * No-widening proof for an upstream isolate.
 * Fixture grants only (tests/fixtures/grants-no-widen.json). Never a host
 * grants file, token, or signing key.
 *
 * Before the merge this locks StrombackBrain2 to stromback and Personal Brain
 * Grant 3 to the same six aliases. keep and cloudidentity stay off the base
 * consent set, so neither grant registers those services. When the registry
 * grows a hideServices() API, a hidden service stays out of tools/list for
 * every fixture grant. Hiding is display-only: a hidden tool called by name
 * still runs, and google_api_call can still reach that service.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { invalidateAccountSet } from '../src/accounts.js';
import { BASE_SCOPES, resolveScopesForAccount } from '../src/auth.js';
import { buildRegistry } from '../src/compose.js';
import { clearDiscoveryMemoryCache } from '../src/discovery-client.js';
import type { IdentityContext } from '../src/identity.js';
import { ToolRegistry } from '../src/registry.js';
import { isAllowed } from '../src/write-control.js';
import { BUNDLE_CATALOG } from '../src/scope-catalog.js';
import { GENERATED_GATES } from '../src/services.js';
import {
  allowedAccounts,
  clearSessionGrant,
  loadGrantsFile,
  resetGrantsFileCache,
  setSessionGrant,
} from '../src/session-grant.js';
import type { AccountSet } from '../src/accounts.js';
import type { ScopeProfile } from '../src/scope-catalog.js';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/grants-no-widen.json', import.meta.url));
const SB2_NAME = 'StrombackBrain2';
const PBG3_NAME = 'Personal Brain Grant 3';
const SB2_ACCOUNTS = ['stromback'] as const;
const PBG3_ACCOUNTS = ['personal', 'stromback', 'opcenter', 'buildcoin', 'usa-house', 'olga'] as const;
const EXTRA = 'not-in-any-grant';
const CONFIGURED = [...PBG3_ACCOUNTS, EXTRA] as const;
const BLOCKED_SCOPES = [
  ...BUNDLE_CATALOG.keep.scopes,
  ...BUNDLE_CATALOG.cloudidentity.scopes,
];
const HIDDEN_SERVICES = ['gmail', 'keep', 'cloudidentity'] as const;

const ENV_KEYS = [
  'GOOGLE_ACCOUNTS',
  'GOOGLE_GRANTS_PATH',
  'GOOGLE_GRANTS_ENFORCE',
  'GOOGLE_GRANT_CODE',
  'GOOGLE_OPTIONAL_SCOPES',
  'GOOGLE_ADMIN_ACCOUNTS',
  'GOOGLE_HOME_DOMAINS',
  'GOOGLE_TOOLSETS',
  'MCP_HTTP_TOKEN_GRANT',
  'MCP_HOSTED',
  'K_SERVICE',
  'MCP_TRANSPORT',
] as const;

const saved: Record<string, string | undefined> = {};

type ToolResult = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
type ListedTool = { name: string; inputSchema?: unknown };

function accountSet(): AccountSet {
  const configs: AccountSet['configs'] = {};
  for (const alias of CONFIGURED) {
    configs[alias] = {
      email: `${alias}@example.com`,
      tokenPath: `/nonexistent/${alias}/token.json`,
      encPath: `/nonexistent/${alias}.enc`,
      source: 'config',
    };
  }
  const scopeProfiles: Record<string, ScopeProfile> = { base: { bundles: [] } };
  return {
    aliases: [...CONFIGURED],
    configs,
    scopeProfiles,
    source: 'file',
    stamp: 'no-widen',
    defaultAccount: 'personal',
    defaultAccountSource: 'config',
  };
}

function grantCode(name: string): string {
  const file = loadGrantsFile(true);
  const rec = file?.grants.find((g) => g.name === name);
  if (!rec) throw new Error(`fixture grant missing: ${name}`);
  return rec.code;
}

describe('upstream isolate does not widen fixture grants', () => {
  const seen: string[] = [];
  const getClient = vi.fn(async (alias: string) => {
    seen.push(alias);
    throw new Error(`stop-after-gate:${alias}`);
  });
  const handlers: Record<string, Handler> = {};
  let registry: ToolRegistry;
  let listHandler: (() => Promise<{ tools: ListedTool[] }>) | null = null;

  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.GOOGLE_ACCOUNTS = CONFIGURED.map((alias) => `${alias}:${alias}@example.com`).join(',');
    process.env.GOOGLE_GRANTS_PATH = FIXTURE_PATH;
    process.env.GOOGLE_GRANTS_ENFORCE = 'true';
    delete process.env.GOOGLE_GRANT_CODE;
    delete process.env.GOOGLE_OPTIONAL_SCOPES;
    delete process.env.GOOGLE_ADMIN_ACCOUNTS;
    delete process.env.GOOGLE_HOME_DOMAINS;
    delete process.env.GOOGLE_TOOLSETS;
    delete process.env.MCP_HTTP_TOKEN_GRANT;
    delete process.env.MCP_HOSTED;
    delete process.env.K_SERVICE;
    delete process.env.MCP_TRANSPORT;
    invalidateAccountSet();
    resetGrantsFileCache();
    clearSessionGrant();

    const set = accountSet();
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers[name] = handler;
        return 'ok';
      },
      sendToolListChanged: vi.fn(),
      server: {
        setRequestHandler: (method: unknown, handler: () => Promise<{ tools: ListedTool[] }>) => {
          if (method === 'tools/list') listHandler = handler;
        },
        getClientCapabilities: () => undefined,
      },
    };
    const ctx = {
      subject: 'no-widen-fixture',
      accounts: set,
      policy: { profile: 'read-only', readOnly: false, allow: [], deny: [] },
      getClient,
      tokenStore: {
        readToken: () => null,
        writeToken: () => {},
        updateToken: () => {},
        hasToken: () => false,
      },
    } as unknown as IdentityContext;
    registry = buildRegistry(server as never, ctx, 'eager');
  }, 60_000);

  afterAll(() => {
    clearSessionGrant();
    resetGrantsFileCache();
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    invalidateAccountSet();
  });

  function activate(name: string) {
    seen.length = 0;
    getClient.mockClear();
    clearSessionGrant();
    return setSessionGrant(grantCode(name), 'no-widen');
  }

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const handler = handlers[name];
    if (!handler) throw new Error(`tool not registered: ${name}`);
    return handler(args, {});
  }

  function body(result: ToolResult): { error?: string; account?: string; accounts?: { alias: string }[] } {
    return JSON.parse(result.content[0].text) as { error?: string; account?: string; accounts?: { alias: string }[] };
  }

  it('the fixture is the only grant input and names the pre-merge slices', () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
      grants: { name: string; accounts: string[] }[];
    };
    expect(process.env.GOOGLE_GRANTS_PATH).toBe(FIXTURE_PATH);
    expect(raw.grants.map((g) => g.name)).toEqual([SB2_NAME, PBG3_NAME]);
    expect(raw.grants.find((g) => g.name === SB2_NAME)?.accounts).toEqual([...SB2_ACCOUNTS]);
    expect(raw.grants.find((g) => g.name === PBG3_NAME)?.accounts).toEqual([...PBG3_ACCOUNTS]);
    expect(FIXTURE_PATH).not.toMatch(/\.config|grants\.json$/);
  });

  it('StrombackBrain2 reaches only the stromback account', async () => {
    const grant = activate(SB2_NAME);
    expect(grant.name).toBe(SB2_NAME);
    expect(grant.accounts).toEqual([...SB2_ACCOUNTS]);
    expect(allowedAccounts()).toEqual([...SB2_ACCOUNTS]);

    const listed = body(await call('account_list', {}));
    expect(listed.accounts?.map((row) => row.alias)).toEqual([...SB2_ACCOUNTS]);
    const blob = JSON.stringify(listed);
    for (const alias of [...PBG3_ACCOUNTS.filter((a) => a !== 'stromback'), EXTRA]) {
      expect(blob).not.toContain(alias);
    }

    for (const alias of [...PBG3_ACCOUNTS.filter((a) => a !== 'stromback'), EXTRA]) {
      const res = await call('gmail_search', { account: alias, query: 'in:inbox' });
      expect(res.isError, alias).toBe(true);
      expect(body(res).error, alias).toBe('account_outside_grant');
      expect(body(res).account, alias).toBe(alias);
    }
    expect(seen).toEqual([]);

    const allowed = await call('gmail_search', { account: 'stromback', query: 'in:inbox' });
    expect(body(allowed).error).not.toBe('account_outside_grant');
    expect(seen).toEqual(['stromback']);
  });

  it('Personal Brain Grant 3 reaches exactly the same six accounts and nothing more', async () => {
    const grant = activate(PBG3_NAME);
    expect(grant.name).toBe(PBG3_NAME);
    expect(grant.accounts).toEqual([...PBG3_ACCOUNTS]);
    expect(allowedAccounts()).toEqual([...PBG3_ACCOUNTS]);

    const listed = body(await call('account_list', {}));
    expect(listed.accounts?.map((row) => row.alias)).toEqual([...PBG3_ACCOUNTS]);
    expect(JSON.stringify(listed)).not.toContain(EXTRA);

    const refused = await call('gmail_search', { account: EXTRA, query: 'in:inbox' });
    expect(refused.isError).toBe(true);
    expect(body(refused).error).toBe('account_outside_grant');
    expect(seen).toEqual([]);

    for (const alias of PBG3_ACCOUNTS) {
      seen.length = 0;
      const res = await call('gmail_search', { account: alias, query: 'in:inbox' });
      expect(body(res).error, alias).not.toBe('account_outside_grant');
      expect(seen, alias).toEqual([alias]);
    }
  });

  it('keep and cloudidentity scopes are not on any fixture grant', () => {
    const set = accountSet();
    expect(BASE_SCOPES.some((scope) => BLOCKED_SCOPES.includes(scope))).toBe(false);
    expect(GENERATED_GATES.keep.enabled(set)).toBe(false);
    expect(GENERATED_GATES.cloudidentity.enabled(set)).toBe(false);
    expect(registry.services()).not.toContain('keep');
    expect(registry.services()).not.toContain('cloudidentity');
    const names = registry.toolNames();
    expect(names.some((name) => name.startsWith('keep_') || name.startsWith('cloudidentity_'))).toBe(false);
    expect(registry.hasTool('keep_notes_list')).toBe(false);

    for (const name of [SB2_NAME, PBG3_NAME]) {
      const grant = activate(name);
      for (const alias of grant.accounts) {
        const scopes = resolveScopesForAccount(alias, set);
        for (const blocked of BLOCKED_SCOPES) {
          expect(scopes, `${name} ${alias} ${blocked}`).not.toContain(blocked);
        }
      }
      expect(seen).toEqual([]);
    }
  });

  it('a grantless session with the gate on reaches no alias', async () => {
    clearSessionGrant();
    seen.length = 0;
    expect(() => allowedAccounts()).toThrow(/Fail-closed/);
    const listed = body(await call('account_list', {}));
    expect(listed.error).toBe('grant_required');
    expect(listed.accounts).toBeUndefined();
    for (const alias of CONFIGURED) {
      const res = await call('gmail_search', { account: alias, query: 'in:inbox' });
      expect(body(res).error, alias).toBe('grant_required');
    }
    expect(seen).toEqual([]);
  });

  const hasHide = typeof (ToolRegistry.prototype as { hideServices?: unknown }).hideServices === 'function';

  it.skipIf(!hasHide)('a service the registry hides is not listed for any fixture grant', async () => {
    const hide = (registry as unknown as { hideServices: (services: Iterable<string>) => void }).hideServices.bind(registry);
    hide(HIDDEN_SERVICES);
    registry.installListHandler();
    if (!listHandler) throw new Error('tools/list handler was not installed');

    for (const name of [SB2_NAME, PBG3_NAME]) {
      activate(name);
      const listed = await listHandler();
      const names = listed.tools.map((tool) => tool.name);
      for (const service of HIDDEN_SERVICES) {
        const operational = names.filter((tool) => tool.startsWith(`${service}_`) && tool !== `${service}_discover`);
        expect(operational, `${name} listed ${service}`).toEqual([]);
      }
      const search = listed.tools.find((tool) => tool.name === 'gmail_search');
      expect(search, name).toBeUndefined();
      expect(seen).toEqual([]);
    }

    const reveal = (registry as unknown as { reveal?: (service: string) => boolean }).reveal;
    if (reveal) reveal.call(registry, 'gmail');
    for (const name of [SB2_NAME, PBG3_NAME]) {
      activate(name);
      const listed = await listHandler();
      expect(listed.tools.some((tool) => tool.name === 'gmail_search'), name).toBe(false);
    }
  });

  // Hiding is display-only. It drops operational tools from tools/list.
  // It is not a wall: the same tool called by name still runs, a generated
  // per-method tool still runs, and google_api_call still reaches the hidden
  // service. A tool: deny does not stop a read (write-control.ts returns
  // true for cud === 'read' before the deny list). Account reach is the grant.
  it.skipIf(!hasHide)('display-only: a hidden tool called by name still runs under either fixture grant', async () => {
    const hide = (registry as unknown as { hideServices: (services: Iterable<string>) => void }).hideServices.bind(registry);
    hide(['gmail']);
    expect(
      isAllowed(
        { name: 'gmail_search', service: 'gmail', cud: 'read' },
        { profile: 'full-writes', readOnly: false, allow: [], deny: ['tool:gmail_search'] },
      ),
    ).toBe(true);

    for (const name of [SB2_NAME, PBG3_NAME]) {
      const grant = activate(name);
      const alias = grant.accounts[0];
      const res = await call('gmail_search', { account: alias, query: 'in:inbox' });
      const parsed = body(res);
      expect(parsed.error, name).not.toBe('account_outside_grant');
      expect(parsed.error, name).not.toBe('grant_required');
      expect(parsed.error, name).not.toBe('service_hidden');
      expect(seen, name).toEqual([alias]);

      seen.length = 0;
      const generated = await call('gmail_users_settings_cse_identities_get', {
        account: alias,
        userId: 'me',
        cseEmailAddress: 'cse@example.com',
      });
      expect(body(generated).error, `${name} generated`).not.toBe('service_hidden');
      expect(seen, `${name} generated`).toEqual([alias]);

      const discover = await call('gmail_discover', {});
      expect(body(discover).error, `${name} discover`).not.toBe('service_hidden');
    }
  });

  it.skipIf(!hasHide)('display-only: google_api_call still reaches a hidden service under either fixture grant', async () => {
    const hide = (registry as unknown as { hideServices: (services: Iterable<string>) => void }).hideServices.bind(registry);
    hide(['gmail']);
    const cache = mkdtempSync(path.join(tmpdir(), 'hide-discovery-'));
    const prevCache = process.env.DISCOVERY_CACHE_PATH;
    process.env.DISCOVERY_CACHE_PATH = cache;
    clearDiscoveryMemoryCache();
    writeFileSync(
      path.join(cache, 'gmail.json'),
      JSON.stringify({
        baseUrl: 'https://gmail.googleapis.com/',
        resources: {
          users: {
            resources: {
              messages: {
                methods: {
                  list: {
                    id: 'gmail.users.messages.list',
                    httpMethod: 'GET',
                    path: 'gmail/v1/users/{userId}/messages',
                    description: 'Lists messages.',
                    parameters: { userId: { location: 'path', required: true, type: 'string' } },
                  },
                },
              },
            },
          },
        },
      }),
    );
    writeFileSync(
      path.join(cache, 'drive.json'),
      JSON.stringify({
        baseUrl: 'https://www.googleapis.com/',
        resources: {
          files: {
            methods: {
              get: {
                id: 'drive.files.get',
                httpMethod: 'GET',
                path: 'drive/v3/files/{fileId}',
                description: 'Gets a file.',
                parameters: { fileId: { location: 'path', required: true, type: 'string' } },
              },
            },
          },
        },
      }),
    );

    try {
      for (const name of [SB2_NAME, PBG3_NAME]) {
        const grant = activate(name);
        const alias = grant.accounts[0];
        const hidden = await call('google_api_call', {
          account: alias,
          api: 'gmail',
          methodId: 'gmail.users.messages.list',
          pathParams: { userId: 'me' },
        });
        expect(body(hidden).error, name).not.toBe('service_hidden');
        expect(seen, name).toEqual([alias]);

        seen.length = 0;
        const open = await call('google_api_call', {
          account: alias,
          api: 'drive',
          methodId: 'drive.files.get',
          pathParams: { fileId: 'f1' },
        });
        expect(body(open).error, `${name} drive`).not.toBe('service_hidden');
        expect(seen, `${name} drive`).toEqual([alias]);
      }
    } finally {
      clearDiscoveryMemoryCache();
      if (prevCache === undefined) delete process.env.DISCOVERY_CACHE_PATH;
      else process.env.DISCOVERY_CACHE_PATH = prevCache;
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
