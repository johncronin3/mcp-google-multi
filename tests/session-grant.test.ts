import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertAccountAllowed,
  allowedAccounts,
  clearSessionGrant,
  isGrantEnforced,
  loadGrantsFile,
  resetGrantsFileCache,
  resolveGrantByCode,
  resolveGrantByName,
  runWithGrant,
  setSessionGrant,
  codeSha8,
  grantStatusSummary,
  jwtAccessGrantGate,
  hostedSetGrantRefusal,
  activeGrant,
  grantDigest,
  grantFromEnvFallback,
  staticBearerGrant,
} from '../src/session-grant.js';

// ACCOUNTS come from process env at module load — setup.ts / env must define them.
// tests/setup.ts should set GOOGLE_ACCOUNTS; we only control grants path here.

describe('session-grant', () => {
  let dir: string;
  let grantsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gmulti-grants-'));
    grantsPath = path.join(dir, 'grants.json');
    process.env.GOOGLE_GRANTS_PATH = grantsPath;
    // Enable auto-detect from file for these tests (setup.ts defaults enforce off).
    delete process.env.GOOGLE_GRANTS_ENFORCE;
    delete process.env.GOOGLE_GRANT_CODE;
    clearSessionGrant();
    resetGrantsFileCache();
  });

  afterEach(() => {
    clearSessionGrant();
    resetGrantsFileCache();
    delete process.env.GOOGLE_GRANTS_PATH;
    delete process.env.GOOGLE_GRANTS_ENFORCE;
    delete process.env.GOOGLE_GRANT_CODE;
    delete process.env.MCP_HTTP_TOKEN_GRANT;
    delete process.env.MCP_HOSTED;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeGrants(accountsMap: Record<string, string[]>) {
    const grants = Object.entries(accountsMap).map(([name, accounts], i) => ({
      name,
      code: `grant-code-${i}-${name.replace(/\s+/g, '_')}`,
      accounts,
    }));
    writeFileSync(
      grantsPath,
      JSON.stringify({ version: 1, grants }, null, 2),
      'utf8',
    );
    resetGrantsFileCache();
  }

  it('does not enforce when grants file missing', () => {
    expect(loadGrantsFile()).toBeNull();
    expect(isGrantEnforced()).toBe(false);
    expect(() => allowedAccounts()).not.toThrow();
  });

  it('enforces when grants file present', () => {
    // setup.ts sets GOOGLE_ACCOUNTS=test:test@example.com
    writeGrants({ StrombackBrain2: ['test'] });
    expect(isGrantEnforced()).toBe(true);
    expect(() => allowedAccounts()).toThrow(/No session grant/);
  });

  it('set_grant scopes accounts', () => {
    writeGrants({
      'Personal Brain Grant 3': ['test'],
      StrombackBrain2: ['test'],
    });
    const st = setSessionGrant('grant-code-1-StrombackBrain2', 'stromback');
    expect(st.name).toBe('StrombackBrain2');
    expect(st.accounts).toEqual(['test']);
    expect(allowedAccounts()).toEqual(['test']);
    expect(() => assertAccountAllowed('test')).not.toThrow();
  });

  it('rejects unknown codes', () => {
    writeGrants({ StrombackBrain2: ['test'] });
    expect(() => setSessionGrant('not-a-real-code')).toThrow(/not recognized/);
  });

  it('GOOGLE_GRANTS_ENFORCE=false disables enforcement', () => {
    writeGrants({ StrombackBrain2: ['test'] });
    process.env.GOOGLE_GRANTS_ENFORCE = 'false';
    expect(isGrantEnforced()).toBe(false);
  });

  it('grant_status reports code_sha8, never a prefix, including codes of 12 characters or fewer', () => {
    writeGrants({ StrombackBrain2: ['test'] });
    const full = 'grant-code-0-StrombackBrain2';
    setSessionGrant(full);
    const s = grantStatusSummary();
    expect(s.authenticated).toBe(true);
    expect(s.code_sha8).toBe(codeSha8(full));
    expect(s.code_sha8).toHaveLength(8);
    expect(s.code_sha8).toMatch(/^[0-9a-f]{8}$/);
    expect(full.startsWith(s.code_sha8!)).toBe(false);
    expect(JSON.stringify(s)).not.toContain(full);
    expect(JSON.stringify(s)).not.toContain('code_prefix');
    expect(s.accounts).toEqual(['test']);

    const short = '123456789012';
    expect(short).toHaveLength(12);
    const hash = codeSha8(short);
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(short.startsWith(hash)).toBe(false);
    expect(short.includes(hash)).toBe(false);
  });

  it('load rejects a short code or a code equal to the grant name, and the message omits the code', () => {
    const short = '123456789012';
    writeFileSync(
      grantsPath,
      JSON.stringify({ version: 1, grants: [{ name: 'StrombackBrain2', code: short, accounts: ['test'] }] }),
      'utf8',
    );
    resetGrantsFileCache();
    expect(() => loadGrantsFile()).toThrow(/Grant "StrombackBrain2" is refused/);
    try {
      loadGrantsFile();
      expect.unreachable();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).not.toContain(short);
    }

    const name = 'Grant Alpha Example Name XX';
    const same = name.toLowerCase();
    expect(same.length).toBeGreaterThanOrEqual(24);
    expect(same).not.toBe(name);
    writeFileSync(
      grantsPath,
      JSON.stringify({ version: 1, grants: [{ name, code: same, accounts: ['test'] }] }),
      'utf8',
    );
    resetGrantsFileCache();
    expect(() => loadGrantsFile()).toThrow(new RegExp(`Grant "${name}" is refused`));
    try {
      loadGrantsFile();
      expect.unreachable();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain(name);
      expect(message).not.toContain(same);
    }
  });

  it('hosted fails closed on a refused grant even when enforcement is off', () => {
    const short = '123456789012';
    writeFileSync(
      grantsPath,
      JSON.stringify({ version: 1, grants: [{ name: 'StrombackBrain2', code: short, accounts: ['test'] }] }),
      'utf8',
    );
    resetGrantsFileCache();
    process.env.MCP_HOSTED = '1';
    process.env.GOOGLE_GRANTS_ENFORCE = 'false';
    process.env.GOOGLE_GRANT_CODE = short;
    expect(grantFromEnvFallback()).toBeNull();
    try {
      allowedAccounts();
      expect.unreachable();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toMatch(/Grant "StrombackBrain2" is refused/);
      expect(message).not.toContain(short);
    }
  });

  it('resolveGrantByName restores a slice without the code (JWT replica path)', () => {
    writeGrants({ StrombackBrain2: ['test'] });
    clearSessionGrant();
    expect(() => allowedAccounts()).toThrow(/No session grant/);
    const g = resolveGrantByName('StrombackBrain2');
    expect(g?.name).toBe('StrombackBrain2');
    expect(g?.source).toBe('token');
    expect(g?.code).toBe('');
    runWithGrant(g, () => {
      expect(allowedAccounts()).toEqual(['test']);
      expect(grantStatusSummary().source).toBe('token');
    });
    // After the request, in-process memory is still empty (multi-instance).
    expect(() => allowedAccounts()).toThrow(/No session grant/);
  });

  it('unknown grant name fails closed', () => {
    writeGrants({ StrombackBrain2: ['test'] });
    expect(resolveGrantByName('Not A Real Grant')).toBeNull();
    runWithGrant(null, () => {
      expect(() => allowedAccounts()).toThrow(/No session grant/);
    });
  });

  it('jwtAccessGrantGate fails at the /mcp gate when enforced JWT lacks resolvable gname', () => {
    writeGrants({ StrombackBrain2: ['test'] });
    expect(jwtAccessGrantGate(undefined, null)?.error).toBe('grant_required');
    expect(jwtAccessGrantGate('', null)?.error).toBe('grant_required');
    expect(jwtAccessGrantGate('Not A Real Grant', null)?.error).toBe('grant_unknown');
    const g = resolveGrantByName('StrombackBrain2');
    expect(g).not.toBeNull();
    expect(jwtAccessGrantGate('StrombackBrain2', g)).toBeNull();
    process.env.GOOGLE_GRANTS_ENFORCE = 'false';
    expect(jwtAccessGrantGate(undefined, null)).toBeNull();
    expect(jwtAccessGrantGate('Nope', null)).toBeNull();
  });

  it('ALS isolates token restore from in-process set_grant (second replica)', () => {
    writeGrants({ StrombackBrain2: ['test'] });
    setSessionGrant('grant-code-0-StrombackBrain2');
    expect(activeGrant()?.source).toBe('session');
    expect(allowedAccounts()).toEqual(['test']);

    const tokenSlice = resolveGrantByName('StrombackBrain2');
    expect(tokenSlice?.code).toBe('');
    runWithGrant(tokenSlice, () => {
      expect(activeGrant()?.source).toBe('token');
      expect(grantStatusSummary().source).toBe('token');
      expect(allowedAccounts()).toEqual(['test']);
    });
    // Same process still has the session grant after ALS ends.
    expect(activeGrant()?.source).toBe('session');

    // JWT request with no resolvable grant must not inherit process memory.
    runWithGrant(null, () => {
      expect(activeGrant()).toBeNull();
      expect(() => allowedAccounts()).toThrow(/No session grant/);
    });
    expect(allowedAccounts()).toEqual(['test']);

    // Second replica: no ALS, empty process session.
    clearSessionGrant();
    expect(activeGrant()).toBeNull();
    expect(() => allowedAccounts()).toThrow(/No session grant/);
  });

  it('staticBearerGrant is null unless MCP_HTTP_TOKEN_GRANT names a grant', () => {
    writeGrants({ 'stromback-test': ['test'], 'Personal Brain Grant 3': ['test'] });
    delete process.env.MCP_HTTP_TOKEN_GRANT;
    expect(staticBearerGrant()).toBeNull();
    process.env.MCP_HTTP_TOKEN_GRANT = '   ';
    expect(staticBearerGrant()).toBeNull();
    process.env.MCP_HTTP_TOKEN_GRANT = 'missing-grant';
    expect(staticBearerGrant()).toBeNull();
    process.env.MCP_HTTP_TOKEN_GRANT = 'stromback-test';
    const bound = staticBearerGrant();
    expect(bound?.name).toBe('stromback-test');
    expect(bound?.accounts).toEqual(['test']);
    expect(bound?.code).toBe('');
  });

  it('resolveGrantByCode and the env lookup compare every grant with timingSafeEqual', () => {
    writeGrants({
      StrombackBrain2: ['test'],
      'Personal Brain Grant 3': ['test'],
      'stromback-test': ['test'],
    });
    const grants = loadGrantsFile();
    expect(grants?.grants).toHaveLength(3);
    const first = 'grant-code-0-StrombackBrain2';
    const spy = vi.spyOn(grantDigest, 'timingSafeEqual');
    try {
      spy.mockClear();
      const byCode = resolveGrantByCode(first);
      expect(byCode?.name).toBe('StrombackBrain2');
      expect(spy).toHaveBeenCalledTimes(grants!.grants.length);

      clearSessionGrant();
      delete process.env.MCP_HOSTED;
      process.env.GOOGLE_GRANT_CODE = first;
      spy.mockClear();
      const byEnv = grantFromEnvFallback();
      expect(byEnv?.name).toBe('StrombackBrain2');
      expect(byEnv?.source).toBe('env');
      expect(spy).toHaveBeenCalledTimes(grants!.grants.length);
    } finally {
      spy.mockRestore();
    }
  });

  it('desk GOOGLE_GRANT_CODE still applies outside a request', () => {
    writeGrants({ StrombackBrain2: ['test'] });
    process.env.GOOGLE_GRANT_CODE = 'grant-code-0-StrombackBrain2';
    expect(activeGrant()?.source).toBe('env');
    expect(allowedAccounts()).toEqual(['test']);
    expect(grantFromEnvFallback()?.name).toBe('StrombackBrain2');
  });

  it('hosted activeGrant ignores in-process set_grant and GOOGLE_GRANT_CODE', () => {
    writeGrants({ StrombackBrain2: ['test'] });
    process.env.MCP_HOSTED = '1';
    setSessionGrant('grant-code-0-StrombackBrain2');
    process.env.GOOGLE_GRANT_CODE = 'grant-code-0-StrombackBrain2';
    expect(grantFromEnvFallback()).toBeNull();
    expect(activeGrant()).toBeNull();
    expect(grantStatusSummary().authenticated).toBe(false);
    expect(grantStatusSummary().accounts).toEqual([]);
    expect(() => allowedAccounts()).toThrow(/No session grant/);
    runWithGrant(resolveGrantByName('StrombackBrain2'), () => {
      expect(activeGrant()?.name).toBe('StrombackBrain2');
      expect(allowedAccounts()).toEqual(['test']);
    });
    expect(activeGrant()).toBeNull();
  });

  it('hostedSetGrantRefusal is set only when hosted', () => {
    const prevH = process.env.MCP_HOSTED;
    const prevK = process.env.K_SERVICE;
    try {
      delete process.env.MCP_HOSTED;
      delete process.env.K_SERVICE;
      expect(hostedSetGrantRefusal()).toBeNull();
      process.env.MCP_HOSTED = '1';
      expect(hostedSetGrantRefusal()).toMatch(/oauth\/authorize/);
      expect(hostedSetGrantRefusal()).toMatch(/gname/);
      expect(hostedSetGrantRefusal()).not.toMatch(/grant_code=\w{8}/);
      delete process.env.MCP_HOSTED;
      process.env.K_SERVICE = 'google-multi-mcp';
      expect(hostedSetGrantRefusal()).toMatch(/does not survive Cloud Run/);
      process.env.MCP_HOSTED = '0';
      expect(hostedSetGrantRefusal()).toBeNull();
    } finally {
      if (prevH === undefined) delete process.env.MCP_HOSTED;
      else process.env.MCP_HOSTED = prevH;
      if (prevK === undefined) delete process.env.K_SERVICE;
      else process.env.K_SERVICE = prevK;
    }
  });
});
