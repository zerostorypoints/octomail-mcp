import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRecipients, extractAddresses } from "./recipients.js";

const allowlist = ["@example.com", "Jane.Doe@example.org"];
const allowed = (addresses: string[]) => checkRecipients(addresses, allowlist).every((verdict) => verdict.allowed);

test("extractAddresses reads a bare address", () => {
  assert.deepEqual(extractAddresses("alice@example.com"), ["alice@example.com"]);
});

test("extractAddresses reads an address inside angle brackets", () => {
  assert.deepEqual(extractAddresses("Alice <alice@example.com>"), ["alice@example.com"]);
});

test("extractAddresses reads every address across several headers", () => {
  const found = extractAddresses("a@example.com", "b@example.com", undefined, "c@example.com");
  assert.deepEqual(found.sort(), ["a@example.com", "b@example.com", "c@example.com"]);
});

test("extractAddresses is not fooled by a comma inside a quoted display name", () => {
  const found = extractAddresses('"Smith, John" <evil@attacker.com>');
  assert.ok(found.includes("evil@attacker.com"), `missed the real address: ${JSON.stringify(found)}`);
});

test("extractAddresses over-extracts rather than picking one address", () => {
  const found = extractAddresses("allowed@example.com <evil@attacker.com>");
  assert.equal(found.length, 2, `expected both addresses, got ${JSON.stringify(found)}`);
});

test("a spoofed display name cannot smuggle an outside recipient past the gate", () => {
  assert.equal(allowed(extractAddresses("allowed@example.com <evil@attacker.com>")), false);
});

test("checkRecipients allows an exact allowlist entry regardless of case", () => {
  assert.equal(allowed(["jane.doe@EXAMPLE.org"]), true);
});

test("checkRecipients allows any local part at an allowlisted domain", () => {
  assert.equal(allowed(["anyone@example.com"]), true);
});

test("checkRecipients does not treat a subdomain as the allowlisted domain", () => {
  assert.equal(allowed(["x@mail.example.com"]), false);
});

test("checkRecipients does not allow a domain that merely ends with an allowlisted one", () => {
  assert.equal(allowed(["x@notexample.com"]), false);
});

test("checkRecipients refuses everything when the allowlist is absent", () => {
  const verdicts = checkRecipients(["alice@example.com"], undefined);
  assert.equal(verdicts[0].allowed, false);
  assert.match(verdicts[0].reason ?? "", /allowedRecipients/);
});

test("checkRecipients refuses everything when the allowlist is empty", () => {
  assert.equal(checkRecipients(["alice@example.com"], [])[0].allowed, false);
});

test("checkRecipients refuses a Cyrillic homograph of an allowlisted domain", () => {
  // "ex\u0430mple.com" uses Cyrillic small a, which renders identically.
  const verdicts = checkRecipients(["alice@ex\u0430mple.com"], allowlist);
  assert.equal(verdicts[0].allowed, false);
  assert.match(verdicts[0].reason ?? "", /non-ASCII/i);
});

test("extractAddresses finds a non-ASCII address so the homograph check can refuse it", () => {
  assert.deepEqual(extractAddresses("alice@ex\u0430mple.com"), ["alice@ex\u0430mple.com"]);
});

test("checkRecipients refuses a token with no domain", () => {
  assert.equal(checkRecipients(["broken@"], allowlist)[0].allowed, false);
});

test("checkRecipients reports a verdict for every address, not just failures", () => {
  const verdicts = checkRecipients(["ok@example.com", "no@attacker.com"], allowlist);
  assert.equal(verdicts.length, 2);
  assert.equal(verdicts[0].allowed, true);
  assert.equal(verdicts[1].allowed, false);
});
