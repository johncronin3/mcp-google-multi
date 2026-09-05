import { z } from 'zod';
import { calendar as calendarClient } from '@googleapis/calendar';
import { ACCOUNTS, ACCOUNT_CONFIG } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import type { ToolRegistry } from '../registry.js';
import { handleGoogleApiError } from './_errors.js';
import { formatEvent } from './calendar.js';

const accountEnum = z.enum(ACCOUNTS);

export type RsvpResponseStatus = 'accepted' | 'declined' | 'tentative';
export type RsvpSendUpdates = 'all' | 'externalOnly' | 'none';

export function normalizeEmail(email: string | undefined | null): string {
  return (email ?? '').trim().toLowerCase();
}

export function selfEmailForAccount(account: Account): string {
  const email = ACCOUNT_CONFIG[account]?.email;
  if (!email) {
    throw new Error(`No email configured for account "${account}" in GOOGLE_ACCOUNTS.`);
  }
  return email;
}

export function isSelfOrganizer(event: any, selfEmail: string): boolean {
  if (event?.organizer?.self === true) return true;
  return normalizeEmail(event?.organizer?.email) === normalizeEmail(selfEmail);
}

export function findSelfAttendee(event: any, selfEmail: string): any | undefined {
  const want = normalizeEmail(selfEmail);
  const attendees = event?.attendees ?? [];
  return attendees.find(
    (a: any) => a?.self === true || normalizeEmail(a?.email) === want,
  );
}

/** Minimal calendar client surface used by RSVP (mockable in unit tests). */
export interface CalendarRsvpClient {
  events: {
    get: (args: { calendarId: string; eventId: string }) => Promise<{ data: any }>;
    patch: (args: {
      calendarId: string;
      eventId: string;
      sendUpdates?: RsvpSendUpdates;
      requestBody: {
        attendeesOmitted: true;
        attendees: Array<{ email: string; responseStatus: RsvpResponseStatus }>;
      };
    }) => Promise<{ data: any }>;
  };
}

export async function rsvpCalendarEvent(
  cal: CalendarRsvpClient,
  opts: {
    account: Account;
    eventId: string;
    responseStatus: RsvpResponseStatus;
    calendarId?: string;
    sendUpdates?: RsvpSendUpdates;
    selfEmail?: string;
  },
) {
  const calendarId = opts.calendarId ?? 'primary';
  const sendUpdates = opts.sendUpdates ?? 'all';
  const selfEmail = opts.selfEmail ?? selfEmailForAccount(opts.account);

  const got = await cal.events.get({ calendarId, eventId: opts.eventId });
  const event = got.data;

  if (isSelfOrganizer(event, selfEmail)) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'organizer_cannot_rsvp',
          message:
            `Account "${opts.account}" (${selfEmail}) is the organizer of this event. ` +
            'Organizers do not RSVP; use calendar_update_event to change the event instead.',
          retriable: false,
          account: opts.account,
          eventId: opts.eventId,
        }),
      }],
      isError: true as const,
    };
  }

  const selfAttendee = findSelfAttendee(event, selfEmail);
  if (!selfAttendee) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'not_an_attendee',
          message:
            `Account "${opts.account}" (${selfEmail}) is not listed as an attendee on this event.`,
          retriable: false,
          account: opts.account,
          eventId: opts.eventId,
        }),
      }],
      isError: true as const,
    };
  }

  // Prefer the attendee email from the event (canonical casing); fall back to profile email.
  const attendeeEmail = selfAttendee.email ?? selfEmail;

  const res = await cal.events.patch({
    calendarId,
    eventId: opts.eventId,
    sendUpdates,
    requestBody: {
      attendeesOmitted: true,
      attendees: [{ email: attendeeEmail, responseStatus: opts.responseStatus }],
    },
  });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(formatEvent(res.data), null, 2),
    }],
  };
}

export function registerCalendarRsvpTool(server: ToolRegistry): void {
  server.registerTool(
    'calendar_events_rsvp',
    {
      description:
        'RSVP to a calendar event as the authenticated guest (events.patch with attendeesOmitted). ' +
        'Use this instead of calendar_events_update / calendar_update_event when you are an attendee, not the organizer — ' +
        'full update/PUT fails with missing end time or shared-properties-only-organizer. ' +
        'Patches only your own attendee responseStatus; does not send start/end/summary.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        eventId: z.string().describe('Calendar event ID'),
        responseStatus: z.enum(['accepted', 'declined', 'tentative'])
          .describe('Your RSVP response'),
        calendarId: z.string().default('primary').optional()
          .describe('Calendar ID (default: primary)'),
        sendUpdates: z.enum(['all', 'externalOnly', 'none']).default('all').optional()
          .describe('Who should receive update notifications (default: all)'),
      },
    },
    async ({ account, eventId, responseStatus, calendarId, sendUpdates }) => {
      try {
        const auth = await getClient(account as Account);
        const cal = calendarClient({ version: 'v3', auth });
        return await rsvpCalendarEvent(cal, {
          account: account as Account,
          eventId,
          responseStatus,
          calendarId: calendarId ?? 'primary',
          sendUpdates: sendUpdates ?? 'all',
        });
      } catch (error: any) {
        return handleGoogleApiError(error, account as Account);
      }
    },
  );
}
