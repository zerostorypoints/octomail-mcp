import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTH_SCOPES, CALENDAR_EVENTS_SCOPE, CALENDAR_SCOPE, GMAIL_SCOPES, describeMissingCalendarScope } from "./gmail.js";
import type { calendar_v3 } from "googleapis";
import {
  calendarEventsRequest,
  findOwnAttendee,
  isPreconditionFailedError,
  missingCalendarWriteScope,
  respondToEvent,
  rsvpAttendees,
  summarizeEvent,
} from "./calendar.js";

test("CALENDAR_SCOPE is the read-only calendar scope", () => {
  assert.equal(CALENDAR_SCOPE, "https://www.googleapis.com/auth/calendar.readonly");
});

test("AUTH_SCOPES keeps every Gmail scope and adds both calendar scopes", () => {
  for (const scope of GMAIL_SCOPES) {
    assert.ok(AUTH_SCOPES.includes(scope), `${scope} missing from AUTH_SCOPES`);
  }
  assert.ok(AUTH_SCOPES.includes(CALENDAR_SCOPE));
  assert.ok(AUTH_SCOPES.includes(CALENDAR_EVENTS_SCOPE));
  assert.equal(AUTH_SCOPES.length, GMAIL_SCOPES.length + 2);
});

test("AUTH_SCOPES grants no calendar-admin access (create/delete calendars, ACLs)", () => {
  // Exact equality, not endsWith("/calendar") — calendar.events legitimately
  // ends in a longer string containing "calendar", and a substring/suffix
  // check would false-fail the moment that scope was added.
  assert.ok(!AUTH_SCOPES.some((s) => s === "https://www.googleapis.com/auth/calendar"));
});

test("describeMissingCalendarScope names the account and the re-auth command", () => {
  const message = describeMissingCalendarScope("work");
  assert.match(message, /work/);
  assert.match(message, /npm run auth -- --account work/);
});

test("summarizeEvent returns description and creator", () => {
  // A caller that writes events needs both to recognise its own events on a
  // later read: the description carries the stamp it wrote, the creator says
  // whose account wrote it. Without them, deleting "my own" events is guesswork.
  const summary = summarizeEvent({
    id: "evt-mine",
    summary: "[mirror] Busy (work)",
    description: "sync-bot: work/abc123",
    creator: { email: "bot@example.com" },
    start: { dateTime: "2026-08-12T09:00:00+02:00" },
    end: { dateTime: "2026-08-12T09:30:00+02:00" },
  });

  assert.equal(summary.description, "sync-bot: work/abc123");
  assert.equal(summary.creator, "bot@example.com");
});

test("summarizeEvent trims a long description and drops an empty one", () => {
  const long = summarizeEvent({
    id: "evt-long",
    description: "x".repeat(700),
    start: { dateTime: "2026-08-12T09:00:00+02:00" },
    end: { dateTime: "2026-08-12T09:30:00+02:00" },
  });
  assert.equal(long.description?.length, 501);
  assert.ok(long.description?.endsWith("\u2026"));

  const blank = summarizeEvent({
    id: "evt-blank",
    description: "   ",
    start: { dateTime: "2026-08-12T09:00:00+02:00" },
    end: { dateTime: "2026-08-12T09:30:00+02:00" },
  });
  assert.equal(blank.description, undefined);
});

test("summarizeEvent reports a timed event as not all-day", () => {
  const summary = summarizeEvent({
    id: "evt1",
    status: "confirmed",
    summary: "Sync z inwestorem",
    location: "Zoom",
    start: { dateTime: "2026-08-12T09:00:00+02:00", timeZone: "Europe/Warsaw" },
    end: { dateTime: "2026-08-12T09:30:00+02:00", timeZone: "Europe/Warsaw" },
    organizer: { email: "alice@example.com" },
    attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
  });

  assert.equal(summary.id, "evt1");
  assert.equal(summary.allDay, false);
  assert.equal(summary.summary, "Sync z inwestorem");
  assert.equal(summary.location, "Zoom");
  assert.equal(summary.start.dateTime, "2026-08-12T09:00:00+02:00");
  assert.equal(summary.organizer, "alice@example.com");
  assert.equal(summary.attendeeCount, 2);
});

