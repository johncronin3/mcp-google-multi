import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/registry.js';
import type { Policy } from '../src/write-control.js';
import { registerCalendarTools } from '../src/tools/calendar.js';
import {
  rsvpCalendarEvent,
  isSelfOrganizer,
  findSelfAttendee,
  normalizeEmail,
  type CalendarRsvpClient,
} from '../src/tools/calendar-rsvp.js';

const POLICY: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };

function mockCal(event: any, patchData?: any): CalendarRsvpClient & { get: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async () => ({ data: event }));
  const patch = vi.fn(async () => ({ data: patchData ?? { ...event, attendees: [{ email: 'test@example.com', responseStatus: 'accepted' }] } }));
  return {
    get,
    patch,
    events: { get, patch },
  };
}

describe('normalizeEmail / organizer / attendee helpers', () => {
  it('normalizes email case and whitespace', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
  });

  it('detects organizer via self flag or email match', () => {
    expect(isSelfOrganizer({ organizer: { self: true } }, 'a@b.com')).toBe(true);
    expect(isSelfOrganizer({ organizer: { email: 'Test@Example.com' } }, 'test@example.com')).toBe(true);
    expect(isSelfOrganizer({ organizer: { email: 'other@x.com' } }, 'test@example.com')).toBe(false);
  });

  it('finds self attendee by self flag or email', () => {
    const event = {
      attendees: [
        { email: 'host@x.com', responseStatus: 'accepted' },
        { email: 'Test@Example.com', responseStatus: 'needsAction' },
      ],
    };
    expect(findSelfAttendee(event, 'test@example.com')?.email).toBe('Test@Example.com');
    expect(findSelfAttendee({ attendees: [{ self: true, email: 'alias@x.com' }] }, 'test@example.com')?.email).toBe('alias@x.com');
    expect(findSelfAttendee({ attendees: [{ email: 'other@x.com' }] }, 'test@example.com')).toBeUndefined();
  });
});

describe('rsvpCalendarEvent', () => {
  const baseEvent = {
    id: 'evt1',
    summary: 'Sync',
    organizer: { email: 'host@x.com' },
    attendees: [
      { email: 'host@x.com', responseStatus: 'accepted', organizer: true },
      { email: 'test@example.com', responseStatus: 'needsAction' },
    ],
    start: { dateTime: '2026-09-10T15:00:00Z' },
    end: { dateTime: '2026-09-10T16:00:00Z' },
  };

  it('PATCHes only own attendee responseStatus with attendeesOmitted', async () => {
    const cal = mockCal(baseEvent, {
      ...baseEvent,
      attendees: [
        { email: 'host@x.com', responseStatus: 'accepted' },
        { email: 'test@example.com', responseStatus: 'accepted' },
      ],
    });

    const res = await rsvpCalendarEvent(cal, {
      account: 'test',
      eventId: 'evt1',
      responseStatus: 'accepted',
      calendarId: 'primary',
      sendUpdates: 'all',
      selfEmail: 'test@example.com',
    });

    expect(res.isError).toBeUndefined();
    expect(cal.get).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'evt1' });
    expect(cal.patch).toHaveBeenCalledTimes(1);
    const patchArg = cal.patch.mock.calls[0][0];
    expect(patchArg).toEqual({
      calendarId: 'primary',
      eventId: 'evt1',
      sendUpdates: 'all',
      requestBody: {
        attendeesOmitted: true,
        attendees: [{ email: 'test@example.com', responseStatus: 'accepted' }],
      },
    });
    // Must NOT include start/end/summary in the patch body
    expect(patchArg.requestBody.start).toBeUndefined();
    expect(patchArg.requestBody.end).toBeUndefined();
    expect(patchArg.requestBody.summary).toBeUndefined();

    const body = JSON.parse(res.content[0].text);
    expect(body.id).toBe('evt1');
    expect(body.attendees).toEqual(
      expect.arrayContaining([{ email: 'test@example.com', responseStatus: 'accepted' }]),
    );
  });

  it('refuses when the account is the organizer', async () => {
    const cal = mockCal({
      ...baseEvent,
      organizer: { email: 'test@example.com', self: true },
    });
    const res = await rsvpCalendarEvent(cal, {
      account: 'test',
      eventId: 'evt1',
      responseStatus: 'accepted',
      selfEmail: 'test@example.com',
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('organizer_cannot_rsvp');
    expect(cal.patch).not.toHaveBeenCalled();
  });

  it('refuses when self is not an attendee', async () => {
    const cal = mockCal({
      ...baseEvent,
      attendees: [{ email: 'host@x.com', responseStatus: 'accepted' }],
    });
    const res = await rsvpCalendarEvent(cal, {
      account: 'test',
      eventId: 'evt1',
      responseStatus: 'declined',
      selfEmail: 'test@example.com',
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('not_an_attendee');
    expect(cal.patch).not.toHaveBeenCalled();
  });

  it('defaults sendUpdates to all', async () => {
    const cal = mockCal(baseEvent);
    await rsvpCalendarEvent(cal, {
      account: 'test',
      eventId: 'evt1',
      responseStatus: 'tentative',
      selfEmail: 'test@example.com',
    });
    expect(cal.patch.mock.calls[0][0].sendUpdates).toBe('all');
    expect(cal.patch.mock.calls[0][0].requestBody.attendees[0].responseStatus).toBe('tentative');
  });
});

describe('registerCalendarTools includes calendar_events_rsvp', () => {
  it('registers RSVP as an update tool under calendar', () => {
    const server = {
      registerTool: () => 'ok',
      sendToolListChanged: () => {},
      server: { setRequestHandler: () => {} },
    };
    const registry = new ToolRegistry(server as never, POLICY);
    registerCalendarTools(registry);
    const rsvp = registry.tools.find((t) => t.name === 'calendar_events_rsvp');
    expect(rsvp).toBeDefined();
    expect(rsvp!.service).toBe('calendar');
    expect(rsvp!.cud).toBe('update');
    expect(registry.catalog('calendar').some((o) => o.tool === 'calendar_events_rsvp')).toBe(true);
  });
});
