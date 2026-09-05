# Calendar guest RSVP (feat/calendar-events-rsvp)

- **Problem:** Guest Accept via `calendar_events_update` (PUT) fails — missing end time / shared properties only organizer.
- **Fix:** New curated tool `calendar_events_rsvp` — GET event, resolve self email from `GOOGLE_ACCOUNTS`, refuse if organizer or not an attendee, then `events.patch` with `attendeesOmitted: true` + only own `{email, responseStatus}`. No start/end/summary in the body.
- **Args:** `account`, `eventId`, `responseStatus` (`accepted|declined|tentative`), optional `calendarId` (default `primary`), optional `sendUpdates` (default `all`).
- **Discover:** Appears under `calendar_discover` like other calendar tools (CUD override `update`).
- **Stromback Accept:** `calendar_events_rsvp` with `account: "stromback"`, `eventId`, `responseStatus: "accepted"`.
- No Cloud Run deploy in this take.