test("summarizeEvent surfaces this calendar's own answer to the invitation", () => {
  const summary = summarizeEvent({
    id: "evt_invite",
    start: { dateTime: "2026-08-14T09:00:00+02:00" },
    end: { dateTime: "2026-08-14T10:00:00+02:00" },
    attendees: [
      { email: "organizer@example.com", responseStatus: "accepted", organizer: true },
      { email: "me@example.com", responseStatus: "needsAction", self: true },
    ],
  });

  assert.equal(summary.myResponseStatus, "needsAction");
});

test("summarizeEvent leaves the own answer undefined when there are no attendees", () => {
  assert.equal(summarizeEvent({ id: "solo", start: { date: "2026-08-15" } }).myResponseStatus, undefined);
});

test("summarizeEvent keeps Google's own event kind and free/busy setting", () => {
  const summary = summarizeEvent({
    id: "evt_focus",
    summary: "Cokolwiek uzytkownik wpisal",
    eventType: "focusTime",
    transparency: "transparent",
    start: { dateTime: "2026-08-14T09:00:00+02:00" },
    end: { dateTime: "2026-08-14T11:00:00+02:00" },
  });

  assert.equal(summary.eventType, "focusTime");
  assert.equal(summary.transparency, "transparent");
});

test("summarizeEvent reports a date-only event as all-day", () => {
  const summary = summarizeEvent({
    id: "evt2",
    start: { date: "2026-08-15" },
    end: { date: "2026-08-16" },
  });

  assert.equal(summary.allDay, true);
  assert.equal(summary.start.date, "2026-08-15");
  assert.equal(summary.start.dateTime, undefined);
});

test("summarizeEvent survives a nearly empty event", () => {
  const summary = summarizeEvent({});
  assert.equal(summary.id, undefined);
  assert.equal(summary.allDay, false);
  assert.equal(summary.attendeeCount, undefined);
  assert.equal(summary.organizer, undefined);
});

test("summarizeEvent keeps cancellation visible", () => {
  const summary = summarizeEvent({ id: "evt3", status: "cancelled", start: { date: "2026-08-15" } });
  assert.equal(summary.status, "cancelled");
});

test("calendarEventsRequest defaults to the primary calendar and expands recurrences", () => {
  const request = calendarEventsRequest({ timeMin: "2026-08-12T00:00:00Z", timeMax: "2026-08-13T00:00:00Z" });
  assert.equal(request.calendarId, "primary");
  assert.equal(request.singleEvents, true);
  assert.equal(request.orderBy, "startTime");
  assert.equal(request.maxResults, 50);
  assert.equal(request.timeMin, "2026-08-12T00:00:00Z");
  assert.equal(request.timeMax, "2026-08-13T00:00:00Z");
});

test("calendarEventsRequest passes through an explicit calendar and limit", () => {
  const request = calendarEventsRequest({
    calendarId: "team@group.calendar.google.com",
    timeMin: "2026-08-12T00:00:00Z",
    timeMax: "2026-08-19T00:00:00Z",
    maxResults: 5,
  });
  assert.equal(request.calendarId, "team@group.calendar.google.com");
  assert.equal(request.maxResults, 5);
});

