import { describe, it, expect } from 'vitest';
import { resolveContacts, type ResolveCandidate } from '../src/tools/contacts.js';

function cand(p: Partial<ResolveCandidate> & { displayName: string; email?: string }): ResolveCandidate {
  return {
    resourceName: p.resourceName ?? `people/${p.displayName}-${p.email ?? 'x'}`,
    displayName: p.displayName,
    source: p.source ?? 'contacts',
    emails: p.emails ?? (p.email ? [{ value: p.email }] : []),
    hasOrg: p.hasOrg ?? false,
  };
}

describe('resolveContacts tie-break', () => {
  it('exact name beats prefix match', () => {
    const out = resolveContacts(
      [cand({ displayName: 'Zoey', email: 'zoey@x.com' }), cand({ displayName: 'Zoe', email: 'zoe@x.com' })],
      'Zoe', 5,
    );
    expect(out.resolved?.email).toBe('zoe@x.com');
    expect(out.ambiguous).toBeUndefined();
  });

  it('accent-folds the name comparison (Zoë == Zoe)', () => {
    const out = resolveContacts(
      [cand({ displayName: 'Zoë', email: 'accent@x.com' }), cand({ displayName: 'Zoey', email: 'p@x.com' })],
      'Zoe', 5,
    );
    expect(out.resolved?.email).toBe('accent@x.com');
  });

  it('saved connection beats an other-contact when names tie', () => {
    const out = resolveContacts(
      [
        cand({ displayName: 'Zoe', email: 'other@x.com', source: 'otherContacts' }),
        cand({ displayName: 'Zoe', email: 'saved@x.com', source: 'contacts' }),
      ],
      'Zoe', 5,
    );
    expect(out.resolved?.email).toBe('saved@x.com');
    expect(out.resolved?.source).toBe('contacts');
  });

  it('returns ambiguous (capped) when a real tie survives all rules', () => {
    const out = resolveContacts(
      [
        cand({ displayName: 'Zoe', email: 'zoe1@x.com' }),
        cand({ displayName: 'Zoe', email: 'zoe2@x.com' }),
        cand({ displayName: 'Zoe', email: 'zoe3@x.com' }),
      ],
      'Zoe', 2,
    );
    expect(out.ambiguous).toBe(true);
    expect(out.candidates).toHaveLength(2); // capped to maxCandidates
    expect(out.resolved).toBeUndefined();
  });

  it('recall: an other-contact-only match still resolves', () => {
    const out = resolveContacts(
      [cand({ displayName: 'Dana', email: 'dana@acme.example', source: 'otherContacts' })],
      'Dana', 5,
    );
    expect(out.resolved?.email).toBe('dana@acme.example');
    expect(out.resolved?.source).toBe('otherContacts');
  });

  it('picks the primary email within a chosen contact (else type order)', () => {
    const out = resolveContacts(
      [cand({ displayName: 'Zoe', emails: [
        { value: 'home@x.com', type: 'home' },
        { value: 'canon@x.com', primary: true },
        { value: 'work@x.com', type: 'work' },
      ] })],
      'Zoe', 5,
    );
    expect(out.resolved?.email).toBe('canon@x.com');
  });

  it('no candidates → resolved:null (not an error)', () => {
    expect(resolveContacts([], 'Nobody', 5)).toEqual({ query: 'Nobody', resolved: null });
  });

  it('candidates with no email are dropped → resolved:null', () => {
    const out = resolveContacts([cand({ displayName: 'Zoe', emails: [] })], 'Zoe', 5);
    expect(out).toEqual({ query: 'Zoe', resolved: null });
  });

  it('a fuller record (has org) breaks a name/source tie', () => {
    const out = resolveContacts(
      [
        cand({ displayName: 'Zoe', email: 'bare@x.com' }),
        cand({ displayName: 'Zoe', email: 'full@x.com', hasOrg: true }),
      ],
      'Zoe', 5,
    );
    expect(out.resolved?.email).toBe('full@x.com');
  });
});
