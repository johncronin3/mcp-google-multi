import { describe, it, expect } from 'vitest';
import { isAllowed, type Policy } from '../src/write-control.js';
import { accountSet, toolHarness, parseResult } from './_tool-harness.js';

// safe-writes treats a move to Trash like any other non-privileged write,
// because the owner can still recover the item; every other delete,
// including emptying Trash, stays refused.

const S = (n: string) => `https://www.googleapis.com/auth/${n}`;
const safe: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };

describe('safe-writes: privileged scope beats the Trash exception', () => {
  it('gmail_trash with a privileged scope is refused', () => {
    const gmail_trash_with_admin = {
      name: 'gmail_trash',
      service: 'gmail',
      cud: 'delete' as const,
      scopes: [S('admin.directory.users')],
    };
    expect(isAllowed(gmail_trash_with_admin, safe)).toBe(false);
  });
});

describe('safe-writes: moving to Trash is permitted', () => {
  it('gmail_trash succeeds', async () => {
    const h = toolHarness({ policy: { profile: 'safe-writes' }, respond: () => ({ id: 'm1' }) });
    const res = await h.call('gmail_trash', { messageId: 'm1' });
    expect(res.isError).toBeFalsy();
    expect(h.requests()[0]?.url).toContain('/messages/m1/trash');
  });

  it('drive_trash succeeds', async () => {
    const h = toolHarness({ policy: { profile: 'safe-writes' }, respond: () => ({ id: 'f1', trashed: true }) });
    const res = await h.call('drive_trash', { fileId: 'f1' });
    expect(res.isError).toBeFalsy();
    expect(parseResult(res)).toEqual({ trashed: true, fileId: 'f1' });
  });

  it('the generated gmail.users.threads.trash twin succeeds', async () => {
    const h = toolHarness({ policy: { profile: 'safe-writes' }, respond: () => ({ id: 't1' }) });
    const res = await h.call('gmail_users_threads_trash', { id: 't1', userId: 'me' });
    expect(res.isError).toBeFalsy();
    expect(h.requests()[0]?.url).toContain('/threads/t1/trash');
  });

  it('untrash was already permitted (plain update) and still is', async () => {
    const h = toolHarness({ policy: { profile: 'safe-writes' }, respond: () => ({ id: 'f1', trashed: false }) });
    const res = await h.call('drive_untrash', { fileId: 'f1' });
    expect(res.isError).toBeFalsy();
  });
});

describe('safe-writes: every permanent delete still refused', () => {
  const permanentDeletes: [string, Record<string, unknown>][] = [
    ['gmail_delete', { messageId: 'm1' }],
    ['gmail_batch_delete', { messageIds: ['m1', 'm2'] }],
    ['drive_delete', { fileId: 'f1' }],
    ['drive_empty_trash', {}],
    ['tasks_delete', { tasklistId: 'l1', taskId: 't1' }],
    ['gmail_users_threads_delete', { id: 't1', userId: 'me' }],
  ];

  for (const [name, args] of permanentDeletes) {
    it(`${name} stays write_disabled`, async () => {
      const h = toolHarness({ policy: { profile: 'safe-writes' } });
      const res = await h.call(name, args);
      expect(res.isError).toBe(true);
      expect(parseResult(res).error).toBe('write_disabled');
      expect(h.requests()).toHaveLength(0);
    });
  }

  it("drive_transfer's move flag is still delete-gated, not swept in by the Trash exception", async () => {
    const accounts = accountSet({ src: { email: 'src@example.com' }, dst: { email: 'dst@example.com' } });
    const h = toolHarness({ policy: { profile: 'safe-writes' }, accounts, respond: () => ({ id: 'f1', name: 'doc' }) });
    const res = await h.call('drive_transfer', { fromAccount: 'src', toAccount: 'dst', fileId: 'f1', move: true });
    expect(parseResult(res).hint).toMatch(/GOOGLE_PROFILE=full-writes/);
  });
});
