import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { calendar_v3 } from "googleapis";
import { z } from "zod";
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_SCOPE,
  calendarForAccount,
  describeMissingCalendarScope,
  gmailForAccount,
  isScopeInsufficientError,
  readAccountToken,
  tokenHasScope,
} from "./gmail.js";
import { getAccountConfig } from "./config.js";
import { accountShape, safeTool } from "./tools.js";

/**
 * Descriptions can run to thousands of characters; a list of fifty events
 * would otherwise dwarf everything else in the caller's context.
 */
const DESCRIPTION_LIMIT = 500;

function trimText(value: string | null | undefined, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}\u2026` : collapsed;
}

export function summarizeEvent(event: calendar_v3.Schema$Event) {
  // Google marks all-day events with `date` and timed ones with `dateTime`;
  // there is no explicit flag, so callers would otherwise each re-derive it.
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);

  // Descriptions are often auto-pasted conference details (meeting IDs, access
  // codes, long URLs with tokens), so they are trimmed to DESCRIPTION_LIMIT
  // rather than returned whole. They are returned at all because a caller that
  // writes events needs to recognise its OWN events on a later read, and the
  // description is the only field it can stamp that a person is unlikely to
  // retype by hand. Same reason for `creator`: without it, "did I create this?"
  // has no answer, and a caller that deletes what it believes are its own
  // events would be guessing.
  return {
    id: event.id ?? undefined,
    status: event.status ?? undefined,
    summary: event.summary ?? undefined,
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
    description: trimText(event.description, DESCRIPTION_LIMIT),
    organizer: event.organizer?.email ?? undefined,
    creator: event.creator?.email ?? undefined,
    attendeeCount: event.attendees?.length ?? undefined,
    // Odpowiedz tego kalendarza na zaproszenie: bez niej z listy nie widac,
    // ktore zaproszenia czekaja na decyzje. Tu `self` jest wlasciwe — projekcja
    // opisuje kopie zdarzenia z kalendarza, o ktory pytano. (Do *zapisu*
    // odpowiedzi samo `self` nie wystarcza; patrz findOwnAttendee.)
    myResponseStatus: event.attendees?.find((attendee) => attendee.self === true)?.responseStatus ?? undefined,
    // Google's own answers to two questions a caller would otherwise guess at
    // from the title: what kind of block this is (native Focus time and
    // Out-of-office keep their eventType however the user renames them), and
    // whether it occupies time at all ("transparent" is Show as: Free).
    eventType: event.eventType ?? undefined,
    transparency: event.transparency ?? undefined,
    hangoutLink: event.hangoutLink ?? undefined,
    htmlLink: event.htmlLink ?? undefined,
    recurringEventId: event.recurringEventId ?? undefined,
  };
}

export function assertCalendarScope(account: string): void {
  if (tokenHasScope(readAccountToken(account), CALENDAR_SCOPE) === false) {
    throw new Error(describeMissingCalendarScope(account));
  }
}

async function withCalendarScopeErrors<T>(account: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isScopeInsufficientError(error)) {
      throw new Error(describeMissingCalendarScope(account));
    }
    throw error;
  }
}

export function calendarEventsRequest(input: {
  calendarId?: string;
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}): calendar_v3.Params$Resource$Events$List {
  return {
    calendarId: input.calendarId ?? "primary",
    timeMin: input.timeMin,
    timeMax: input.timeMax,
    maxResults: input.maxResults ?? 50,
    // Recurring events only expand into individual occurrences with these two
    // set together; otherwise a query for "tomorrow" returns the series.
    singleEvents: true,
    orderBy: "startTime",
  };
}

// Whose invitation this is. `npm run auth` records the address in accounts.json;
// accounts authorized before that lookup existed fall back to asking Google.
export async function accountAddress(account: string): Promise<string> {
  const configured = getAccountConfig(account).email;
  if (configured) {
    return configured;
  }

  const gmail = await gmailForAccount(account);
  const profile = await gmail.users.getProfile({ userId: "me" });
  const address = profile.data.emailAddress;
  if (!address) {
    throw new Error(
      `Could not determine the address behind account "${account}", and an invitation can only be answered on behalf of a known address. Run: npm run auth -- --account ${account}`,
    );
  }
  return address;
}

export const RSVP_RESPONSES = ["accepted", "declined", "tentative"] as const;
export type RsvpResponse = (typeof RSVP_RESPONSES)[number];

// Returns the re-auth message when the token demonstrably lacks the write
// scope, and undefined when it holds it or records no scope at all — an
// unknown scope set is left for Google to answer, as the read tools do.
export function missingCalendarWriteScope(
  token: { scope?: string | null },
  account: string,
): string | undefined {
  return tokenHasScope(token, CALENDAR_EVENTS_SCOPE) === false
    ? describeMissingCalendarScope(account)
    : undefined;
}

export function assertCalendarWriteScope(account: string): void {
  const message = missingCalendarWriteScope(readAccountToken(account), account);
  if (message) {
    throw new Error(message);
  }
}

// Which attendee entry this account may answer for.
//
// `self` alone is not that entry: Google sets it on the attendee whose calendar
// the copy was read from, so on a shared calendar the account has write access
// to, `self` is the calendar owner. Answering by `self` there would rewrite
// someone else's answer. Both conditions have to hold — the entry is the one
// Google calls ours, and it carries our own address.
export function findOwnAttendee(
  attendees: calendar_v3.Schema$EventAttendee[] | undefined,
  selfEmail: string,
): number {
  const list = attendees ?? [];
  const wanted = selfEmail.trim().toLowerCase();
  const mine = list
    .map((attendee, index) => ({ attendee, index }))
    .filter(({ attendee }) => (attendee.email ?? "").trim().toLowerCase() === wanted);

  if (mine.length === 0) {
    throw new Error(
      `This account (${selfEmail}) is not an attendee of that event, so it has no invitation to answer. Nothing was changed.`,
    );
  }

  if (mine.length > 1) {
    throw new Error(
      `That event lists ${selfEmail} as an attendee more than once, so there is no single answer to record. Nothing was changed — answer it in Google Calendar.`,
    );
  }

  const own = mine[0];
  if (own.attendee.self !== true) {
    throw new Error(
      `That copy of the event lives on another calendar, where Google will not accept an answer for ${selfEmail}. Nothing was changed — answer it on this account's own calendar.`,
    );
  }

  return own.index;
}

