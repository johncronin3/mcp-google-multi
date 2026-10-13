import { describe, it, expect, afterEach } from 'vitest';
import { handleFormsError } from '../src/tools/forms.js';
import { handleSlidesError } from '../src/tools/slides.js';
import { handleChatError } from '../src/tools/chat.js';
import { handleAnalyticsError } from '../src/tools/analytics.js';
import { handleAdminError } from '../src/tools/admin.js';
import { handleMeetError } from '../src/tools/meet.js';
import { setHintProvider, type HintCase } from '../src/hint-provider.js';

const acc = 'work' as never;

// A scope 403 shaped like Google's ACCESS_TOKEN_SCOPE_INSUFFICIENT, the same
// shape errors.test.ts uses for the curated insufficient_scope fallback.
const SCOPE_403 = { code: 403, errors: [{ reason: 'insufficientPermissions' }], message: 'Insufficient Permission' };

afterEach(() => setHintProvider(null));

function echo() {
  const seen: HintCase[] = [];
  setHintProvider({
    render: (c) => {
      seen.push(c);
      return { hint: `kind:${c.kind}` };
    },
  });
  return seen;
}

// H3 PR1: every curated gated-service 403 text is unchanged with no provider
// (case A — these assertions pass against today's literals), and carries the
// right bundle fact to a provider (case B — scope_unknown.bundle).
describe('curated gated-service scope hints carry their bundle (H3)', () => {
  it('forms: unchanged text with no provider; bundle "forms" with one', () => {
    const e = handleFormsError(SCOPE_403, acc);
    expect(JSON.parse(e.content[0].text).hint).toContain('"forms" scope bundle');

    const seen = echo();
    handleFormsError(SCOPE_403, acc);
    expect(seen).toEqual([{ kind: 'scope_unknown', account: acc, serviceText: expect.stringContaining('forms'), bundle: 'forms' }]);
  });

  it('slides: unchanged text with no provider; bundle "slides" with one', () => {
    const e = handleSlidesError(SCOPE_403, acc);
    expect(JSON.parse(e.content[0].text).hint).toContain('"slides" scope bundle');

    const seen = echo();
    handleSlidesError(SCOPE_403, acc);
    expect(seen).toEqual([{ kind: 'scope_unknown', account: acc, serviceText: expect.stringContaining('slides'), bundle: 'slides' }]);
  });

  it('chat: unchanged text with no provider; bundle "chat" with one', () => {
    const e = handleChatError(SCOPE_403, acc);
    expect(JSON.parse(e.content[0].text).hint).toContain('"chat" scope bundle');

    const seen = echo();
    handleChatError(SCOPE_403, acc);
    expect(seen).toEqual([{ kind: 'scope_unknown', account: acc, serviceText: expect.stringContaining('chat'), bundle: 'chat' }]);
  });

  it('analytics: unchanged text with no provider; bundle "analytics" with one', () => {
    const e = handleAnalyticsError(SCOPE_403, acc);
    expect(JSON.parse(e.content[0].text).hint).toContain('"analytics" bundle');

    const seen = echo();
    handleAnalyticsError(SCOPE_403, acc);
    expect(seen).toEqual([{ kind: 'scope_unknown', account: acc, serviceText: expect.stringContaining('analytics'), bundle: 'analytics' }]);
  });

  it('admin: unchanged text with no provider; bundle "admin" with one', () => {
    const e = handleAdminError(SCOPE_403, acc);
    expect(JSON.parse(e.content[0].text).hint).toContain('Workspace super-admin');

    const seen = echo();
    handleAdminError(SCOPE_403, acc);
    expect(seen).toEqual([{ kind: 'scope_unknown', account: acc, serviceText: expect.stringContaining('Workspace super-admin'), bundle: 'admin' }]);
  });

  it('meet: a base scope, never a bundle fact', () => {
    const e = handleMeetError(SCOPE_403, acc);
    expect(JSON.parse(e.content[0].text).hint).toContain('meetings.space.readonly');

    const seen = echo();
    handleMeetError(SCOPE_403, acc);
    expect(seen).toEqual([{ kind: 'scope_unknown', account: acc, serviceText: expect.stringContaining('Meet'), bundle: undefined }]);
  });
});
