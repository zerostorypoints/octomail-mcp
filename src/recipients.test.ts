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

test("extractAddresses throws on the space-before-@ bypass rather than silently rewriting it", () => {
  const value = "evil @attacker.com";
  assert.throws(() => extractAddresses(value), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /could not be parsed safely/);
    assert.ok(err.message.includes(value), `expected message to quote the offending value: ${err.message}`);
    return true;
  });
});

test("extractAddresses throws on the space-after-@ bypass rather than silently rewriting it", () => {
  const value = "evil@ attacker.com";
  assert.throws(() => extractAddresses(value), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /could not be parsed safely/);
    assert.ok(err.message.includes(value), `expected message to quote the offending value: ${err.message}`);
    return true;
  });
});

test("a benign address alongside a space-decorated hostile one throws, quoting the value", () => {
  const value = "allowed@ok.com, evil @attacker.com";
  assert.throws(() => extractAddresses(value), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /could not be parsed safely/);
    assert.ok(err.message.includes(value), `expected message to quote the offending value: ${err.message}`);
    return true;
  });
});

test("a benign angle-bracket address alongside a space-decorated hostile angle-bracket one throws", () => {
  const value = "Good <allowed@ok.com>, Bad <evil @attacker.com>";
  assert.throws(() => extractAddresses(value), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /could not be parsed safely/);
    assert.ok(err.message.includes(value), `expected message to quote the offending value: ${err.message}`);
    return true;
  });
});

test("extractAddresses throws rather than silently dropping an @ no token can claim", () => {
  const value = "allowed@ok.com, evil,@attacker.com";
  assert.throws(() => extractAddresses(value), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /could not be parsed safely/);
    assert.ok(err.message.includes(value), `expected message to quote the offending value: ${err.message}`);
    return true;
  });
});

// Regression test for the merge bypass: under the old @-spacing normalisation,
// "a@x.com @b@y.com" collapsed into a single merged token
// ("a@x.com@b@y.com") whose domain (via lastIndexOf("@")) was judged on
// y.com alone, silently skipping the check on a@x.com — an unsafe allow.
// With normalisation removed, the tokenizer here happens to absorb the
// decorative `@` into the start of the second token's span (because it is
// immediately followed by "b", a non-excluded character) rather than
// leaving it unclaimed, so this does NOT throw. What matters is that it
// also does NOT produce the dangerous merged token: the two addresses stay
// separate, so a@x.com is judged on its own domain and refused independently.
test("extractAddresses does not merge adjacent addresses into one token, closing the merge bypass", () => {
  const value = "a@x.com @b@ok.com";
  const found = extractAddresses(value);
  assert.ok(
    !found.includes("a@x.com@b@ok.com"),
    `must not merge into a single token: ${JSON.stringify(found)}`,
  );
  assert.equal(found.length, 2, `expected two separate tokens, got ${JSON.stringify(found)}`);
  const verdicts = checkRecipients(found, ["@ok.com"]);
  assert.equal(
    verdicts.length > 0 && verdicts.every((v) => v.allowed),
    false,
    "a@x.com must be judged on its own domain and refuse the overall send",
  );
});

test("extractAddresses throws on a decorative @ in a display name rather than inventing a bogus token", () => {
  const value = "Sales @ Acme <sales@acme.com>";
  assert.throws(() => extractAddresses(value), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /could not be parsed safely/);
    assert.ok(err.message.includes(value), `expected message to quote the offending value: ${err.message}`);
    return true;
  });
});

test("an ordinary bare address is unaffected by removing @-spacing normalisation", () => {
  assert.deepEqual(extractAddresses("alice@example.com"), ["alice@example.com"]);
  assert.equal(allowed(["alice@example.com"]), true);
});

test("an ordinary Name <addr> pair is unaffected by removing @-spacing normalisation", () => {
  const found = extractAddresses("Alice <alice@example.com>");
  assert.deepEqual(found, ["alice@example.com"]);
  assert.equal(allowed(found), true);
});
