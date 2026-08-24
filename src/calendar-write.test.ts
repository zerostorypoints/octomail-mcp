import { test } from "node:test";
import assert from "node:assert/strict";
import type { calendar_v3 } from "googleapis";
import {
  assertAttendeesAllowed,
  createEvent,
  deleteEvent,
  eventRequestBody,
  eventTimes,
  updateEvent,
  type WritableCalendarClient,
} from "./calendar-write.js";

test("eventTimes builds a timed event from an offset-carrying range", () => {
  const times = eventTimes({ start: "2026-08-18T14:00:00+02:00", end: "2026-08-18T15:00:00+02:00" });
  assert.deepEqual(times, {
    start: { dateTime: "2026-08-18T14:00:00+02:00" },
    end: { dateTime: "2026-08-18T15:00:00+02:00" },
  });
});

test("eventTimes refuses a timestamp without an offset", () => {
  assert.throws(
    () => eventTimes({ start: "2026-08-18T14:00:00", end: "2026-08-18T15:00:00" }),
    /UTC offset/,
  );
});

test("eventTimes refuses an end that is not after the start", () => {
  assert.throws(
    () => eventTimes({ start: "2026-08-18T14:00:00Z", end: "2026-08-18T14:00:00Z" }),
    /end must be after start/,
  );
});

test("eventTimes builds an all-day event and treats endDate as exclusive", () => {
  assert.deepEqual(eventTimes({ startDate: "2026-08-18", endDate: "2026-08-19" }), {
    start: { date: "2026-08-18" },
    end: { date: "2026-08-19" },
  });
  assert.throws(() => eventTimes({ startDate: "2026-08-18", endDate: "2026-08-18" }), /exclusive/);
});

test("eventTimes refuses mixing a timed range with all-day dates", () => {
  assert.throws(
    () => eventTimes({ start: "2026-08-18T14:00:00Z", endDate: "2026-08-19" }),
    /either timed .* or all-day/,
  );
});

test("eventRequestBody omits fields the caller did not pass", () => {
  const body = eventRequestBody({ summary: "Przelew" }, undefined);
  assert.deepEqual(body, { summary: "Przelew" });
  assert.equal("description" in body, false);
  assert.equal("start" in body, false);
});

test("assertAttendeesAllowed passes an allowlisted guest and refuses others", () => {
  assert.doesNotThrow(() =>
    assertAttendeesAllowed(["alice@example.org"], ["@example.org"], "work"),
  );
  assert.throws(
    () => assertAttendeesAllowed(["stranger@example.com"], ["@example.org"], "work"),
    /allowedRecipients/,
  );
});

test("assertAttendeesAllowed refuses every guest when the account has no allowlist", () => {
  assert.throws(
    () => assertAttendeesAllowed(["alice@example.org"], undefined, "work"),
    /Nothing was written/,
  );
});

test("assertAttendeesAllowed is a no-op without attendees", () => {
  assert.doesNotThrow(() => assertAttendeesAllowed(undefined, undefined, "work"));
  assert.doesNotThrow(() => assertAttendeesAllowed([], undefined, "work"));
});

type Call = { name: string; params: unknown; options?: unknown };

function fakeCalendar(
  stored: calendar_v3.Schema$Event,
  behaviour: { patchError?: unknown; deleteError?: unknown } = {},
): { calendar: WritableCalendarClient; calls: Call[] } {
  const calls: Call[] = [];
  const calendar: WritableCalendarClient = {
    events: {
      async get(params) {
        calls.push({ name: "get", params });
        return { data: stored };
      },
      async insert(params) {
        calls.push({ name: "insert", params });
        return { data: { id: "new-event", etag: '"1"', ...params.requestBody } };
      },
      async patch(params, options) {
        calls.push({ name: "patch", params, options });
        if (behaviour.patchError) {
          throw behaviour.patchError;
        }
        return { data: { ...stored, ...params.requestBody } };
      },
      async delete(params, options) {
        calls.push({ name: "delete", params, options });
        if (behaviour.deleteError) {
          throw behaviour.deleteError;
        }
        return {};
      },
    },
  };
  return { calendar, calls };
}

