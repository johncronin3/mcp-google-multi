import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult } from './_tool-harness.js';

describe('gmail_delete_draft', () => {
  it('deletes the draft and returns {deleted:true, draftId}', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('gmail_delete_draft', { account: 'test', draftId: 'd1' });
    const req = h.requests().find((r) => r.url.includes('/drafts/'));
    expect(req?.method).toBe('DELETE');
    expect(req?.url).toContain('/drafts/d1');
    expect(parseResult(res)).toEqual({ deleted: true, draftId: 'd1' });
  });

  it('is refused under a read-only write-control policy', async () => {
    const h = toolHarness({ policy: { readOnly: true } });
    const res = await h.call('gmail_delete_draft', { account: 'test', draftId: 'd1' });
    expect(res.isError).toBe(true);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('is refused under a safe-writes write-control policy', async () => {
    const h = toolHarness({ policy: { profile: 'safe-writes', readOnly: false, allow: [], deny: [] } });
    const res = await h.call('gmail_delete_draft', { account: 'test', draftId: 'd1' });
    expect(res.isError).toBe(true);
    expect(h.request).not.toHaveBeenCalled();
  });
});
