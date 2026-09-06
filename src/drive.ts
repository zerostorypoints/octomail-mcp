import type { drive_v3 } from "googleapis";
import { describeMissingDriveScope, readAccountToken, tokenHasScope, DRIVE_SCOPE } from "./gmail.js";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export type FileProjection = {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  sizeBytes?: number;
  modifiedTime?: string;
  parents?: string[];
  webViewLink?: string;
  md5Checksum?: string;
};

// Drive always sends id and name when they are in the fields string; a
// missing one here means the fields string is wrong, not that the file lacks
// a name, so this should fail loudly rather than paper over it.
export function fileProjection(file: drive_v3.Schema$File): FileProjection {
  if (!file.id) {
    throw new Error("Drive file is missing an id. The fields string requested from Drive is likely wrong.");
  }
  if (!file.name) {
    throw new Error("Drive file is missing a name. The fields string requested from Drive is likely wrong.");
  }

  const projection: FileProjection = {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType ?? "",
    isFolder: file.mimeType === FOLDER_MIME,
  };

  if (file.size !== undefined && file.size !== null) {
    projection.sizeBytes = Number(file.size);
  }
  if (file.modifiedTime) {
    projection.modifiedTime = file.modifiedTime;
  }
  if (file.parents) {
    projection.parents = file.parents;
  }
  if (file.webViewLink) {
    projection.webViewLink = file.webViewLink;
  }
  if (file.md5Checksum) {
    projection.md5Checksum = file.md5Checksum;
  }

  return projection;
}

// Drive's query grammar treats a bare backslash or single quote inside a
// quoted string literal specially, so both are escaped before the value is
// interpolated into a query string.
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function foldersOnlyClause(foldersOnly: boolean): string {
  return foldersOnly ? ` and mimeType = '${FOLDER_MIME}'` : "";
}

export function childrenQuery(folderId: string, foldersOnly: boolean): string {
  return `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false${foldersOnlyClause(foldersOnly)}`;
}

export function nameContainsQuery(fragment: string, foldersOnly: boolean): string {
  return `name contains '${escapeDriveQueryValue(fragment)}' and trashed = false${foldersOnlyClause(foldersOnly)}`;
}

export function exactNameInFolderQuery(name: string, folderId: string, foldersOnly = false): string {
  return `name = '${escapeDriveQueryValue(name)}' and '${escapeDriveQueryValue(folderId)}' in parents and trashed = false${foldersOnlyClause(foldersOnly)}`;
}

export function assertListInput(input: { folderId?: string; nameContains?: string }): void {
  if (typeof input.folderId === "string" && typeof input.nameContains === "string") {
    throw new Error("Pass either folderId or nameContains, not both. Nothing was changed.");
  }
}

export function assertMoveInput(input: { folderId?: string; name?: string }): void {
  if (typeof input.folderId !== "string" && typeof input.name !== "string") {
    throw new Error("Pass folderId to move, name to rename, or both. Nothing was changed.");
  }
}

// Control characters and the path separator. Unlike attachment filenames,
// Drive itself allows ":" and "?" in a file name, so only "/" and controls
// are rejected here. Checked by code point rather than a regex character
// class so the control range never needs to appear as a literal escape in
// this source file.
const MAX_CONTROL_CODE_POINT = 0x1f;
const DELETE_CODE_POINT = 0x7f;

function isUnsafeDriveNameChar(ch: string): boolean {
  if (ch === "/") {
    return true;
  }
  const codePoint = ch.codePointAt(0) ?? 0;
  return codePoint <= MAX_CONTROL_CODE_POINT || codePoint === DELETE_CODE_POINT;
}

export function assertDriveName(name: string, outcome = "Nothing was changed."): void {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 255) {
    throw new Error(`A Drive file name must be 1 to 255 characters long. ${outcome}`);
  }
  if ([...name].some(isUnsafeDriveNameChar)) {
    throw new Error(`A Drive file name cannot contain "/" or control characters. ${outcome}`);
  }
}

export function provenanceDescription(input: {
  account: string;
  messageId: string;
  subject?: string;
  from?: string;
  date?: string;
}): string {
  const lines = [`Saved by Octomail from Gmail account ${input.account}, message ${input.messageId}.`];
  if (input.subject !== undefined) {
    lines.push(`Subject: ${input.subject}`);
  }
  if (input.from !== undefined) {
    lines.push(`From: ${input.from}`);
  }
  if (input.date !== undefined) {
    lines.push(`Date: ${input.date}`);
  }
  return lines.join("\n").slice(0, 1000);
}

// Returns the re-auth message when the token demonstrably lacks the Drive
// scope, and undefined when it holds it or records no scope at all — an
// unknown scope set is left for Google to answer, as the read tools do.
export function missingDriveScope(token: { scope?: string | null }, account: string): string | undefined {
  return tokenHasScope(token, DRIVE_SCOPE) === false ? describeMissingDriveScope(account) : undefined;
}

export function assertDriveScope(account: string): void {
  const message = missingDriveScope(readAccountToken(account), account);
  if (message) {
    throw new Error(message);
  }
}