test("summarizeEvent returns a conference-detail description, trimmed", () => {
  // This used to assert the opposite: descriptions were dropped as ballast.
  // They are returned now because a writing caller has no other way to
  // recognise the events it created itself. The ballast concern is answered
  // by DESCRIPTION_LIMIT, not by dropping the field.
  const summary = summarizeEvent({
    id: "evt_with_desc",
    summary: "Team standup",
    description: "https://zoom.us/j/123456789?pwd=abc123def456ghi789jklmnopqrst==\n\nMeeting ID: 123 456 789\nAccess Code: 987654",
    start: { dateTime: "2026-08-12T10:00:00Z" },
    end: { dateTime: "2026-08-12T10:30:00Z" },
  });

  assert.equal(summary.id, "evt_with_desc");
  assert.equal(summary.summary, "Team standup");
  assert.ok(summary.description?.startsWith("https://zoom.us/j/123456789"));
});

// --- RSVP -------------------------------------------------------------------

const SELF = "me@example.com";

const invited: calendar_v3.Schema$Event = {
  id: "evt_rsvp",
  etag: '"3181161784712000"',
  summary: "Kickoff",
  location: "Warszawa, Prosta 51",
  start: { dateTime: "2026-08-14T10:00:00+02:00" },
  end: { dateTime: "2026-08-14T11:00:00+02:00" },
  organizer: { email: "organizer@example.com" },
  attendees: [
    { email: "organizer@example.com", responseStatus: "accepted", organizer: true },
    { email: "me@example.com", responseStatus: "needsAction", self: true },
    { email: "other@example.com", responseStatus: "tentative", comment: "moge sie spoznic" },
  ],
};

function fakeCalendar(event: calendar_v3.Schema$Event | Error) {
  const calls: { get: unknown[]; patch: { params: any; options?: any }[] } = { get: [], patch: [] };
  const client = {
    events: {
      async get(params: any) {
        calls.get.push(params);
        if (event instanceof Error) {
          throw event;
        }
        // Google hands back a fresh object per call; hand back a copy so a test
        // cannot pass by mutating the fixture in place.
        return { data: structuredClone(event) };
      },
      async patch(params: any, options?: any) {
        calls.patch.push({ params, options });
        return { data: { ...structuredClone(event as calendar_v3.Schema$Event), ...params.requestBody } };
      },
    },
  };
  return { client, calls };
}

test("rsvpAttendees answers only for this account's own entry", () => {
  const before = structuredClone(invited.attendees!);
  const attendees = rsvpAttendees(invited.attendees, SELF, "accepted", undefined);

  assert.equal(attendees[1].responseStatus, "accepted");
  assert.equal(attendees[1].email, SELF);
  // Everyone else survives byte-identical, including their own answers. Compared
  // against a copy taken beforehand: the returned entries are the same objects,
  // so comparing them with the fixture would compare each object with itself.
  assert.deepEqual(attendees[0], before[0]);
  assert.deepEqual(attendees[2], before[2]);
});

test("rsvpAttendees records a decline the same way", () => {
  const attendees = rsvpAttendees(invited.attendees, SELF, "declined", undefined);
  assert.equal(attendees[1].responseStatus, "declined");
});

test("rsvpAttendees attaches a comment to this account's entry only", () => {
  const attendees = rsvpAttendees(invited.attendees, SELF, "tentative", "oddzwonie w poniedzialek");

  assert.equal(attendees[1].comment, "oddzwonie w poniedzialek");
  assert.equal(attendees[2].comment, "moge sie spoznic");
});

test("rsvpAttendees without a comment leaves an existing one untouched", () => {
  const withComment = [{ email: SELF, self: true, responseStatus: "needsAction", comment: "stary" }];
  const attendees = rsvpAttendees(withComment, SELF, "accepted", undefined);
  assert.equal(attendees[0].comment, "stary");
});

test("findOwnAttendee refuses an event the account is not invited to", () => {
  assert.throws(
    () => findOwnAttendee([{ email: "someone@example.com", self: true, responseStatus: "accepted" }], SELF),
    /not an attendee/i,
  );
  assert.throws(() => findOwnAttendee(undefined, SELF), /not an attendee/i);
  assert.throws(() => findOwnAttendee([], SELF), /not an attendee/i);
});

