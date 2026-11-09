import { describe, it, expect } from 'vitest';
import { toolHarness } from './_tool-harness.js';

describe('gmail_search includeSpamTrash', () => {
  it('forwards includeSpamTrash:true to messages.list', async () => {
    const h = toolHarness({ respond: () => ({ messages: [] }) });
    await h.call('gmail_search', { account: 'test', query: 'is:unread', includeSpamTrash: true });
    const req = h.requests().find((r) => r.url.includes('/messages'));
    expect(req?.params).toMatchObject({ includeSpamTrash: true });
  });

  it('omits includeSpamTrash when not passed', async () => {
    const h = toolHarness({ respond: () => ({ messages: [] }) });
    await h.call('gmail_search', { account: 'test', query: 'is:unread' });
    const req = h.requests().find((r) => r.url.includes('/messages'));
    expect(req?.params).not.toHaveProperty('includeSpamTrash');
  });
});
