import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { sanitizeAttachmentFilename, uniqueFilePath } from "./attachments.js";
import { MAX_INLINE_BASE64_BYTES, assertInlineSizeWithinLimit } from "./attachments.js";

test("sanitizeAttachmentFilename keeps an ordinary name", () => {
  assert.equal(sanitizeAttachmentFilename("faktura.pdf", "att-1"), "faktura.pdf");
});

test("sanitizeAttachmentFilename keeps non-ASCII names, which are legitimate", () => {
  assert.equal(sanitizeAttachmentFilename("faktura_wrzesień.pdf", "att-1"), "faktura_wrzesień.pdf");
});

test("sanitizeAttachmentFilename strips a POSIX traversal path", () => {
  assert.equal(sanitizeAttachmentFilename("../../.ssh/authorized_keys", "att-1"), "authorized_keys");
});

test("sanitizeAttachmentFilename neutralises Windows-style separators", () => {
  const result = sanitizeAttachmentFilename("..\\..\\Windows\\system.ini", "att-1");
  assert.ok(!result.includes("\\"), `${result} still contains a backslash`);
  assert.ok(!result.startsWith("."), `${result} still starts with a dot`);
});

test("sanitizeAttachmentFilename removes control characters", () => {
  assert.equal(sanitizeAttachmentFilename("in\u0000voi\u001fce.pdf", "att-1"), "in_voi_ce.pdf");
});

test("sanitizeAttachmentFilename falls back when the name is empty", () => {
  assert.equal(sanitizeAttachmentFilename("", "att-1"), "attachment-att-1");
  assert.equal(sanitizeAttachmentFilename(undefined, "att-1"), "attachment-att-1");
});

test("sanitizeAttachmentFilename falls back when the name is only dots", () => {
  assert.equal(sanitizeAttachmentFilename("..", "att-1"), "attachment-att-1");
});

test("sanitizeAttachmentFilename sanitises the attachmentId used in the fallback", () => {
  assert.equal(sanitizeAttachmentFilename("", "../../att"), "attachment-att");
});

test("uniqueFilePath returns the plain path when nothing exists", () => {
  assert.equal(uniqueFilePath("/tmp/d", "a.pdf", () => false), path.join("/tmp/d", "a.pdf"));
});

test("uniqueFilePath appends a counter rather than overwriting", () => {
  const taken = new Set([path.join("/tmp/d", "a.pdf"), path.join("/tmp/d", "a (2).pdf")]);
  assert.equal(uniqueFilePath("/tmp/d", "a.pdf", (p) => taken.has(p)), path.join("/tmp/d", "a (3).pdf"));
});

test("uniqueFilePath keeps the extension when a name has none", () => {
  const taken = new Set([path.join("/tmp/d", "README")]);
  assert.equal(uniqueFilePath("/tmp/d", "README", (p) => taken.has(p)), path.join("/tmp/d", "README (2)"));
});

test("assertInlineSizeWithinLimit accepts a payload exactly at the limit", () => {
  assert.doesNotThrow(() => assertInlineSizeWithinLimit(MAX_INLINE_BASE64_BYTES));
});

test("assertInlineSizeWithinLimit rejects a payload one byte over the limit", () => {
  assert.throws(() => assertInlineSizeWithinLimit(MAX_INLINE_BASE64_BYTES + 1));
});

test("assertInlineSizeWithinLimit points the caller at file mode", () => {
  assert.throws(() => assertInlineSizeWithinLimit(MAX_INLINE_BASE64_BYTES + 1), /encoding: "file"/);
});

test("assertInlineSizeWithinLimit reports the actual size so the caller can judge", () => {
  assert.throws(() => assertInlineSizeWithinLimit(9_000_000), /9000000/);
});
