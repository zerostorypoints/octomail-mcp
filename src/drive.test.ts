import { test } from "node:test";
import assert from "node:assert/strict";
import type { drive_v3 } from "googleapis";
import {
  FOLDER_MIME,
  assertDriveName,
  assertDriveScope,
  assertListInput,
  assertMoveInput,
  childrenQuery,
  escapeDriveQueryValue,
  exactNameInFolderQuery,
  fileProjection,
  missingDriveScope,
  nameContainsQuery,
  provenanceDescription,
} from "./drive.js";

// --- fileProjection ---

test("fileProjection sets isFolder true for a folder mime type", () => {
  const projection = fileProjection({ id: "1", name: "Reports", mimeType: FOLDER_MIME });
  assert.equal(projection.isFolder, true);
});

test("fileProjection sets isFolder false for a non-folder mime type", () => {
  const projection = fileProjection({ id: "1", name: "notes.txt", mimeType: "text/plain" });
  assert.equal(projection.isFolder, false);
});

test("fileProjection converts size string to sizeBytes number", () => {
  const projection = fileProjection({ id: "1", name: "notes.txt", mimeType: "text/plain", size: "1234" });
  assert.equal(projection.sizeBytes, 1234);
});

test("fileProjection leaves sizeBytes out when size is absent", () => {
  const projection = fileProjection({ id: "1", name: "notes.txt", mimeType: "text/plain" });
  assert.ok(!("sizeBytes" in projection));
});

test("fileProjection leaves parents, webViewLink, md5Checksum out when absent", () => {
  const projection = fileProjection({ id: "1", name: "notes.txt", mimeType: "text/plain" });
  assert.ok(!("parents" in projection));
  assert.ok(!("webViewLink" in projection));
  assert.ok(!("md5Checksum" in projection));
});

test("fileProjection throws when id is missing", () => {
  assert.throws(() => fileProjection({ name: "notes.txt", mimeType: "text/plain" } as drive_v3.Schema$File));
});

test("fileProjection throws when name is missing", () => {
  assert.throws(() => fileProjection({ id: "1", mimeType: "text/plain" } as drive_v3.Schema$File));
});

// --- escapeDriveQueryValue ---

test("escapeDriveQueryValue escapes single quotes", () => {
  assert.equal(escapeDriveQueryValue("O'Brien's"), "O\\'Brien\\'s");
});

test("escapeDriveQueryValue doubles a backslash", () => {
  assert.equal(escapeDriveQueryValue("a\\b"), "a\\\\b");
});

// --- query builders ---

test("childrenQuery builds the expected string without foldersOnly", () => {
  assert.equal(childrenQuery("folder1", false), "'folder1' in parents and trashed = false");
});

test("childrenQuery adds the mime clause when foldersOnly is true", () => {
  assert.equal(
    childrenQuery("folder1", true),
    `'folder1' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`,
  );
});

test("nameContainsQuery builds the expected string without foldersOnly", () => {
  assert.equal(nameContainsQuery("report", false), "name contains 'report' and trashed = false");
});

test("nameContainsQuery adds the mime clause when foldersOnly is true", () => {
  assert.equal(
    nameContainsQuery("report", true),
    `name contains 'report' and trashed = false and mimeType = '${FOLDER_MIME}'`,
  );
});

test("nameContainsQuery escapes its fragment", () => {
  assert.equal(nameContainsQuery("O'Brien", false), "name contains 'O\\'Brien' and trashed = false");
});

test("exactNameInFolderQuery builds the expected string without foldersOnly", () => {
  assert.equal(
    exactNameInFolderQuery("report.pdf", "folder1"),
    "name = 'report.pdf' and 'folder1' in parents and trashed = false",
  );
});

test("exactNameInFolderQuery adds the mime clause when foldersOnly is true", () => {
  assert.equal(
    exactNameInFolderQuery("Reports", "folder1", true),
    `name = 'Reports' and 'folder1' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`,
  );
});

test("every query builder's output contains trashed = false", () => {
  assert.match(childrenQuery("f", false), /trashed = false/);
  assert.match(nameContainsQuery("x", false), /trashed = false/);
  assert.match(exactNameInFolderQuery("x", "f"), /trashed = false/);
});

// --- assertListInput ---