test("findOwnAttendee matches the address regardless of case and padding", () => {
  const attendees = [{ email: "organizer@example.com" }, { email: " Me@Example.com ", self: true }];
  assert.equal(findOwnAttendee(attendees, SELF), 1);
});

test("findOwnAttendee refuses a copy of the event that belongs to another calendar", () => {
  // A shared calendar the account can write to: Google marks the calendar
  // owner as `self`, and the account's own entry carries no `self` at all.
  // Answering by `self` here would rewrite the owner's answer.
  const shared = [
    { email: "boss@example.com", self: true, responseStatus: "accepted" },
    { email: SELF, responseStatus: "needsAction" },
  ];

  assert.throws(() => findOwnAttendee(shared, SELF), /another calendar/i);
});

test("findOwnAttendee refuses an event listing this account twice", () => {
  const twice = [
    { email: SELF, self: true, responseStatus: "needsAction" },
    { email: SELF, self: true, responseStatus: "accepted" },
  ];

  assert.throws(() => findOwnAttendee(twice, SELF), /more than once/i);
});

test("respondToEvent patches the attendees field and nothing else", async () => {
  const { client, calls } = fakeCalendar(invited);

  await respondToEvent(client, { eventId: "evt_rsvp", selfEmail: SELF, response: "accepted" });

  assert.equal(calls.patch.length, 1);
  const { params } = calls.patch[0];
  assert.deepEqual(Object.keys(params.requestBody), ["attendees"]);
  assert.equal(params.calendarId, "primary");
  assert.equal(params.eventId, "evt_rsvp");
  assert.equal(params.requestBody.attendees[1].responseStatus, "accepted");
  // The other guests reach the wire exactly as they were read.
  assert.deepEqual(params.requestBody.attendees[0], invited.attendees![0]);
  assert.deepEqual(params.requestBody.attendees[2], invited.attendees![2]);
});

test("respondToEvent sends no notification mail of its own", async () => {
  // "all" would mail every guest on the invitation; the answer itself still
  // reaches the organizer's copy of the event.
  const { client, calls } = fakeCalendar(invited);

  await respondToEvent(client, { eventId: "evt_rsvp", selfEmail: SELF, response: "declined" });

  assert.equal(calls.patch[0].params.sendUpdates, "none");
});

test("respondToEvent guards the write with the event etag", async () => {
  const { client, calls } = fakeCalendar(invited);

  await respondToEvent(client, { eventId: "evt_rsvp", selfEmail: SELF, response: "declined" });

  assert.equal(calls.patch[0].options.headers["If-Match"], '"3181161784712000"');
});

test("respondToEvent refuses to write an event that came back without an etag", async () => {
  const { etag, ...noEtag } = invited;
  const { client, calls } = fakeCalendar(noEtag);

  await assert.rejects(
    () => respondToEvent(client, { eventId: "evt_rsvp", selfEmail: SELF, response: "accepted" }),
    /etag/i,
  );
  assert.equal(calls.patch.length, 0);
});

test("respondToEvent explains a lost race instead of leaking a status code", async () => {
  const { client } = fakeCalendar(invited);
  client.events.patch = async () => {
    throw Object.assign(new Error("Request failed with status code 412"), { code: 412 });
  };

  await assert.rejects(
    () => respondToEvent(client, { eventId: "evt_rsvp", selfEmail: SELF, response: "accepted" }),
    /changed while the answer was being prepared/i,
  );
});

test("respondToEvent passes an explicit calendar through to both calls", async () => {
  const { client, calls } = fakeCalendar(invited);

  await respondToEvent(client, {
    calendarId: "team@group.calendar.google.com",
    eventId: "evt_rsvp",
    selfEmail: SELF,
    response: "tentative",
  });

  assert.equal((calls.get[0] as any).calendarId, "team@group.calendar.google.com");
  assert.equal(calls.patch[0].params.calendarId, "team@group.calendar.google.com");
});

