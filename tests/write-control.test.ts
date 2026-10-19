import { describe, it, expect, afterEach } from 'vitest';
import { resolvePolicy, isAllowed, describePolicy, writeDisabledResult, type Policy } from '../src/write-control.js';
import { setHintProvider, type HintCase } from '../src/hint-provider.js';
import type { Cud } from '../src/registry.js';

const tool = (name: string, cud: 'read' | 'create' | 'update' | 'delete') => ({
  name,
  service: name.slice(0, name.indexOf('_')),
  cud,
});

describe('resolvePolicy', () => {
  it('defaults to read-only, no globs', () => {
    expect(resolvePolicy({})).toEqual({ profile: 'read-only', readOnly: false, allow: [], deny: [], transport: 'stdio' });
  });
  it('parses profile, readOnly, and glob lists', () => {
    const p = resolvePolicy({
      GOOGLE_PROFILE: 'safe-writes',
      GOOGLE_READ_ONLY: 'true',
      GOOGLE_WRITE_ALLOW: 'calendar:*, sheets:update*',
      GOOGLE_WRITE_DENY: '*:delete*',
    });
    expect(p).toEqual({
      profile: 'safe-writes',
      readOnly: true,
      allow: ['calendar:*', 'sheets:update*'],
      deny: ['*:delete*'],
      transport: 'stdio',
    });
  });
  it('falls back to read-only on an invalid profile', () => {
    expect(resolvePolicy({ GOOGLE_PROFILE: 'bogus' }).profile).toBe('read-only');
  });

  // Transport is a reserved seam threaded into the policy.
  it('threads the transport (default stdio; http when passed)', () => {
    expect(resolvePolicy({}).transport).toBe('stdio');
    expect(resolvePolicy({}, { transport: 'http' }).transport).toBe('http');
    expect(resolvePolicy({}, { transport: 'stdio' }).transport).toBe('stdio');
  });

  it('transport does NOT change any write-control verdict (LOCKED annotations-only)', () => {
    const cases: Array<[string, 'read' | 'create' | 'update' | 'delete', NodeJS.ProcessEnv]> = [
      ['gmail_search', 'read', {}],
      ['gmail_send', 'create', { GOOGLE_PROFILE: 'safe-writes' }],
      ['drive_delete', 'delete', { GOOGLE_PROFILE: 'full-writes' }],
      ['drive_delete', 'delete', { GOOGLE_PROFILE: 'safe-writes' }],
      ['sheets_update', 'update', { GOOGLE_WRITE_DENY: 'sheets:*' }],
    ];
    for (const [name, cud, env] of cases) {
      const stdio = isAllowed(tool(name, cud), resolvePolicy(env, { transport: 'stdio' }));
      const http = isAllowed(tool(name, cud), resolvePolicy(env, { transport: 'http' }));
      expect(http).toBe(stdio);
    }
  });
});