test("assertListInput throws when both folderId and nameContains are set", () => {
  assert.throws(
    () => assertListInput({ folderId: "f", nameContains: "x" }),
    /Pass either folderId or nameContains, not both\. Nothing was changed\./,
  );
});

test("assertListInput does not throw when only folderId is set", () => {
  assert.doesNotThrow(() => assertListInput({ folderId: "f" }));
});

test("assertListInput does not throw when only nameContains is set", () => {
  assert.doesNotThrow(() => assertListInput({ nameContains: "x" }));
});

test("assertListInput does not throw when neither is set", () => {
  assert.doesNotThrow(() => assertListInput({}));
});

// --- assertMoveInput ---

test("assertMoveInput throws when neither folderId nor name is set", () => {
  assert.throws(
    () => assertMoveInput({}),
    /Pass folderId to move, name to rename, or both\. Nothing was changed\./,
  );
});

test("assertMoveInput does not throw when only folderId is set", () => {
  assert.doesNotThrow(() => assertMoveInput({ folderId: "f" }));
});

test("assertMoveInput does not throw when only name is set", () => {
  assert.doesNotThrow(() => assertMoveInput({ name: "new-name" }));
});

test("assertMoveInput does not throw when both are set", () => {
  assert.doesNotThrow(() => assertMoveInput({ folderId: "f", name: "new-name" }));
});

// --- assertDriveName ---

test("assertDriveName throws on an empty string", () => {
  assert.throws(() => assertDriveName(""), /Nothing was changed\./);
});

test("assertDriveName throws on a 256 character name", () => {
  assert.throws(() => assertDriveName("a".repeat(256)), /Nothing was changed\./);
});

test("assertDriveName throws on a name containing a slash", () => {
  assert.throws(() => assertDriveName("a/b"), /Nothing was changed\./);
});

test("assertDriveName throws on a name containing a control character", () => {
  assert.throws(() => assertDriveName("a\nb"), /Nothing was changed\./);
});

test("assertDriveName does not throw on a valid name", () => {
  assert.doesNotThrow(() => assertDriveName("Report: Q3?"));
});

test("assertDriveName ends the message with a custom outcome phrase", () => {
  assert.throws(() => assertDriveName("", "Nothing was moved."), /Nothing was moved\.$/);
});

// --- provenanceDescription ---

test("provenanceDescription includes all four lines when every header is present", () => {
  const description = provenanceDescription({
    account: "work",
    messageId: "msg1",
    subject: "Invoice",
    from: "billing@example.com",
    date: "2026-09-01",
  });
  assert.equal(
    description,
    [
      "Saved by Octomail from Gmail account work, message msg1.",
      "Subject: Invoice",
      "From: billing@example.com",
      "Date: 2026-09-01",
    ].join("\n"),
  );
});

test("provenanceDescription drops only the missing header, with no undefined anywhere", () => {
  const description = provenanceDescription({
    account: "work",
    messageId: "msg1",
    subject: "Invoice",
    date: "2026-09-01",
  });
  assert.doesNotMatch(description, /undefined/);
  assert.doesNotMatch(description, /From:/);
  assert.match(description, /Subject: Invoice/);
  assert.match(description, /Date: 2026-09-01/);
});

test("provenanceDescription cuts to exactly 1000 characters and keeps the first line intact", () => {
  const description = provenanceDescription({
    account: "work",
    messageId: "msg1",
    subject: "x".repeat(5000),
  });
  assert.equal(description.length, 1000);
  assert.ok(description.startsWith("Saved by Octomail from Gmail account work, message msg1.\nSubject: "));
});

// --- missingDriveScope ---

test("missingDriveScope returns a message naming the re-auth command when scope is lacking", () => {
  const message = missingDriveScope({ scope: "https://www.googleapis.com/auth/gmail.readonly" }, "work");
  assert.match(message ?? "", /npm run auth -- --account work/);
});

test("missingDriveScope returns undefined when the token holds the scope", () => {
  const message = missingDriveScope(
    { scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive" },
    "work",
  );
  assert.equal(message, undefined);
});

test("missingDriveScope returns undefined when scope is absent", () => {
  const message = missingDriveScope({}, "work");
  assert.equal(message, undefined);
});

// --- assertDriveScope ---

test("assertDriveScope is exported as a function", () => {
  assert.equal(typeof assertDriveScope, "function");
});
