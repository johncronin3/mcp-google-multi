import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../src/compose.js';
import type { IdentityContext } from '../src/identity.js';
import { isAllowed, privilegeOf, type Policy } from '../src/write-control.js';
import type { Cud } from '../src/registry.js';
import { accountSet, fakeServer } from './_tool-harness.js';

/**
 * House safe-writes before #299: create and update only. Trash moves were
 * deletes and stayed denied. Grants do not select a profile; the house
 * default (GOOGLE_PROFILE unset) is read-only.
 */
const GRANT_POLICY: Policy = { profile: 'read-only', readOnly: false, allow: [], deny: [] };

const TRASH = [
  { name: 'gmail_trash', service: 'gmail', cud: 'delete' as const },
  { name: 'drive_trash', service: 'drive', cud: 'delete' as const },
  { name: 'gmail_users_threads_trash', service: 'gmail', cud: 'delete' as const },
];

/** Wider-brain aliases. StrombackBrain2 is stromback only. */
const COSMOS_ALIASES = ['personal', 'opcenter', 'buildcoin'] as const;

interface ToolRef {
  name: string;
  service: string;
  cud: Cud;
  scopes?: readonly string[];
  destructiveHint: boolean;
}

function allowedBefore(tool: { name: string; service: string; cud: Cud; scopes?: readonly string[] }, policy: Policy): boolean {
  if (tool.cud === 'read') return true;
  if (policy.readOnly) return false;
  if (policy.profile === 'full-writes') return true;
  if (policy.profile === 'safe-writes') {
    if (privilegeOf(tool) !== undefined) return false;
    return tool.cud === 'create' || tool.cud === 'update';
  }
  return false;
}

function loadGrants(): { name: string; accounts: string[] }[] {
  const raw = JSON.parse(readFileSync(path.join(process.cwd(), 'grants.example.json'), 'utf8')) as {
    grants: { name: string; code: string; accounts: string[] }[];
  };
  for (const grant of raw.grants) {
    expect(grant.code).toBe('REPLACE_WITH_HOST_LOCAL_CODE');
  }
  return raw.grants.map((grant) => ({ name: grant.name, accounts: [...grant.accounts] }));
}

function registeredTools(): ToolRef[] {
  const accounts = accountSet(
    {
      personal: { email: 'personal@example.com' },
      stromback: { email: 'stromback@example.com' },
      opcenter: { email: 'opcenter@example.com' },
      buildcoin: { email: 'buildcoin@example.com' },
    },
    { defaultAccount: 'personal' },
  );
  const ctx = {
    subject: 'grant-allow-test',
    accounts,
    policy: GRANT_POLICY,
    getClient: async () => ({ request: async () => ({ data: {} }) }),
    tokenStore: {
      readToken: () => null,
      writeToken: () => undefined,
      updateToken: () => undefined,
      hasToken: () => false,
    },
  } as unknown as IdentityContext;
  const { server } = fakeServer();
  const registry = buildRegistry(server as never, ctx, 'eager');
  return registry.tools.map((tool) => ({
    name: tool.name,
    service: tool.service,
    cud: tool.cud,
    scopes: tool.requiredScopes,
    destructiveHint: tool.annotations.destructiveHint === true,
  }));
}

describe('per-grant allowed tools before and after upstream 6.0.1', () => {
  const tools = registeredTools();
  const grants = loadGrants();

  it('Cosmos-related aliases stay on Personal Brain Grant 3 only', () => {
    const pbg3 = grants.find((g) => g.name === 'Personal Brain Grant 3');
    const stromback = grants.find((g) => g.name === 'StrombackBrain2');
    expect(pbg3?.accounts).toEqual(['personal', 'stromback', 'opcenter', 'buildcoin']);
    expect(stromback?.accounts).toEqual(['stromback']);
    for (const alias of COSMOS_ALIASES) {
      expect(pbg3?.accounts).toContain(alias);
      expect(stromback?.accounts).not.toContain(alias);
    }
    for (const grant of grants) {
      for (const alias of grant.accounts) {
        if (/cosmos/i.test(alias)) {
          expect(grant.name).toBe('Personal Brain Grant 3');
        }
      }
    }
  });

  it('neither grant allows more tools than it did before the merge', () => {
    const before = tools.filter((tool) => allowedBefore(tool, GRANT_POLICY)).map((tool) => tool.name).sort();
    const after = tools.filter((tool) => isAllowed(tool, GRANT_POLICY)).map((tool) => tool.name).sort();
    expect(after).toEqual(before);
    const added = after.filter((name) => !before.includes(name));
    expect(added).toEqual([]);

    for (const grant of grants) {
      expect(grant.name === 'Personal Brain Grant 3' || grant.name === 'StrombackBrain2').toBe(true);
      // The grant slices accounts. It does not widen write-control, so both
      // grants share this allow-set and neither gained a tool.
      expect(after.filter((name) => !before.includes(name))).toEqual([]);
      for (const trash of TRASH) {
        expect(isAllowed(trash, GRANT_POLICY), `${grant.name} ${trash.name}`).toBe(false);
        expect(allowedBefore(trash, GRANT_POLICY), `${grant.name} ${trash.name} before`).toBe(false);
      }
    }
  });

  it('Trash stays denied for both grants, and newly destructive create/send tools are not newly allowed', () => {
    const creates = tools.filter((tool) => tool.cud === 'create' || /_send(_|$)/.test(tool.name));
    expect(creates.length).toBeGreaterThan(0);
    const newlyDestructive = creates.filter((tool) => tool.destructiveHint && tool.cud !== 'delete' && tool.cud !== 'update');
    expect(newlyDestructive.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'gmail_send',
      'gmail_create_draft',
      'calendar_create_event',
      'drive_upload',
    ]));
    for (const grant of ['Personal Brain Grant 3', 'StrombackBrain2']) {
      for (const tool of newlyDestructive) {
        expect(isAllowed(tool, GRANT_POLICY), `${grant} ${tool.name}`).toBe(false);
        expect(allowedBefore(tool, GRANT_POLICY), `${grant} ${tool.name} before`).toBe(false);
      }
      for (const trash of TRASH) {
        expect(isAllowed(trash, GRANT_POLICY), `${grant} ${trash.name}`).toBe(false);
      }
    }
    // #299 allows those three Trash moves only under safe-writes. That profile
    // is not what either grant runs. Permanent deletes stay denied there too.
    const safe: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };
    for (const trash of TRASH) {
      expect(allowedBefore(trash, safe)).toBe(false);
      expect(isAllowed(trash, safe)).toBe(true);
    }
    const permanent = ['gmail_delete', 'drive_delete', 'drive_empty_trash', 'gmail_batch_delete'];
    for (const name of permanent) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool, name).toBeTruthy();
      expect(isAllowed(tool!, safe)).toBe(false);
      expect(allowedBefore(tool!, safe)).toBe(false);
      expect(isAllowed(tool!, GRANT_POLICY)).toBe(false);
    }
  });
});
