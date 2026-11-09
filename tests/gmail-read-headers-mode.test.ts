import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult } from './_tool-harness.js';

function metaResponseFor(id: string) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'Subject', value: `subject-${id}` },
        { name: 'From', value: 'alice@example.com' },
      ],
    },
  };
}

function idFromUrl(url: string): string {
  return url.split('/messages/').pop() ?? '';
}

describe('gmail_read headers metadata mode', () => {
  it('fetches format=metadata with the requested metadataHeaders', async () => {
    const h = toolHarness({
      requestImpl: async (req) => {
        expect(req.params).toMatchObject({ format: 'metadata', metadataHeaders: ['Subject', 'From'] });
        return { data: metaResponseFor('m1'), headers: new Headers(), status: 200 };
      },
    });
    await h.call('gmail_read', { account: 'test', messageId: 'm1', headers: ['Subject', 'From'] });
  });

  it('returns only id, threadId, labelIds and the requested headers (no body)', async () => {
    const h = toolHarness({ respond: (req) => metaResponseFor(idFromUrl(req.url)) });
    const res = await h.call('gmail_read', { account: 'test', messageId: 'm1', headers: ['Subject', 'From'] });
    const out = parseResult(res);
    expect(out).toEqual({
      id: 'm1',
      threadId: 't-m1',
      labelIds: ['INBOX'],
      headers: { Subject: 'subject-m1', From: 'alice@example.com' },
    });
  });

  it('falls back to a full body read when headers is omitted', async () => {
    const h = toolHarness({
      respond: () => ({
        id: 'm1',
        threadId: 't1',
        payload: { mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64url') }, headers: [] },
      }),
    });
    const res = await h.call('gmail_read', { account: 'test', messageId: 'm1' });
    const out = parseResult(res);
    expect(out.body).toBe('hi');
  });
});

describe('gmail_read_batch headers metadata mode', () => {
  it('reads each id in metadata mode, returning labelIds and the requested headers', async () => {
    const h = toolHarness({ respond: (req) => metaResponseFor(idFromUrl(req.url)) });
    const res = await h.call('gmail_read_batch', { account: 'test', ids: ['m1', 'm2'], headers: ['Subject'] });
    const out = parseResult(res);
    expect(out[0]).toEqual({ id: 'm1', threadId: 't-m1', labelIds: ['INBOX'], headers: { Subject: 'subject-m1' } });
    expect(out[1]).toEqual({ id: 'm2', threadId: 't-m2', labelIds: ['INBOX'], headers: { Subject: 'subject-m2' } });
    expect(out[2]).toMatchObject({ counts: { ok: 2, failed: 0 } });
  });

  it('does not decode bodies in metadata mode', async () => {
    const h = toolHarness({ respond: (req) => metaResponseFor(idFromUrl(req.url)) });
    const res = await h.call('gmail_read_batch', { account: 'test', ids: ['m1'], headers: ['Subject'] });
    const out = parseResult(res);
    expect(out[0]).not.toHaveProperty('body');
  });
});
