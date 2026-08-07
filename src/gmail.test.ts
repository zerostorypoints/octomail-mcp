import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAccountError, isInvalidGrantError } from "./gmail.js";

test("isInvalidGrantError detects a Gaxios response body", () => {
  assert.equal(isInvalidGrantError({ response: { data: { error: "invalid_grant" } } }), true);
});

test("isInvalidGrantError detects it in the message", () => {
  assert.equal(isInvalidGrantError(new Error("invalid_grant: Token has been expired or revoked.")), true);
});

test("isInvalidGrantError ignores unrelated errors", () => {
  assert.equal(isInvalidGrantError(new Error("Rate limit exceeded")), false);
});

test("isInvalidGrantError tolerates null and primitives", () => {
  assert.equal(isInvalidGrantError(null), false);
  assert.equal(isInvalidGrantError("invalid_grant"), false);
});

test("describeAccountError names the account and the fix command", () => {
  const message = describeAccountError("work", new Error("invalid_grant"));
  assert.match(message, /Gmail account "work"/);
  assert.match(message, /npm run auth -- --account work/);
  assert.match(message, /7 days/);
});

test("describeAccountError passes other errors through unchanged", () => {
  assert.equal(describeAccountError("work", new Error("Rate limit exceeded")), "Rate limit exceeded");
});

test("describeAccountError stringifies non-Error values", () => {
  assert.equal(describeAccountError("work", "boom"), "boom");
});
