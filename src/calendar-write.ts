import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { calendar_v3 } from "googleapis";
import { z } from "zod";
import {
  assertCalendarWriteScope,
  isPreconditionFailedError,
  summarizeEvent,
} from "./calendar.js";
import { calendarForAccount, describeMissingCalendarScope, isScopeInsufficientError } from "./gmail.js";
import { getAccountConfig } from "./config.js";
import { checkRecipients } from "./recipients.js";
import { accountShape, safeTool } from "./tools.js";

// Google accepts a dateTime without an offset and reads it in the calendar's
// own zone, so an input like "2026-08-18T14:00:00" lands at a different instant
// depending on whose calendar it is written to. A caller cannot see that
// happen. Requiring the offset makes the instant explicit in the input itself.
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const SEND_UPDATES = ["none", "all"] as const;
export type SendUpdates = (typeof SEND_UPDATES)[number];

export type EventTimesInput = {
  start?: string;
  end?: string;
  startDate?: string;
  endDate?: string;
};

export type EventTimes = {
  start: calendar_v3.Schema$EventDateTime;
  end: calendar_v3.Schema$EventDateTime;
};

// One event is either timed or all-day, never both, and Google expresses the
// difference by which field is populated. Deciding that here — once, from the
// input the caller actually gave — keeps every write path from re-deriving it.
export function eventTimes(input: EventTimesInput): EventTimes {
  const timed = input.start !== undefined || input.end !== undefined;
  const allDay = input.startDate !== undefined || input.endDate !== undefined;

  if (timed && allDay) {
    throw new Error(
      "An event is either timed (start/end) or all-day (startDate/endDate), and this call mixes both. Nothing was written.",
    );
  }

  if (allDay) {
    const { startDate, endDate } = input;
    if (!startDate || !endDate) {
      throw new Error("An all-day event needs both startDate and endDate. Nothing was written.");
    }
    for (const [name, value] of [
      ["startDate", startDate],
      ["endDate", endDate],
    ] as const) {
      if (!DATE_ONLY.test(value)) {
        throw new Error(`${name} must be a date like 2026-08-18. Nothing was written.`);
      }
    }
    // Google treats the end date as exclusive: a single day on 18.08 ends on
    // 19.08. Callers get this wrong in the direction of a zero-length event,
    // which Google rejects with a bare 400, so it is caught here by name.
    if (Date.parse(`${endDate}T00:00:00Z`) <= Date.parse(`${startDate}T00:00:00Z`)) {
      throw new Error(
        `endDate is exclusive, so it must be the day AFTER the last day of the event: for a single day on ${startDate} pass endDate of the following day. Nothing was written.`,
      );
    }
    return { start: { date: startDate }, end: { date: endDate } };
  }

  const { start, end } = input;
  if (!start || !end) {
    throw new Error(
      "A timed event needs both start and end, or use startDate/endDate for an all-day event. Nothing was written.",
    );
  }
  for (const [name, value] of [
    ["start", start],
    ["end", end],
  ] as const) {
    if (!RFC3339_WITH_OFFSET.test(value)) {
      throw new Error(
        `${name} must be an RFC3339 timestamp carrying its UTC offset, e.g. 2026-08-18T14:00:00+02:00 or 2026-08-18T12:00:00Z. Without an offset the instant depends on the calendar's own time zone. Nothing was written.`,
      );
    }
  }
  if (Date.parse(end) <= Date.parse(start)) {
    throw new Error("end must be after start. Nothing was written.");
  }
  return { start: { dateTime: start }, end: { dateTime: end } };
}

// Adding someone as an attendee puts the event on their calendar and, with
// sendUpdates "all", mails them. That is the same outward-facing act the send
// gate exists for, so it answers to the same allowlist rather than a second,
// looser one of its own.
export function assertAttendeesAllowed(
  attendees: string[] | undefined,
  allowlist: string[] | undefined,
  account: string,
): void {
  if (!attendees?.length) {
    return;
  }

  const verdicts = checkRecipients(attendees, allowlist);
  const refused = verdicts.filter((verdict) => !verdict.allowed);
  if (refused.length) {
    throw new Error(
      `Refused to write that event from "${account}": ${refused
        .map((verdict) => `${verdict.address} (${verdict.reason})`)
        .join(", ")} — an attendee receives the invitation, so attendees must be on this account's allowedRecipients in accounts.json. Nothing was written.`,
    );
  }
}

export type EventFields = {
  summary?: string;
  description?: string;
  location?: string;
  attendees?: string[];
};

export function eventRequestBody(
  fields: EventFields,
  times: EventTimes | undefined,
): calendar_v3.Schema$Event {
  return {
    ...(fields.summary === undefined ? {} : { summary: fields.summary }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.location === undefined ? {} : { location: fields.location }),
    ...(fields.attendees === undefined
      ? {}
      : { attendees: fields.attendees.map((email) => ({ email })) }),
    ...(times === undefined ? {} : { start: times.start, end: times.end }),
  };
}