describe('isAllowed', () => {
  const ro: Policy = { profile: 'read-only', readOnly: false, allow: [], deny: [] };
  const safe: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };
  const full: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };

  it('reads always pass, even read-only', () => {
    expect(isAllowed(tool('gmail_search', 'read'), ro)).toBe(true);
  });
  it('read-only denies all CUD', () => {
    expect(isAllowed(tool('gmail_send', 'create'), ro)).toBe(false);
    expect(isAllowed(tool('drive_delete', 'delete'), ro)).toBe(false);
  });
  it('safe-writes allows create+update, denies delete', () => {
    expect(isAllowed(tool('gmail_send', 'create'), safe)).toBe(true);
    expect(isAllowed(tool('drive_update', 'update'), safe)).toBe(true);
    expect(isAllowed(tool('drive_delete', 'delete'), safe)).toBe(false);
  });
  it('safe-writes allows the three Trash moves, by name, despite their delete cud', () => {
    expect(isAllowed(tool('gmail_trash', 'delete'), safe)).toBe(true);
    expect(isAllowed(tool('drive_trash', 'delete'), safe)).toBe(true);
    expect(isAllowed(tool('gmail_users_threads_trash', 'delete'), safe)).toBe(true);
  });
  it('safe-writes still denies every permanent delete, Trash included', () => {
    expect(isAllowed(tool('gmail_delete', 'delete'), safe)).toBe(false);
    expect(isAllowed(tool('gmail_batch_delete', 'delete'), safe)).toBe(false);
    expect(isAllowed(tool('drive_empty_trash', 'delete'), safe)).toBe(false);
    expect(isAllowed(tool('tasks_delete', 'delete'), safe)).toBe(false);
    expect(isAllowed(tool('gmail_users_threads_delete', 'delete'), safe)).toBe(false);
  });
  it('the Trash exception is matched by name, not by a bare delete+"trash" shape', () => {
    // drive_transfer's move flag self-checks a synthetic delete-cud ref named
    // drive_transfer_move; it must stay refused under safe-writes.
    expect(isAllowed({ name: 'drive_transfer_move', service: 'drive', cud: 'delete' }, safe)).toBe(false);
  });
  it('read-only still refuses the Trash moves', () => {
    expect(isAllowed(tool('gmail_trash', 'delete'), ro)).toBe(false);
    expect(isAllowed(tool('drive_trash', 'delete'), ro)).toBe(false);
  });
  it('full-writes allows everything', () => {
    expect(isAllowed(tool('drive_delete', 'delete'), full)).toBe(true);
  });
  it('GOOGLE_READ_ONLY beats any profile', () => {
    expect(isAllowed(tool('gmail_send', 'create'), { ...full, readOnly: true })).toBe(false);
  });
  it('deny glob wins over allow + profile', () => {
    const p: Policy = { profile: 'full-writes', readOnly: false, allow: ['drive:*'], deny: ['*:delete*'] };
    expect(isAllowed(tool('drive_delete', 'delete'), p)).toBe(false);
    expect(isAllowed(tool('drive_update', 'update'), p)).toBe(true);
  });
  it('allow glob opens a hole in a restrictive profile', () => {
    const p: Policy = { profile: 'read-only', readOnly: false, allow: ['calendar:*'], deny: [] };
    expect(isAllowed(tool('calendar_create_event', 'create'), p)).toBe(true);
    expect(isAllowed(tool('gmail_send', 'create'), p)).toBe(false);
  });
  it('allow matches by operation name (gmail:send)', () => {
    const p: Policy = { profile: 'read-only', readOnly: false, allow: ['gmail:send'], deny: [] };
    expect(isAllowed(tool('gmail_send', 'create'), p)).toBe(true);
  });
  it('precedence holds: readonly > deny > allow > profile', () => {
    expect(isAllowed(tool('gmail_send', 'create'), { profile: 'full-writes', readOnly: true, allow: ['*:*'], deny: [] })).toBe(false);
  });
});

describe('describePolicy', () => {
  it('renders a one-line summary', () => {
    expect(
      describePolicy({ profile: 'safe-writes', readOnly: false, allow: ['a:*'], deny: ['*:delete*'] }),
    ).toBe('profile=safe-writes readOnly=false allow=[a:*] deny=[*:delete*]');
  });
});

describe('writeDisabledResult hint provider routing', () => {
  afterEach(() => setHintProvider(null));

  function echo() {
    const seen: HintCase[] = [];
    setHintProvider({
      render: (c) => {
        seen.push(c);
        return { hint: `kind:${c.kind}`, message: `msg:${c.kind}` };
      },
    });
    return seen;
  }

  const expectRouted = (tool: { name: string; service: string; cud: Cud }, p: Policy, account?: string) => {
    const seen = echo();
    const envelope = JSON.parse(writeDisabledResult(tool, p, account).content[0].text) as { hint: string; message: string };
    expect(envelope.hint).toBe('kind:write_denied');
    expect(envelope.message).toBe('msg:write_denied');
    expect(seen).toHaveLength(1);
    return seen[0] as { kind: 'write_denied'; tool: typeof tool; reason: unknown; policy: Policy };
  };

  it('rule read_only renders write_denied with reason.rule = read_only', () => {
    const c = expectRouted(tool('gmail_send', 'create'), { profile: 'full-writes', readOnly: true, allow: [], deny: [] });
    expect(c.reason).toEqual({ rule: 'read_only' });
  });

  it('rule deny_glob renders write_denied naming the pattern', () => {
    const c = expectRouted(tool('gmail_send', 'create'), { profile: 'full-writes', readOnly: false, allow: [], deny: ['gmail:send'] });
    expect(c.reason).toEqual({ rule: 'deny_glob', pattern: 'gmail:send' });
  });

  it('rule profile renders write_denied naming the profile', () => {
    const c = expectRouted(tool('drive_delete', 'delete'), { profile: 'safe-writes', readOnly: false, allow: [], deny: [] });
    expect(c.reason).toEqual({ rule: 'profile', profile: 'safe-writes' });
  });

  it('rule privileged renders write_denied with the privilege kind', () => {
    const c = expectRouted(
      { name: 'gmail_users_watch', service: 'gmail', cud: 'create' },
      { profile: 'safe-writes', readOnly: false, allow: [], deny: [] },
    );
    expect(c.reason).toEqual({ rule: 'privileged', profile: 'safe-writes', kind: 'push_registration' });
  });

  it('carries the account through to the envelope even with a provider installed', () => {
    echo();
    const envelope = JSON.parse(
      writeDisabledResult(tool('gmail_send', 'create'), { profile: 'read-only', readOnly: false, allow: [], deny: [] }, 'work').content[0].text,
    ) as { account?: string };
    expect(envelope.account).toBe('work');
  });
});
