import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

describe('calendar timeMin/timeMax require a timezone suffix', () => {
  it('calendar_list_events rejects a bare local datetime, naming the field', async () => {
    const h = toolHarness({ respond: () => ({ items: [] }) });
    const res = await h.call('calendar_list_events', {
      account: 'test',
      timeMin: '2026-04-04T00:00:00',
      timeMax: '2026-04-05T00:00:00Z',
    });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain('timeMin');
    expect(env.hint).toContain('2026-04-04T00:00:00Z');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('calendar_list_events accepts a numeric offset on both bounds', async () => {
    const h = toolHarness({ respond: () => ({ items: [] }) });
    const res = await h.call('calendar_list_events', {
      account: 'test',
      timeMin: '2026-04-04T00:00:00+01:00',
      timeMax: '2026-04-05T00:00:00+01:00',
    });
    expect(res.isError).toBeFalsy();
    expect(h.request).toHaveBeenCalled();
  });

  it('calendar_list_instances rejects a bare timeMax', async () => {
    const h = toolHarness({ respond: () => ({ items: [] }) });
    const res = await h.call('calendar_list_instances', {
      account: 'test',
      eventId: 'e1',
      timeMin: '2026-04-04T00:00:00Z',
      timeMax: '2026-04-05T00:00:00',
    });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain('timeMax');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('calendar_get_freebusy rejects a bare timeMin before the range check runs', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('calendar_get_freebusy', {
      account: 'test',
      calendarIds: ['primary'],
      timeMin: '2026-04-04T00:00:00',
      timeMax: '2026-04-05T00:00:00Z',
    });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(env.message).toContain('timeMin');
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe('calendar_respond_event', () => {
  const eventWithSelf = {
    id: 'e1',
    attendees: [
      { email: 'other@example.com', responseStatus: 'needsAction' },
      { email: 'me@harness.example', self: true, responseStatus: 'needsAction' },
    ],
  };

  it('patches only the caller own attendee entry via attendeesOmitted', async () => {
    const h = toolHarness({ respond: () => eventWithSelf });
    const res = await h.call('calendar_respond_event', {
      account: 'test',
      eventId: 'e1',
      response: 'accepted',
      comment: 'see you there',
    });
    expect(res.isError).toBeFalsy();
    const patch = h.requests().find((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH');
    expect(patch).toBeDefined();
    const body = (patch as GoogleRequest).data as { attendeesOmitted?: boolean; attendees?: unknown[] };
    expect(body.attendeesOmitted).toBe(true);
    expect(body.attendees).toEqual([{ email: 'me@harness.example', responseStatus: 'accepted', comment: 'see you there' }]);
  });

  it('refuses when the account has no attendee entry on the event, without patching', async () => {
    const h = toolHarness({ respond: () => ({ id: 'e1', attendees: [{ email: 'other@example.com', responseStatus: 'needsAction' }] }) });
    const res = await h.call('calendar_respond_event', { account: 'test', eventId: 'e1', response: 'declined' });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(h.requests().some((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH')).toBe(false);
  });

  it('falls back to matching by the account email, case-insensitive, when self is omitted', async () => {
    const h = toolHarness({
      respond: () => ({
        id: 'e1',
        attendees: [
          { email: 'other@example.com', responseStatus: 'needsAction' },
          { email: 'TEST@harness.example', responseStatus: 'needsAction' },
        ],
      }),
    });
    const res = await h.call('calendar_respond_event', { account: 'test', eventId: 'e1', response: 'tentative' });
    expect(res.isError).toBeFalsy();
    const patch = h.requests().find((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH');
    expect(patch).toBeDefined();
    const body = (patch as GoogleRequest).data as { attendeesOmitted?: boolean; attendees?: unknown[] };
    expect(body.attendeesOmitted).toBe(true);
    expect(body.attendees).toEqual([{ email: 'TEST@harness.example', responseStatus: 'tentative' }]);
  });

  it('refuses when no attendee matches self or the account email, without patching', async () => {
    const h = toolHarness({
      respond: () => ({
        id: 'e1',
        attendees: [
          { email: 'other@example.com', responseStatus: 'needsAction' },
          { email: 'someone-else@example.com', responseStatus: 'needsAction' },
        ],
      }),
    });
    const res = await h.call('calendar_respond_event', { account: 'test', eventId: 'e1', response: 'declined' });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('invalid_params');
    expect(h.requests().some((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH')).toBe(false);
  });

  it('sends the chosen response status and comment in the patch body', async () => {
    const h = toolHarness({ respond: () => eventWithSelf });
    const res = await h.call('calendar_respond_event', {
      account: 'test',
      eventId: 'e1',
      response: 'declined',
      comment: 'cannot make it',
    });
    expect(res.isError).toBeFalsy();
    const patch = h.requests().find((r) => (r.method ?? 'GET').toUpperCase() === 'PATCH');
    const body = (patch as GoogleRequest).data as { attendees?: unknown[] };
    expect(body.attendees).toEqual([{ email: 'me@harness.example', responseStatus: 'declined', comment: 'cannot make it' }]);
  });

  it('is gated by write-control like any other update', async () => {
    const h = toolHarness({ respond: () => eventWithSelf, policy: { profile: 'read-only', readOnly: true } });
    const res = await h.call('calendar_respond_event', { account: 'test', eventId: 'e1', response: 'tentative' });
    const env = parseResult(res);
    expect(res.isError).toBe(true);
    expect(env.error).toBe('write_disabled');
  });
});
