import { test } from "node:test";
import assert from "node:assert/strict";
import { draftShape } from "./drafts.js";

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
