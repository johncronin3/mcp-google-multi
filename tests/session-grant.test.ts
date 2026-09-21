import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  resolveGrantByName,
  runWithGrant,
  setSessionGrant,
  grantStatusSummary,
  jwtAccessGrantGate,
  hostedSetGrantRefusal,
  activeGrant,
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
    rmSync(dir, { recursive: true, force: true });
  });

  function writeGrants(accountsMap: Record<string, string[]>) {
    const grants = Object.entries(accountsMap).map(([name, accounts], i) => ({
      name,
      code: `code_${i}_${name.replace(/\s+/g, '_')}`,
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
    const st = setSessionGrant('code_1_StrombackBrain2', 'stromback');
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

  it('grant_status reports prefix not full code', () => {
    writeGrants({ StrombackBrain2: ['test'] });
    const full = 'code_0_StrombackBrain2';
    setSessionGrant(full);
    const s = grantStatusSummary();
    expect(s.authenticated).toBe(true);
    expect(s.code_prefix).toBe(`${full.slice(0, 12)}…`);
    expect(s.code_prefix).not.toBe(full);
    expect(s.accounts).toEqual(['test']);
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
    setSessionGrant('code_0_StrombackBrain2');
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
