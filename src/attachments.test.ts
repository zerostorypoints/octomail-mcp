import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { sanitizeAttachmentFilename, uniqueFilePath } from "./attachments.js";
import { MAX_INLINE_BASE64_BYTES, assertInlineSizeWithinLimit } from "./attachments.js";
import { resolveAttachmentPath } from "./attachments.js";
import { matchAttachmentMetadata } from "./attachments.js";

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

test("resolveAttachmentPath accepts a file inside the root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-root-"));
  const file = path.join(root, "faktura.pdf");
  fs.writeFileSync(file, "x");
  assert.equal(resolveAttachmentPath("faktura.pdf", root), fs.realpathSync(file));
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveAttachmentPath rejects a traversal path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-root-"));
  assert.throws(() => resolveAttachmentPath("../../etc/hosts", root), /outside the download root/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveAttachmentPath rejects an absolute path outside the root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-root-"));
  assert.throws(() => resolveAttachmentPath("/etc/hosts", root), /outside the download root/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveAttachmentPath rejects a symlink inside the root pointing outside it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-root-"));
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-secret-"));
  const secret = path.join(secretDir, "id_rsa");
  fs.writeFileSync(secret, "PRIVATE KEY");
  fs.symlinkSync(secret, path.join(root, "innocent.pdf"));

  assert.throws(
    () => resolveAttachmentPath("innocent.pdf", root),
    /outside the download root/,
    "a symlink escaped the download root — string-prefix containment is not enough",
  );

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(secretDir, { recursive: true, force: true });
});

test("resolveAttachmentPath reports a missing file distinctly from an escape", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-root-"));
  assert.throws(() => resolveAttachmentPath("absent.pdf", root), /does not exist/);
  fs.rmSync(root, { recursive: true, force: true });
});


const attachment = (attachmentId: string, filename: string, sizeBytes: number) => ({
  filename,
  mimeType: "application/pdf",
  sizeBytes,
  attachmentId,
  inline: false,
});

test("matchAttachmentMetadata prefers an exact id match", () => {
  const candidates = [attachment("a", "umowa.pdf", 10), attachment("b", "aneks.pdf", 20)];
  assert.equal(matchAttachmentMetadata(candidates, "b", 10)?.filename, "aneks.pdf");
});

// Gmail rotates the id on every messages.get, so the id a caller holds is
// routinely absent from the current list while still downloading fine.
test("matchAttachmentMetadata falls back to the only attachment when the id has rotated", () => {
  const candidates = [attachment("fresh-id", "umowa.pdf", 10)];
  assert.equal(matchAttachmentMetadata(candidates, "stale-id", 10)?.filename, "umowa.pdf");
});

test("matchAttachmentMetadata disambiguates a rotated id by downloaded size", () => {
  const candidates = [attachment("fresh-1", "umowa.pdf", 10), attachment("fresh-2", "aneks.pdf", 20)];
  assert.equal(matchAttachmentMetadata(candidates, "stale-id", 20)?.filename, "aneks.pdf");
});

test("matchAttachmentMetadata gives up when several attachments share the size", () => {
  const candidates = [attachment("fresh-1", "umowa.pdf", 10), attachment("fresh-2", "aneks.pdf", 10)];
  assert.equal(matchAttachmentMetadata(candidates, "stale-id", 10), undefined);
});

test("matchAttachmentMetadata gives up when the size is unknown and the message has several parts", () => {
  const candidates = [attachment("fresh-1", "umowa.pdf", 10), attachment("fresh-2", "aneks.pdf", 20)];
  assert.equal(matchAttachmentMetadata(candidates, "stale-id"), undefined);
});
