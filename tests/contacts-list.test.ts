import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult } from './_tool-harness.js';

const person = (resourceName: string, opts: { name?: string; email?: string } = {}) => ({
  resourceName,
  names: opts.name ? [{ displayName: opts.name }] : [],
  emailAddresses: opts.email ? [{ value: opts.email }] : [],
});

describe('contacts_list', () => {
  it('defaults pageSize to 50', async () => {
    const h = toolHarness({ respond: () => ({ connections: [] }) });
    await h.call('contacts_list', { account: 'test' });
    const req = h.requests()[0];
    expect(req.params?.pageSize).toBe(50);
  });

  it('requireEmail drops contacts with no email, after the API call', async () => {
    const h = toolHarness({
      respond: () => ({
        connections: [
          person('people/c1', { name: 'Has Email', email: 'a@b.com' }),
          person('people/c2', { name: 'No Email' }),
        ],
      }),
    });
    const res = await h.call('contacts_list', { account: 'test', requireEmail: true });
    const out = parseResult(res);
    expect(out.contacts.map((c: { resourceName: string }) => c.resourceName)).toEqual(['people/c1']);
  });

  it('requireName drops contacts with no name', async () => {
    const h = toolHarness({
      respond: () => ({
        connections: [
          person('people/c1', { name: 'Has Name' }),
          person('people/c2', { email: 'b@c.com' }),
        ],
      }),
    });
    const res = await h.call('contacts_list', { account: 'test', requireName: true });
    const out = parseResult(res);
    expect(out.contacts.map((c: { resourceName: string }) => c.resourceName)).toEqual(['people/c1']);
  });

  it('applies no filter by default', async () => {
    const h = toolHarness({
      respond: () => ({
        connections: [person('people/c1'), person('people/c2', { name: 'X' })],
      }),
    });
    const res = await h.call('contacts_list', { account: 'test' });
    const out = parseResult(res);
    expect(out.contacts).toHaveLength(2);
  });
});
