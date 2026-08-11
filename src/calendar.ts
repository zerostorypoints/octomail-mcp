import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { calendar_v3 } from "googleapis";
import { z } from "zod";
import {
  CALENDAR_SCOPE,
  calendarForAccount,
  describeMissingCalendarScope,
  isScopeInsufficientError,
  readAccountToken,
  tokenHasScope,
} from "./gmail.js";
import { accountShape, safeTool } from "./tools.js";

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
}
