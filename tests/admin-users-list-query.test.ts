import { describe, it, expect } from 'vitest';
import { toolHarness, accountSet } from './_tool-harness.js';

const WITH_ADMIN = () => accountSet({ test: { email: 'test@harness.example', admin: true } }, { defaultAccount: 'test' });

describe('admin_users_list query field description', () => {
  it('documents the Directory query fields and the prefix-wildcard rule', () => {
    const h = toolHarness({ accounts: WITH_ADMIN() });
    const description = h.schemas.admin_users_list.query?.description ?? '';
    for (const field of ['email', 'name', 'givenName', 'familyName', 'isAdmin', 'orgName', 'orgTitle']) {
      expect(description, field).toContain(field);
    }
    expect(description).toContain('email:admin*');
    expect(description).toMatch(/prefix|wildcard/i);
  });
});
