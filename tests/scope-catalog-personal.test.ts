import { describe, it, expect } from 'vitest';
import { BUNDLE_CATALOG, isPersonalGoogleAddress, refusedBundlesFor } from '../src/scope-catalog.js';

describe('personal-account bundle refusals', () => {
  it('only gmail.com and googlemail.com count as personal addresses', () => {
    for (const e of ['a@gmail.com', 'A@GMAIL.COM', ' a@googlemail.com ']) expect(isPersonalGoogleAddress(e), e).toBe(true);
    for (const e of ['a@example.com', 'a@gmail.com.example.com', 'gmail.com@example.com', 'a@mail.gmail.co']) expect(isPersonalGoogleAddress(e), e).toBe(false);
  });

  it('keep and cloudidentity are the refused bundles, and only for a personal address', () => {
    const all = Object.keys(BUNDLE_CATALOG);
    expect(refusedBundlesFor('a@gmail.com', all).sort()).toEqual(['cloudidentity', 'keep']);
    expect(refusedBundlesFor('a@example.com', all)).toEqual([]);
    expect(refusedBundlesFor('a@gmail.com', ['forms', 'toString', 'nope'])).toEqual([]);
  });
});