// The Calendar API has no RSVP endpoint: answering means patching the attendee
// list, which is a whole-list field. So the list is read, exactly one entry is
// rewritten, and every other entry is passed back through untouched.
export function rsvpAttendees(
  attendees: calendar_v3.Schema$EventAttendee[] | undefined,
  selfEmail: string,
  response: RsvpResponse,
  comment: string | undefined,
): calendar_v3.Schema$EventAttendee[] {
  const list = attendees ?? [];
  const own = findOwnAttendee(list, selfEmail);

  return list.map((attendee, index) =>
    index === own
      ? {
          ...attendee,
          responseStatus: response,
          // An absent comment leaves whatever was there; only an explicit one writes.
          ...(comment === undefined ? {} : { comment }),
        }
      : attendee,
  );
}

// The slice of calendar_v3.Calendar this path uses. Narrow on purpose: no
// insert, no delete, no update — the tool cannot reach them even by mistake.
export interface RsvpCalendarClient {
  events: {
    get(params: {
      calendarId: string;
      eventId: string;
    }): Promise<{ data: calendar_v3.Schema$Event }>;
    patch(
      params: {
        calendarId: string;
        eventId: string;
        sendUpdates?: string;
        requestBody: { attendees: calendar_v3.Schema$EventAttendee[] };
      },
      options?: { headers: Record<string, string> },
    ): Promise<{ data: calendar_v3.Schema$Event }>;
  };
}

export async function respondToEvent(
  calendar: RsvpCalendarClient,
  input: {
    calendarId?: string;
    eventId: string;
    selfEmail: string;
    response: RsvpResponse;
    comment?: string;
  },
) {
  const calendarId = input.calendarId ?? "primary";
  const current = await calendar.events.get({ calendarId, eventId: input.eventId });

  // A master id answers for every occurrence at once; the ids handed out by
  // calendar_list_events are single occurrences, because it expands series.
  // Refusing keeps the two from being confused silently.
  if (current.data.recurrence && current.data.recurrence.length > 0) {
    throw new Error(
      "That id is a recurring series, not one occurrence, and answering it would answer every occurrence. Nothing was changed — call calendar_list_events for the day in question and use the id it returns.",
    );
  }

  const own = findOwnAttendee(current.data.attendees, input.selfEmail);
  const attendees = rsvpAttendees(current.data.attendees, input.selfEmail, input.response, input.comment);

  // The whole attendee list is written back, so a blind write would reinstate
  // it as it looked a moment ago. Without an etag to guard that, the write is
  // refused rather than sent unguarded.
  const etag = current.data.etag;
  if (!etag) {
    throw new Error(
      "Google returned that event without an etag, so the answer cannot be written without risking overwriting a change made in the meantime. Nothing was changed.",
    );
  }

  const patched = await patchWithConflictNote(calendar, {
    calendarId,
    eventId: input.eventId,
    // Notification mail only. The answer itself reaches the organizer's copy
    // either way; "all" would mail every guest on the invitation, and the
    // optional comment is text this server was handed, not text a human typed.
    sendUpdates: "none",
    requestBody: { attendees },
    etag,
  });

  const stored = (patched.attendees ?? attendees)[own];

  return {
    calendarId,
    eventId: input.eventId,
    summary: patched.summary ?? current.data.summary ?? undefined,
    start: patched.start?.dateTime ?? patched.start?.date ?? undefined,
    attendee: stored?.email ?? undefined,
    responseStatus: stored?.responseStatus ?? undefined,
    comment: stored?.comment ?? undefined,
  };
}