test("respondToEvent on a shared calendar will not answer for its owner", async () => {
  const boss: calendar_v3.Schema$Event = {
    id: "evt_boss",
    etag: '"1"',
    summary: "Cudze spotkanie",
    attendees: [
      { email: "boss@example.com", self: true, responseStatus: "needsAction" },
      { email: SELF, responseStatus: "accepted" },
    ],
  };
  const { client, calls } = fakeCalendar(boss);

  await assert.rejects(
    () =>
      respondToEvent(client, {
        calendarId: "boss@example.com",
        eventId: "evt_boss",
        selfEmail: SELF,
        response: "declined",
      }),
    /another calendar/i,
  );
  assert.equal(calls.patch.length, 0);
});

test("respondToEvent refuses a recurring series and points at the occurrence", async () => {
  const series: calendar_v3.Schema$Event = {
    ...invited,
    id: "evt_series",
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=10"],
  };
  const { client, calls } = fakeCalendar(series);

  await assert.rejects(
    () => respondToEvent(client, { eventId: "evt_series", selfEmail: SELF, response: "declined" }),
    /calendar_list_events/,
  );
  assert.equal(calls.patch.length, 0);
});

test("respondToEvent reports back the stored answer", async () => {
  const { client } = fakeCalendar(invited);

  const result = await respondToEvent(client, {
    eventId: "evt_rsvp",
    selfEmail: SELF,
    response: "accepted",
    comment: "bede",
  });

  assert.equal(result.eventId, "evt_rsvp");
  assert.equal(result.summary, "Kickoff");
  assert.equal(result.responseStatus, "accepted");
  assert.equal(result.attendee, SELF);
  assert.equal(result.comment, "bede");
});

test("respondToEvent on an unknown event writes nothing", async () => {
  const notFound = Object.assign(new Error("Not Found"), { code: 404 });
  const { client, calls } = fakeCalendar(notFound);

  await assert.rejects(
    () => respondToEvent(client, { eventId: "brak", selfEmail: SELF, response: "accepted" }),
    /Not Found/,
  );
  assert.equal(calls.patch.length, 0);
});

test("respondToEvent writes nothing when the account is not an attendee", async () => {
  const foreign: calendar_v3.Schema$Event = {
    id: "evt_foreign",
    etag: '"2"',
    summary: "Cudze spotkanie",
    attendees: [{ email: "someone@example.com", self: true, responseStatus: "accepted" }],
  };
  const { client, calls } = fakeCalendar(foreign);

  await assert.rejects(
    () => respondToEvent(client, { eventId: "evt_foreign", selfEmail: SELF, response: "accepted" }),
    /not an attendee/i,
  );
  assert.equal(calls.patch.length, 0);
});

test("isPreconditionFailedError recognises the shapes googleapis throws", () => {
  assert.equal(isPreconditionFailedError({ code: 412 }), true);
  assert.equal(isPreconditionFailedError({ response: { status: 412 } }), true);
  assert.equal(isPreconditionFailedError({ code: 404 }), false);
  assert.equal(isPreconditionFailedError(new Error("boom")), false);
  assert.equal(isPreconditionFailedError(undefined), false);
});

test("missingCalendarWriteScope names the account when only the read scope was granted", () => {
  const message = missingCalendarWriteScope({ scope: `${GMAIL_SCOPES[0]} ${CALENDAR_SCOPE}` }, "work");
  assert.equal(message, describeMissingCalendarScope("work"));
});

test("missingCalendarWriteScope passes a token that holds the events scope", () => {
  assert.equal(missingCalendarWriteScope({ scope: `${CALENDAR_SCOPE} ${CALENDAR_EVENTS_SCOPE}` }, "work"), undefined);
});

test("missingCalendarWriteScope lets Google answer when the token records no scope", () => {
  // Tokens written before the scope field was persisted read as unknown, not
  // as missing — same convention the read tools follow.
  assert.equal(missingCalendarWriteScope({}, "work"), undefined);
});
