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

test("checkRecipients returns no verdicts for no addresses, which callers must not read as approval", () => {
  assert.deepEqual(checkRecipients([], allowlist), []);
});

test("extractAddresses keeps surrounding single quotes in the token so a decorated address is refused, not silently allowed", () => {
  const found = extractAddresses("'evil@attacker.com'");
  assert.deepEqual(found, ["'evil@attacker.com'"]);
  assert.equal(allowed(found), false);
});

test("extractAddresses trims a trailing full stop after an address", () => {
  assert.deepEqual(extractAddresses("Reach me at alice@example.com."), ["alice@example.com"]);
});

test("extractAddresses does not lose an address with an apostrophe adjacent to the @, and it is refused", () => {
  const found = extractAddresses("evil'@attacker.com");
  assert.ok(found.length > 0, `expected the address to be extracted, got ${JSON.stringify(found)}`);
  assert.equal(allowed(found), false);
});

test("extractAddresses does not lose an address with a brace adjacent to the @, and it is refused", () => {
  const found = extractAddresses("evil{@attacker.com");
  assert.ok(found.length > 0, `expected the address to be extracted, got ${JSON.stringify(found)}`);
  assert.equal(allowed(found), false);
});

test("extractAddresses does not lose an address with a double quote adjacent to the @, and it is refused", () => {
  const found = extractAddresses('"evil"@attacker.com');
  assert.ok(found.length > 0, `expected the address to be extracted, got ${JSON.stringify(found)}`);
  assert.equal(allowed(found), false);
});

test("a benign address alongside a decorated hostile one: both are extracted and the send is refused", () => {
  const found = extractAddresses("allowed@ok.com, evil'@attacker.com");
  assert.equal(found.length, 2, `expected both addresses, got ${JSON.stringify(found)}`);
  const verdicts = checkRecipients(found, ["allowed@ok.com"]);
  assert.equal(verdicts.length, 2);
  assert.ok(
    verdicts.some((v) => !v.allowed),
    "expected the decorated hostile address to be refused",
  );
  assert.equal(
    verdicts.length > 0 && verdicts.every((v) => v.allowed),
    false,
    "overall verdict must be refused when any recipient is refused",
  );
});
