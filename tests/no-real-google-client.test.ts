import { describe, expect, it } from 'vitest';
import { GUARD_MESSAGE } from './setup/no-real-google-clients.js';

describe('no real Google or Secret Manager client', () => {
  it('constructing a real Gmail client or Secret Manager client is refused', async () => {
    const { gmail } = await import('@googleapis/gmail');
    expect(() => gmail({ version: 'v1' })).toThrow(new RegExp(GUARD_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
    expect(() => new SecretManagerServiceClient()).toThrow(/Real Google or Secret Manager client used in tests/);
  });
});
