import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReferences, describeAllowlistRefusal, draftShape } from "./drafts.js";

test("attachment specs accept a download-root path", () => {
  assert.deepEqual(draftShape.attachments.parse([{ path: "faktura.pdf" }]), [{ path: "faktura.pdf" }]);
});

test("attachment specs accept a Gmail message reference", () => {
  assert.deepEqual(
    draftShape.attachments.parse([{ messageId: "m1", attachmentId: "a1" }]),
    [{ messageId: "m1", attachmentId: "a1" }],
  );
});

test("attachment specs reject a half-specified Gmail reference", () => {
  assert.throws(() => draftShape.attachments.parse([{ messageId: "m1" }]));
});

test("attachment specs reject an entry that is neither a path nor a Gmail reference", () => {
  assert.throws(() => draftShape.attachments.parse([{ filename: "faktura.pdf" }]));
});

test("buildReferences: a first reply, with no prior References, yields just the parent's Message-ID", () => {
  assert.equal(buildReferences(undefined, "<parent@example.com>"), "<parent@example.com>");
});

test("buildReferences: a subsequent reply appends the parent's Message-ID after the prior References", () => {
  assert.equal(
    buildReferences("<root@example.com> <mid1@example.com>", "<parent@example.com>"),
    "<root@example.com> <mid1@example.com> <parent@example.com>",
  );
});

test("buildReferences: both inputs absent omits the header rather than emitting it empty", () => {
  assert.equal(buildReferences(undefined, undefined), undefined);
});

test("buildReferences: a prior References with no parent Message-ID is returned unchanged", () => {
  assert.equal(buildReferences("<root@example.com> <mid1@example.com>", undefined), "<root@example.com> <mid1@example.com>");
});

test("the refusal names every failing address", () => {
  const message = describeAllowlistRefusal("work", [
    { address: "ok@example.com", allowed: true },
    { address: "evil@attacker.com", allowed: false, reason: "not on allowedRecipients" },
    { address: "other@elsewhere.pl", allowed: false, reason: "not on allowedRecipients" },
  ]);
  assert.ok(message.includes("evil@attacker.com"));
  assert.ok(message.includes("other@elsewhere.pl"));
});

test("the refusal does not name addresses that passed", () => {
  const message = describeAllowlistRefusal("work", [
    { address: "ok@example.com", allowed: true },
    { address: "evil@attacker.com", allowed: false, reason: "not on allowedRecipients" },
  ]);
  assert.ok(!message.includes("ok@example.com"));
});

test("the refusal states that nothing was sent", () => {
  const message = describeAllowlistRefusal("work", [
    { address: "evil@attacker.com", allowed: false, reason: "not on allowedRecipients" },
  ]);
  assert.match(message, /nothing was sent/i);
});

test("the refusal offers a pasteable allowedRecipients snippet on its own line", () => {
  const message = describeAllowlistRefusal("work", [
    { address: "evil@attacker.com", allowed: false, reason: "not on allowedRecipients" },
  ]);
  const snippetLine = message
    .split("\n")
    .find((line) => line.includes('"allowedRecipients"'));
  assert.ok(snippetLine, `no snippet line found in:\n${message}`);
  assert.ok(snippetLine.includes("evil@attacker.com"));
});