// A 412 here is ordinary: it means someone else touched the event between the
// read and the write. Left raw it reaches the caller as "status code 412",
// which invites guessing instead of a re-read.
async function patchWithConflictNote(
  calendar: RsvpCalendarClient,
  input: {
    calendarId: string;
    eventId: string;
    sendUpdates: string;
    requestBody: { attendees: calendar_v3.Schema$EventAttendee[] };
    etag: string;
  },
): Promise<calendar_v3.Schema$Event> {
  const { etag, ...params } = input;
  try {
    const response = await calendar.events.patch(params, { headers: { "If-Match": etag } });
    return response.data;
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      throw new Error(
        "That event changed while the answer was being prepared, so nothing was written. Read it again and repeat the answer.",
      );
    }
    throw error;
  }
}

export function isPreconditionFailedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  return candidate.code === 412 || candidate.status === 412 || candidate.response?.status === 412;
}

export function registerCalendarTools(server: McpServer): void {
  server.tool(
    "calendar_list_calendars",
    "List the Google Calendars an account can read.",
    accountShape,
    async ({ account }) =>
      safeTool(async () => {
        assertCalendarScope(account);
        return await withCalendarScopeErrors(account, async () => {
          const calendar = await calendarForAccount(account);
          const response = await calendar.calendarList.list();
          return (response.data.items ?? []).map((item) => ({
            id: item.id ?? undefined,
            summary: item.summary ?? undefined,
            primary: item.primary ?? undefined,
            accessRole: item.accessRole ?? undefined,
            timeZone: item.timeZone ?? undefined,
          }));
        });
      }, account),
  );

  server.tool(
    "calendar_list_events",
    "List events from one Google Calendar within a time range. Recurring events are expanded into individual occurrences. Read-only.",
    {
      ...accountShape,
      calendarId: z.string().min(1).optional().describe('Calendar id; defaults to "primary".'),
      timeMin: z.string().min(1).describe("RFC3339 lower bound, e.g. 2026-08-12T00:00:00Z."),
      timeMax: z.string().min(1).describe("RFC3339 upper bound, e.g. 2026-08-13T00:00:00Z."),
      maxResults: z.number().int().min(1).max(250).optional().describe("Defaults to 50."),
    },
    async ({ account, calendarId, timeMin, timeMax, maxResults }) =>
      safeTool(async () => {
        assertCalendarScope(account);
        return await withCalendarScopeErrors(account, async () => {
          const calendar = await calendarForAccount(account);
          const response = await calendar.events.list(
            calendarEventsRequest({ calendarId, timeMin, timeMax, maxResults }),
          );
          return (response.data.items ?? []).map(summarizeEvent);
        });
      }, account),
  );

  server.tool(
    "calendar_respond_to_event",
    "Answer a calendar invitation on behalf of the calling account: accept, decline, or answer tentatively, with an optional comment to the organizer. Changes only this account's own participation status — it cannot create, move, or delete an event, or change anyone else's answer.",
    {
      ...accountShape,
      calendarId: z.string().min(1).optional().describe('Calendar id; defaults to "primary".'),
      eventId: z.string().min(1).describe("Event id, as returned by calendar_list_events."),
      response: z.enum(RSVP_RESPONSES).describe("The answer to record for this account."),
      comment: z.string().max(1024).optional().describe("Optional note sent to the organizer."),
    },
    async ({ account, calendarId, eventId, response, comment }) =>
      safeTool(async () => {
        assertCalendarWriteScope(account);
        const selfEmail = await accountAddress(account);
        return await withCalendarScopeErrors(account, async () => {
          const calendar = await calendarForAccount(account);
          return await respondToEvent(calendar, {
            calendarId,
            eventId,
            selfEmail,
            response,
            comment,
          });
        });
      }, account),
  );
}
