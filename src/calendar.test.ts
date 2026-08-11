import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTH_SCOPES, CALENDAR_SCOPE, GMAIL_SCOPES, describeMissingCalendarScope } from "./gmail.js";
import { summarizeEvent } from "./calendar.js";

test("CALENDAR_SCOPE is the read-only calendar scope", () => {
  assert.equal(CALENDAR_SCOPE, "https://www.googleapis.com/auth/calendar.readonly");
});

test("AUTH_SCOPES keeps every Gmail scope and adds calendar", () => {
  for (const scope of GMAIL_SCOPES) {
    assert.ok(AUTH_SCOPES.includes(scope), `${scope} missing from AUTH_SCOPES`);
  }
  assert.ok(AUTH_SCOPES.includes(CALENDAR_SCOPE));
  assert.equal(AUTH_SCOPES.length, GMAIL_SCOPES.length + 1);
});

test("AUTH_SCOPES grants no write access to calendars", () => {
  assert.ok(!AUTH_SCOPES.some((s) => s === "https://www.googleapis.com/auth/calendar"));
  assert.ok(!AUTH_SCOPES.some((s) => s.endsWith("/calendar.events")));
});

test("describeMissingCalendarScope names the account and the re-auth command", () => {
  const message = describeMissingCalendarScope("work");
  assert.match(message, /work/);
  assert.match(message, /npm run auth -- --account work/);
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
