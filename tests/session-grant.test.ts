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
  setSessionGrant,
  grantStatusSummary,
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
});