// The slice of calendar_v3.Calendar the write tools use. Kept explicit so a
// test can hand in a fake, and so the reach of these tools is readable in one
// place: read, insert, patch, delete — nothing else on the API surface.
export interface WritableCalendarClient {
  events: {
    get(params: { calendarId: string; eventId: string }): Promise<{ data: calendar_v3.Schema$Event }>;
    insert(params: {
      calendarId: string;
      sendUpdates?: string;
      requestBody: calendar_v3.Schema$Event;
    }): Promise<{ data: calendar_v3.Schema$Event }>;
    patch(
      params: {
        calendarId: string;
        eventId: string;
        sendUpdates?: string;
        requestBody: calendar_v3.Schema$Event;
      },
      options?: { headers: Record<string, string> },
    ): Promise<{ data: calendar_v3.Schema$Event }>;
    delete(
      params: { calendarId: string; eventId: string; sendUpdates?: string },
      options?: { headers: Record<string, string> },
    ): Promise<unknown>;
  };
}

export async function createEvent(
  calendar: WritableCalendarClient,
  input: EventFields &
    EventTimesInput & {
      calendarId?: string;
      summary: string;
      sendUpdates?: SendUpdates;
    },
) {
  const calendarId = input.calendarId ?? "primary";
  const times = eventTimes(input);
  const created = await calendar.events.insert({
    calendarId,
    sendUpdates: input.sendUpdates ?? "none",
    requestBody: eventRequestBody(input, times),
  });

  return { calendarId, ...summarizeEvent(created.data) };
}

// An id that names a whole series changes or removes every occurrence at once,
// and calendar_list_events hands out occurrence ids because it expands series.
// The two are indistinguishable to a caller reading a list, so a series is
// refused unless the call says series work is intended.
function assertNotUnintendedSeries(
  event: calendar_v3.Schema$Event,
  confirmSeries: boolean | undefined,
  action: string,
): void {
  if (event.recurrence?.length && !confirmSeries) {
    throw new Error(
      `That id is a recurring series, so this would ${action} every occurrence at once. Nothing was written. Call calendar_list_events for the day in question and use the occurrence id it returns, or repeat this call with confirmSeries: true.`,
    );
  }
}

// Every write reads first: the etag from that read goes out as If-Match, so a
// change someone else made in between fails the write instead of silently
// overwriting it.
function requireEtag(event: calendar_v3.Schema$Event): string {
  const etag = event.etag;
  if (!etag) {
    throw new Error(
      "Google returned that event without an etag, so it cannot be written without risking overwriting a change made in the meantime. Nothing was written.",
    );
  }
  return etag;
}

function conflictNote(action: string): Error {
  return new Error(
    `That event changed while the ${action} was being prepared, so nothing was written. Read it again and repeat the call.`,
  );
}

export async function updateEvent(
  calendar: WritableCalendarClient,
  input: EventFields &
    EventTimesInput & {
      calendarId?: string;
      eventId: string;
      sendUpdates?: SendUpdates;
      confirmSeries?: boolean;
    },
) {
  const calendarId = input.calendarId ?? "primary";
  const hasTimes =
    input.start !== undefined ||
    input.end !== undefined ||
    input.startDate !== undefined ||
    input.endDate !== undefined;
  const changes = eventRequestBody(input, hasTimes ? eventTimes(input) : undefined);

  // A patch with nothing in it returns the event unchanged, which reads like a
  // successful edit. Refusing says plainly that no field was given.
  if (Object.keys(changes).length === 0) {
    throw new Error(
      "That call names no field to change. Pass summary, description, location, attendees, or a new start/end. Nothing was written.",
    );
  }

  const current = await calendar.events.get({ calendarId, eventId: input.eventId });
  assertNotUnintendedSeries(current.data, input.confirmSeries, "change");
  const etag = requireEtag(current.data);

  try {
    const patched = await calendar.events.patch(
      {
        calendarId,
        eventId: input.eventId,
        sendUpdates: input.sendUpdates ?? "none",
        requestBody: changes,
      },
      { headers: { "If-Match": etag } },
    );
    return { calendarId, ...summarizeEvent(patched.data) };
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      throw conflictNote("change");
    }
    throw error;
  }
}

