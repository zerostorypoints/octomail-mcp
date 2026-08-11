import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTH_SCOPES, CALENDAR_SCOPE, GMAIL_SCOPES, describeMissingCalendarScope } from "./gmail.js";

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
