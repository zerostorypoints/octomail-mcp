import type { calendar_v3 } from "googleapis";

export function summarizeEvent(event: calendar_v3.Schema$Event) {
  // Google marks all-day events with `date` and timed ones with `dateTime`;
  // there is no explicit flag, so callers would otherwise each re-derive it.
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);

  return {
    id: event.id ?? undefined,
    status: event.status ?? undefined,
    summary: event.summary ?? undefined,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    start: {
      dateTime: event.start?.dateTime ?? undefined,
      date: event.start?.date ?? undefined,
      timeZone: event.start?.timeZone ?? undefined,
    },
    end: {
      dateTime: event.end?.dateTime ?? undefined,
      date: event.end?.date ?? undefined,
      timeZone: event.end?.timeZone ?? undefined,
    },
    allDay,
    organizer: event.organizer?.email ?? undefined,
    attendeeCount: event.attendees?.length ?? undefined,
    hangoutLink: event.hangoutLink ?? undefined,
    htmlLink: event.htmlLink ?? undefined,
    recurringEventId: event.recurringEventId ?? undefined,
  };
}