export async function deleteEvent(
  calendar: WritableCalendarClient,
  input: {
    calendarId?: string;
    eventId: string;
    confirm?: boolean;
    confirmSeries?: boolean;
    sendUpdates?: SendUpdates;
  },
) {
  const calendarId = input.calendarId ?? "primary";
  const current = await calendar.events.get({ calendarId, eventId: input.eventId });
  const target = { calendarId, ...summarizeEvent(current.data) };

  // Deletion is the one call here with nothing to undo it: Google keeps no
  // trash for events. Without confirm the tool reports what it would remove
  // and stops, so the decision is made against the real title and time.
  if (!input.confirm) {
    return {
      deleted: false,
      wouldDelete: target,
      note: "Nothing was deleted. Call again with confirm: true to delete this event — deleted events cannot be restored from Google Calendar.",
    };
  }

  assertNotUnintendedSeries(current.data, input.confirmSeries, "delete");
  const etag = requireEtag(current.data);

  try {
    await calendar.events.delete(
      {
        calendarId,
        eventId: input.eventId,
        sendUpdates: input.sendUpdates ?? "none",
      },
      { headers: { "If-Match": etag } },
    );
  } catch (error) {
    if (isPreconditionFailedError(error)) {
      throw conflictNote("deletion");
    }
    throw error;
  }

  return { deleted: true, event: target };
}

const timeShape = {
  start: z
    .string()
    .optional()
    .describe("Timed event start, RFC3339 WITH offset, e.g. 2026-08-18T14:00:00+02:00."),
  end: z.string().optional().describe("Timed event end, RFC3339 with offset."),
  startDate: z.string().optional().describe("All-day event first day, e.g. 2026-08-18."),
  endDate: z
    .string()
    .optional()
    .describe("All-day event end day, EXCLUSIVE: for a single day pass the following day."),
};

const fieldShape = {
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Guest addresses. Every one must be on this account's allowedRecipients — an attendee receives the invitation.",
    ),
  sendUpdates: z
    .enum(SEND_UPDATES)
    .optional()
    .describe('Whether Google mails the guests. Defaults to "none".'),
};

const calendarIdShape = {
  calendarId: z.string().min(1).optional().describe('Calendar id; defaults to "primary".'),
};

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

export function registerCalendarWriteTools(server: McpServer): void {
  server.tool(
    "calendar_create_event",
    "Create an event on one Google Calendar. Timed events need start and end as RFC3339 timestamps carrying a UTC offset; all-day events need startDate and endDate, where endDate is exclusive. Guests are only accepted if they are on the account's allowedRecipients, and no notification mail is sent unless sendUpdates is \"all\".",
    {
      ...accountShape,
      ...calendarIdShape,
      summary: z.string().min(1).describe("Event title."),
      ...timeShape,
      ...fieldShape,
    },
    async ({ account, ...input }) =>
      safeTool(async () => {
        assertCalendarWriteScope(account);
        assertAttendeesAllowed(input.attendees, getAccountConfig(account).allowedRecipients, account);
        return await withCalendarScopeErrors(account, async () => {
          const calendar = await calendarForAccount(account);
          return await createEvent(calendar, input);
        });
      }, account),
  );

  server.tool(
    "calendar_update_event",
    "Change fields of an existing event: title, description, location, guests, or its start and end. Only the fields passed are written, except attendees, which replaces the whole guest list. Guarded with the event's etag, so a change made elsewhere in the meantime fails the write instead of overwriting it. A recurring series id is refused unless confirmSeries is true.",
    {
      ...accountShape,
      ...calendarIdShape,
      eventId: z.string().min(1).describe("Event id, as returned by calendar_list_events."),
      summary: z.string().min(1).optional().describe("New event title."),
      ...timeShape,
      ...fieldShape,
      confirmSeries: z
        .boolean()
        .optional()
        .describe("Required to change a recurring series, which changes every occurrence."),
    },
    async ({ account, ...input }) =>
      safeTool(async () => {
        assertCalendarWriteScope(account);
        assertAttendeesAllowed(input.attendees, getAccountConfig(account).allowedRecipients, account);
        return await withCalendarScopeErrors(account, async () => {
          const calendar = await calendarForAccount(account);
          return await updateEvent(calendar, input);
        });
      }, account),
  );

  server.tool(
    "calendar_delete_event",
    "Delete an event. THIS CANNOT BE UNDONE — Google Calendar keeps no trash for events. Without confirm: true it changes nothing and returns the event it would delete, so the decision is made against the real title and time. A recurring series id is refused unless confirmSeries is true.",
    {
      ...accountShape,
      ...calendarIdShape,
      eventId: z.string().min(1).describe("Event id, as returned by calendar_list_events."),
      confirm: z.boolean().optional().describe("Must be true to actually delete."),
      confirmSeries: z
        .boolean()
        .optional()
        .describe("Required to delete a recurring series, which removes every occurrence."),
      sendUpdates: z
        .enum(SEND_UPDATES)
        .optional()
        .describe('Whether Google mails the guests about the cancellation. Defaults to "none".'),
    },
    async ({ account, ...input }) =>
      safeTool(async () => {
        assertCalendarWriteScope(account);
        return await withCalendarScopeErrors(account, async () => {
          const calendar = await calendarForAccount(account);
          return await deleteEvent(calendar, input);
        });
      }, account),
  );
}
