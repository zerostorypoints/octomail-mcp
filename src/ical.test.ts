import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FEED_BYTES, feedFetchUrl, fetchFeed, parseFeed } from "./ical.js";

test("feedFetchUrl rewrites webcal to https", () => {
  assert.equal(feedFetchUrl("webcal://example.com/cal.ics"), "https://example.com/cal.ics");
  assert.equal(feedFetchUrl("WEBCAL://example.com/cal.ics"), "https://example.com/cal.ics");
});

test("feedFetchUrl refuses plain http, because a feed URL is a bearer secret", () => {
  assert.throws(() => feedFetchUrl("http://example.com/cal.ics"), /must be https/);
});

test("feedFetchUrl refuses something that is not a URL", () => {
  assert.throws(() => feedFetchUrl("not a url"), /not a URL/);
});

function icsWith(body: string): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", body, "END:VCALENDAR"].join("\r\n");
}

const WINDOW = { from: new Date("2026-08-17T00:00:00Z"), to: new Date("2026-08-24T00:00:00Z") };

test("parseFeed returns a single timed event inside the window", () => {
  const ics = icsWith(
    [
      "BEGIN:VEVENT",
      "UID:one@test",
      "SUMMARY:Przelew",
      "LOCATION:ING",
      "DESCRIPTION:100 tys.",
      "DTSTART:20260818T120000Z",
      "DTEND:20260818T130000Z",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const events = parseFeed(ics, WINDOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, "Przelew");
  assert.equal(events[0].location, "ING");
  assert.equal(events[0].description, "100 tys.");
  assert.equal(events[0].start, "2026-08-18T12:00:00.000Z");
  assert.equal(events[0].allDay, false);
  assert.equal(events[0].uid, "one@test");
});

test("parseFeed drops events outside the window and keeps ones overlapping it", () => {
  const ics = icsWith(
    [
      "BEGIN:VEVENT",
      "UID:before@test",
      "SUMMARY:Dawno temu",
      "DTSTART:20260701T120000Z",
      "DTEND:20260701T130000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:straddling@test",
      "SUMMARY:Trwa przez okno",
      "DTSTART:20260816T120000Z",
      "DTEND:20260819T130000Z",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const events = parseFeed(ics, WINDOW);
  assert.deepEqual(
    events.map((event) => event.uid),
    ["straddling@test"],
  );
});

test("parseFeed marks an all-day event", () => {
  const ics = icsWith(
    [
      "BEGIN:VEVENT",
      "UID:allday@test",
      "SUMMARY:Termin przelewu",
      "DTSTART;VALUE=DATE:20260820",
      "DTEND;VALUE=DATE:20260821",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const events = parseFeed(ics, WINDOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].allDay, true);
});

test("parseFeed expands a weekly rule into one occurrence per week in the window", () => {
  const ics = icsWith(
    [
      "BEGIN:VEVENT",
      "UID:weekly@test",
      "SUMMARY:Status co poniedzialek",
      "DTSTART:20260803T080000Z",
      "DTEND:20260803T083000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const events = parseFeed(ics, WINDOW);
  assert.equal(events.length, 1, "one Monday falls inside 17–24.08");
  assert.equal(events[0].start, "2026-08-17T08:00:00.000Z");
  assert.equal(events[0].fromRecurrence, true);
});

test("parseFeed applies an override of a single occurrence instead of listing it twice", () => {
  const ics = icsWith(
    [
      "BEGIN:VEVENT",
      "UID:weekly@test",
      "SUMMARY:Status co poniedzialek",
      "DTSTART:20260803T080000Z",
      "DTEND:20260803T083000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:weekly@test",
      "RECURRENCE-ID:20260817T080000Z",
      "SUMMARY:Status przesuniety",
      "DTSTART:20260817T100000Z",
      "DTEND:20260817T103000Z",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const events = parseFeed(ics, WINDOW);
  assert.equal(events.length, 1, "the override must not be emitted as a second event");
  assert.equal(events[0].summary, "Status przesuniety");
  assert.equal(events[0].start, "2026-08-17T10:00:00.000Z");
});

test("parseFeed honours an EXDATE by leaving that occurrence out", () => {
  const ics = icsWith(
    [
      "BEGIN:VEVENT",
      "UID:weekly@test",
      "SUMMARY:Status co poniedzialek",
      "DTSTART:20260803T080000Z",
      "DTEND:20260803T083000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE:20260817T080000Z",
      "END:VEVENT",
    ].join("\r\n"),
  );

  assert.deepEqual(parseFeed(ics, WINDOW), []);
});

test("parseFeed sorts by start and honours maxResults", () => {
  const ics = icsWith(
    [
      "BEGIN:VEVENT",
      "UID:daily@test",
      "SUMMARY:Codziennie",
      "DTSTART:20260817T060000Z",
      "DTEND:20260817T061500Z",
      "RRULE:FREQ=DAILY",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const events = parseFeed(ics, WINDOW, 3);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((event) => event.start),
    ["2026-08-17T06:00:00.000Z", "2026-08-18T06:00:00.000Z", "2026-08-19T06:00:00.000Z"],
  );
});

test("parseFeed explains itself when the URL served HTML instead of iCalendar", () => {
  assert.throws(() => parseFeed("<!doctype html><html><body>Sign in</body></html>", WINDOW), /not parseable iCalendar/);
});

test("fetchFeed refuses a body over the size cap", async () => {
  const oversized = "x".repeat(MAX_FEED_BYTES + 1);
  const fakeFetch = (async () =>
    new Response(oversized, { status: 200, headers: {} })) as unknown as typeof fetch;

  await assert.rejects(() => fetchFeed("https://example.com/cal.ics", fakeFetch), /over the .* cap/);
});

test("fetchFeed reports an HTTP error with the rotated-link hint", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchFeed("https://example.com/cal.ics", fakeFetch), /HTTP 404/);
});

test("fetchFeed returns the body of a healthy response", async () => {
  const fakeFetch = (async () =>
    new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR", { status: 200 })) as unknown as typeof fetch;
  assert.equal(await fetchFeed("webcal://example.com/cal.ics", fakeFetch), "BEGIN:VCALENDAR\r\nEND:VCALENDAR");
});