test("createEvent defaults to the primary calendar and sends no mail", async () => {
  const { calendar, calls } = fakeCalendar({});
  const result = await createEvent(calendar, {
    summary: "Termin przelewu",
    startDate: "2026-08-24",
    endDate: "2026-08-25",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "insert");
  const params = calls[0].params as { calendarId: string; sendUpdates: string };
  assert.equal(params.calendarId, "primary");
  assert.equal(params.sendUpdates, "none");
  assert.equal(result.calendarId, "primary");
  assert.equal(result.summary, "Termin przelewu");
  assert.equal(result.allDay, true);
});

test("updateEvent guards the write with the etag it read", async () => {
  const { calendar, calls } = fakeCalendar({ id: "e1", etag: '"abc"', summary: "Stary tytuł" });
  const result = await updateEvent(calendar, { eventId: "e1", summary: "Nowy tytuł" });

  const patch = calls.find((call) => call.name === "patch");
  assert.ok(patch);
  assert.deepEqual(patch.options, { headers: { "If-Match": '"abc"' } });
  assert.deepEqual((patch.params as { requestBody: unknown }).requestBody, { summary: "Nowy tytuł" });
  assert.equal(result.summary, "Nowy tytuł");
});

test("updateEvent refuses a call that names no field to change", async () => {
  const { calendar, calls } = fakeCalendar({ id: "e1", etag: '"abc"' });
  await assert.rejects(() => updateEvent(calendar, { eventId: "e1" }), /names no field to change/);
  assert.equal(calls.length, 0, "the event must not even be read for an empty change");
});

test("updateEvent refuses a recurring series unless confirmSeries is set", async () => {
  const series = { id: "e1", etag: '"abc"', recurrence: ["RRULE:FREQ=WEEKLY"] };
  const first = fakeCalendar(series);
  await assert.rejects(
    () => updateEvent(first.calendar, { eventId: "e1", summary: "x" }),
    /recurring series/,
  );
  assert.equal(first.calls.some((call) => call.name === "patch"), false);

  const second = fakeCalendar(series);
  await updateEvent(second.calendar, { eventId: "e1", summary: "x", confirmSeries: true });
  assert.ok(second.calls.some((call) => call.name === "patch"));
});

test("updateEvent turns a 412 into a re-read instruction", async () => {
  const { calendar } = fakeCalendar({ id: "e1", etag: '"abc"' }, { patchError: { code: 412 } });
  await assert.rejects(
    () => updateEvent(calendar, { eventId: "e1", summary: "x" }),
    /changed while the change was being prepared/,
  );
});

test("updateEvent refuses to write an event Google returned without an etag", async () => {
  const { calendar, calls } = fakeCalendar({ id: "e1", summary: "bez etagu" });
  await assert.rejects(() => updateEvent(calendar, { eventId: "e1", summary: "x" }), /without an etag/);
  assert.equal(calls.some((call) => call.name === "patch"), false);
});

test("deleteEvent without confirm reports the target and deletes nothing", async () => {
  const { calendar, calls } = fakeCalendar({
    id: "e1",
    etag: '"abc"',
    summary: "Spotkanie",
    start: { dateTime: "2026-08-18T14:00:00+02:00" },
  });
  const result = await deleteEvent(calendar, { eventId: "e1" });

  assert.equal(result.deleted, false);
  assert.equal(result.wouldDelete?.summary, "Spotkanie");
  assert.equal(calls.some((call) => call.name === "delete"), false);
});

test("deleteEvent with confirm deletes under If-Match and reports what went", async () => {
  const { calendar, calls } = fakeCalendar({ id: "e1", etag: '"abc"', summary: "Spotkanie" });
  const result = await deleteEvent(calendar, { eventId: "e1", confirm: true });

  const del = calls.find((call) => call.name === "delete");
  assert.ok(del);
  assert.deepEqual(del.options, { headers: { "If-Match": '"abc"' } });
  assert.equal((del.params as { sendUpdates: string }).sendUpdates, "none");
  assert.equal(result.deleted, true);
  assert.equal(result.event?.summary, "Spotkanie");
});

test("deleteEvent refuses a confirmed delete of a series without confirmSeries", async () => {
  const { calendar, calls } = fakeCalendar({
    id: "e1",
    etag: '"abc"',
    recurrence: ["RRULE:FREQ=WEEKLY"],
  });
  await assert.rejects(
    () => deleteEvent(calendar, { eventId: "e1", confirm: true }),
    /recurring series/,
  );
  assert.equal(calls.some((call) => call.name === "delete"), false);
});
