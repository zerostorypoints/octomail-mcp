import fs from "node:fs";
import { Readable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { drive_v3, gmail_v1, sheets_v4 } from "googleapis";
import { z } from "zod";
import { downloadAttachment, sanitizeAttachmentFilename, writeAttachmentFileExclusive } from "./attachments.js";
import { downloadDir } from "./config.js";
import {
  describeMissingDriveScope,
  driveForAccount,
  gmailForAccount,
  isScopeInsufficientError,
  readAccountToken,
  sheetsForAccount,
  tokenHasScope,
  DRIVE_SCOPE,
} from "./gmail.js";
import { accountShape, safeTool } from "./tools.js";

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

// Provenance for drive_copy_file, phrased like provenanceDescription. An
// existing description is kept in front so a copy of a copy carries its whole
// lineage; the 1000-character cap trims that existing text from its end and
// never the provenance line, which is the part a reader needs intact.
export const MAX_DESCRIPTION_CHARS = 1000;

export function copyProvenanceDescription(input: {
  sourceName: string;
  sourceId: string;
  copiedAt: string;
  existing?: string | null;
}): string {
  const line = `Copied by Octomail from ${input.sourceName} (${input.sourceId}) on ${input.copiedAt}.`;
  const existing = (input.existing ?? "").trim();
  if (existing.length === 0) {
    return line.slice(0, MAX_DESCRIPTION_CHARS);
  }
  const room = MAX_DESCRIPTION_CHARS - line.length - 1;
  return `${existing.slice(0, Math.max(room, 0))}\n${line}`;
}

// --- drive_export_file: pure helpers ---

export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const DOC_MIME = "application/vnd.google-apps.document";

// The text of an export lands in model context, like base64 does for
// gmail_get_attachment; 200 KB is the most a single tool result should carry.
export const MAX_EXPORT_TEXT_BYTES = 200 * 1024;

export type ExportKind = "sheet" | "doc";

// Only the two Google-native document types are ever exported. Anything else
// — a PDF, an image, an uploaded .xlsx — has bytes of its own, and this tool
// never downloads bytes.
export function exportKindForMime(mimeType: string): ExportKind | undefined {
  if (mimeType === SHEET_MIME) {
    return "sheet";
  }
  if (mimeType === DOC_MIME) {
    return "doc";
  }
  return undefined;
}

export type SheetTab = {
  title: string;
  index: number;
  sheetId: number;
  rowCount?: number;
  columnCount?: number;
};

// Google always sends title and index when the fields string asks for them;
// a missing one means the fields string is wrong, so fail loudly as
// fileProjection does.
export function sheetTabsFromProperties(sheets: sheets_v4.Schema$Sheet[] | undefined): SheetTab[] {
  const tabs = (sheets ?? []).map((sheet) => {
    const properties = sheet.properties ?? {};
    if (typeof properties.title !== "string" || typeof properties.index !== "number") {
      throw new Error("Sheet tab is missing a title or index. The fields string requested from Sheets is likely wrong.");
    }
    const tab: SheetTab = { title: properties.title, index: properties.index, sheetId: properties.sheetId ?? 0 };
    const rowCount = properties.gridProperties?.rowCount;
    const columnCount = properties.gridProperties?.columnCount;
    if (typeof rowCount === "number") {
      tab.rowCount = rowCount;
    }
    if (typeof columnCount === "number") {
      tab.columnCount = columnCount;
    }
    return tab;
  });
  return tabs.sort((a, b) => a.index - b.index);
}

export function pickSheet(tabs: SheetTab[], fileName: string, title?: string): SheetTab {
  if (tabs.length === 0) {
    throw new Error(`Spreadsheet ${fileName} reports no tabs. Nothing was changed.`);
  }
  if (title === undefined) {
    return tabs[0];
  }
  const match = tabs.find((tab) => tab.title === title);
  if (!match) {
    const titles = tabs.map((tab) => `"${tab.title}"`).join(", ");
    throw new Error(`Sheet "${title}" not found in ${fileName}. Tabs: ${titles}. Nothing was changed.`);
  }
  return match;
}

// A1 notation for "the whole tab": the title in single quotes, with any
// single quote inside it doubled.
export function a1SheetRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function csvField(cell: unknown): string {
  const text = cell === null || cell === undefined ? "" : String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The Sheets API drops trailing empty cells from every row, so rows are
// padded to the widest one: a ragged CSV misleads a reader counting columns.
export function rowsToCsv(values: unknown[][] | null | undefined): string {
  const rows = values ?? [];
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows
    .map((row) => {
      const fields = row.map(csvField);
      while (fields.length < width) {
        fields.push("");
      }
      return fields.join(",");
    })
    .join("\n");
}

// Byte-based cap that never splits a UTF-8 character: a naive
// Buffer.subarray(0, maxBytes).toString() would emit U+FFFD for a code point
// cut in half, and that broken character would then be written to the spill
// file's twin in the result. Prefers the last newline inside the cap so the
// truncated text ends on a whole line.
export function capExportText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; totalBytes: number } {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) {
    return { text, truncated: false, totalBytes };
  }

  let bytes = 0;
  let lastNewlineEnd = -1;
  let charEnd = 0;
  for (const ch of text) {
    const length = Buffer.byteLength(ch, "utf8");
    if (bytes + length > maxBytes) {
      break;
    }
    bytes += length;
    charEnd += ch.length;
    if (ch === "\n") {
      lastNewlineEnd = charEnd;
    }
  }

  const end = lastNewlineEnd > 0 ? lastNewlineEnd - 1 : charEnd;
  return { text: text.slice(0, end), truncated: true, totalBytes };
}

export function exportFilename(fileName: string, kind: ExportKind, sheetTitle?: string): string {
  const candidate = kind === "doc" ? `${fileName}.txt` : `${fileName} - ${sheetTitle ?? ""}.csv`;
  return sanitizeAttachmentFilename(candidate, "export");
}

// Google's answer when an API is not enabled on the Cloud project behind the
// OAuth client. Recognised in the shapes seen from googleapis: the legacy
// errors[].reason, the message text, and the newer details[].reason.
export function isServiceDisabledError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    response?: {
      status?: unknown;
      data?: { error?: { message?: unknown; errors?: unknown; details?: unknown } };
    };
  };
  if (candidate.response?.status !== 403) {
    return false;
  }
  const detail = candidate.response.data?.error;
  const message = typeof detail?.message === "string" ? detail.message : "";
  if (message.includes("SERVICE_DISABLED") || message.includes("has not been used in project")) {
    return true;
  }
  const reasonIs = (items: unknown, reason: string): boolean =>
    Array.isArray(items) && items.some((item) => (item as { reason?: unknown })?.reason === reason);
  return reasonIs(detail?.errors, "accessNotConfigured") || reasonIs(detail?.details, "SERVICE_DISABLED");
}

export function describeSheetsApiDisabled(): string {
  return (
    "The Google Sheets API is not enabled on the OAuth app's Cloud project. " +
    "Enable it under APIs & Services > Library, then retry (see docs/google-cloud-setup.md, step 1). " +
    "Nothing was changed."
  );
}


// Returns the re-auth message when the token demonstrably lacks the Drive
// scope, and undefined when it holds it or records no scope at all — an
// unknown scope set is left for Google to answer, as the read tools do.
export function missingDriveScope(token: { scope?: string | null }, account: string): string | undefined {
  return tokenHasScope(token, DRIVE_SCOPE) === false ? describeMissingDriveScope(account) : undefined;
}

// Wraps every Drive call: missingDriveScope is a preflight check against the
// token's own recorded scope string, so an account authorized before Drive
// access was requested is refused with no network call at all. The catch
// covers the case where the token claims the scope but Google still answers
// 403 (granted before a re-consent, or since revoked) — that 403 is rewritten
// into the same re-auth message, so both refusals read identically. The
// caller-supplied outcome phrase ("Nothing was changed." / "Nothing was
// uploaded.") is appended to both refusals so they match what the calling
// tool promises, the same way getFolder and assertDriveName do.
export async function driveScopeAware<T>(account: string, outcome: string, fn: () => Promise<T>): Promise<T> {
  const preflightMessage = missingDriveScope(readAccountToken(account), account);
  if (preflightMessage) {
    throw new Error(`${preflightMessage} ${outcome}`);
  }
  try {
    return await fn();
  } catch (error) {
    if (isScopeInsufficientError(error)) {
      throw new Error(`${describeMissingDriveScope(account)} ${outcome}`);
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  return candidate.code === 404 || candidate.status === 404 || candidate.response?.status === 404;
}

// Shared by getFolder and getFile: fetches a file's validation fields and
// refuses on 404 or when it is trashed. The mime check that distinguishes a
// folder from any other file lives only in getFolder, so this holds the
// 404/trashed handling both callers need without duplicating it. The outcome
// phrase and noun ("Folder" / "File") come from the caller so the refusal
// reads the way that tool promises — "Nothing was changed." for
// create/move, "Nothing was uploaded." for a future upload tool.
const CHECK_FIELDS = "id,name,mimeType,parents,trashed";

async function getDriveFileForCheck(
  drive: drive_v3.Drive,
  fileId: string,
  outcome: string,
  noun: "Folder" | "File",
  fields: string = CHECK_FIELDS,
): Promise<drive_v3.Schema$File> {
  let file: drive_v3.Schema$File;
  try {
    const response = await drive.files.get({
      fileId,
      fields,
      supportsAllDrives: true,
    });
    file = response.data;
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`${noun} ${fileId} not found or not accessible to this account. ${outcome}`);
    }
    throw error;
  }

  if (file.trashed) {
    throw new Error(`${noun} ${fileId} is in the trash. ${outcome}`);
  }

  return file;
}

// Validates a folder before any listing or mutating call is built on top of
// it: exists (and is reachable by this account), not trashed, and actually a
// folder rather than some other file id. Only the fields needed for that
// validation are requested; the resulting projection is not what any tool
// returns to its caller.
export async function getFolder(drive: drive_v3.Drive, folderId: string, outcome: string): Promise<FileProjection> {
  const file = await getDriveFileForCheck(drive, folderId, outcome, "Folder");
  if (file.mimeType !== FOLDER_MIME) {
    throw new Error(`Folder ${folderId} is not a folder (mimeType ${file.mimeType}). ${outcome}`);
  }
  return fileProjection(file);
}

// Like getFolder but accepts any mime type — used by drive_move_file to
// validate the file being moved/renamed, which is not necessarily a folder.
export async function getFile(drive: drive_v3.Drive, fileId: string, outcome: string): Promise<FileProjection> {
  const file = await getDriveFileForCheck(drive, fileId, outcome, "File");
  return fileProjection(file);
}

// The source of a copy: any file but a folder, with its description fetched
// too so the copy can carry it forward. A folder is refused here, before the
// target is looked at, because files.copy on a folder is not something Drive
// does either — it would fail later with a less useful message.
export async function getFileForCopy(
  drive: drive_v3.Drive,
  fileId: string,
  outcome: string,
): Promise<{ file: FileProjection; description?: string }> {
  const file = await getDriveFileForCheck(drive, fileId, outcome, "File", `${CHECK_FIELDS},description`);
  if (file.mimeType === FOLDER_MIME) {
    throw new Error(`File ${fileId} is a folder. drive_copy_file copies files only, not folders. ${outcome}`);
  }
  const result: { file: FileProjection; description?: string } = { file: fileProjection(file) };
  if (typeof file.description === "string") {
    result.description = file.description;
  }
  return result;
}

const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,webViewLink,md5Checksum";
const LIST_FIELDS = `nextPageToken, incompleteSearch, files(${FILE_FIELDS})`;

// Shared with Tasks 5 and 6 (move/rename) to check for a name collision
// before writing. pageSize: 2 is enough to distinguish "one match" from "more
// than one" — the caller only needs the first hit that is not the file being
// acted on. foldersOnly defaults to false so existing four-argument callers
// are unaffected; drive_create_folder passes true to restrict the collision
// check to folders.
export async function findByExactName(
  drive: drive_v3.Drive,
  name: string,
  folderId: string,
  excludeId?: string,
  foldersOnly = false,
): Promise<FileProjection | undefined> {
  const response = await drive.files.list({
    q: exactNameInFolderQuery(name, folderId, foldersOnly),
    pageSize: 2,
    fields: LIST_FIELDS,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
  });

  const match = (response.data.files ?? []).find((file) => file.id !== excludeId);
  return match ? fileProjection(match) : undefined;
}

type ListFilesInput = {
  folderId?: string;
  nameContains?: string;
  foldersOnly?: boolean;
  maxResults?: number;
  pageToken?: string;
};

async function listFiles(
  drive: drive_v3.Drive,
  input: ListFilesInput,
): Promise<{ files: FileProjection[]; nextPageToken?: string; incompleteSearch?: true }> {
  const foldersOnly = input.foldersOnly ?? false;
  // folderId defaults to "root" only in this branch — when nameContains is
  // given, assertListInput has already ruled out folderId being set too, and
  // nameContainsQuery searches all of Drive, not one folder.
  const q =
    input.nameContains !== undefined
      ? nameContainsQuery(input.nameContains, foldersOnly)
      : childrenQuery(input.folderId ?? "root", foldersOnly);

  const response = await drive.files.list({
    q,
    pageSize: input.maxResults ?? 50,
    pageToken: input.pageToken,
    orderBy: "folder,name",
    fields: LIST_FIELDS,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
  });

  const files = (response.data.files ?? []).map(fileProjection);
  const result: { files: FileProjection[]; nextPageToken?: string; incompleteSearch?: true } = { files };
  if (response.data.nextPageToken) {
    result.nextPageToken = response.data.nextPageToken;
  }
  if (response.data.incompleteSearch) {
    result.incompleteSearch = true;
  }
  return result;
}

async function createFolder(
  drive: drive_v3.Drive,
  input: { name: string; parentId: string },
): Promise<{ folder: FileProjection; created: boolean }> {
  await getFolder(drive, input.parentId, "Nothing was changed.");

  const existing = await findByExactName(drive, input.name, input.parentId, undefined, true);
  if (existing) {
    return { folder: existing, created: false };
  }

  const response = await drive.files.create({
    requestBody: { name: input.name, mimeType: FOLDER_MIME, parents: [input.parentId] },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });

  return { folder: fileProjection(response.data), created: true };
}

// The spec this tool follows lists the collision check before the download.
// It runs the other way here: the default target name is the attachment's
// own (sanitised) filename, which only the download reveals, and fetching
// the attachment twice just to learn its name first is wasteful. getFolder
// still runs before any Gmail call, so a bad folder id never costs a Gmail
// round trip either way.
async function saveAttachmentToDrive(
  drive: drive_v3.Drive,
  gmail: gmail_v1.Gmail,
  input: { account: string; messageId: string; attachmentId: string; folderId: string; name?: string },
): Promise<{
  file: FileProjection;
  sourceMessageId: string;
  sourceAttachment: { filename: string; mimeType: string; sizeBytes: number };
}> {
  await getFolder(drive, input.folderId, "Nothing was uploaded.");

  const downloaded = await downloadAttachment(gmail, input.messageId, input.attachmentId);

  const targetName = input.name ?? downloaded.filename;
  assertDriveName(targetName, "Nothing was uploaded.");
  const existing = await findByExactName(drive, targetName, input.folderId, undefined);
  if (existing) {
    throw new Error(
      `A file named "${targetName}" already exists in that folder (id ${existing.id}, ${existing.webViewLink}). Pass a different name. Nothing was uploaded.`,
    );
  }

  const description = provenanceDescription({
    account: input.account,
    messageId: input.messageId,
    subject: downloaded.headers.subject,
    from: downloaded.headers.from,
    date: downloaded.headers.date,
  });

  const response = await drive.files.create({
    requestBody: { name: targetName, parents: [input.folderId], description },
    media: { mimeType: downloaded.mimeType, body: Readable.from(downloaded.content) },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });

  return {
    file: fileProjection(response.data),
    sourceMessageId: input.messageId,
    sourceAttachment: {
      filename: downloaded.filename,
      mimeType: downloaded.mimeType,
      sizeBytes: downloaded.content.byteLength,
    },
  };
}

// The target folder for the collision check is the new folder when moving,
// otherwise the file's first current parent — a file with no parents and no
// folderId (a rename with nowhere to collide) skips the check entirely,
// matching drive_create_folder's and drive_save_attachment's "check before
// write" shape without requiring a folder to exist for a plain rename.
async function moveFile(
  drive: drive_v3.Drive,
  input: { fileId: string; folderId?: string; name?: string },
): Promise<{ file: FileProjection; previousParents: string[]; previousName: string }> {
  const file = await getFile(drive, input.fileId, "Nothing was changed.");

  if (input.folderId !== undefined) {
    await getFolder(drive, input.folderId, "Nothing was changed.");
  }

  const previousParents = file.parents ?? [];
  const targetFolderId = input.folderId ?? previousParents[0];

  if (targetFolderId !== undefined) {
    const targetName = input.name ?? file.name;
    const existing = await findByExactName(drive, targetName, targetFolderId, input.fileId);
    if (existing) {
      throw new Error(
        `A file named "${targetName}" already exists in that folder (id ${existing.id}, ${existing.webViewLink}). Pass a different name. Nothing was changed.`,
      );
    }
  }

  const updateParams: drive_v3.Params$Resource$Files$Update = {
    fileId: input.fileId,
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  };
  if (input.folderId !== undefined) {
    updateParams.addParents = input.folderId;
    if (previousParents.length > 0) {
      updateParams.removeParents = previousParents.join(",");
    }
  }
  if (input.name !== undefined) {
    updateParams.requestBody = { name: input.name };
  }

  const response = await drive.files.update(updateParams);

  return {
    file: fileProjection(response.data),
    previousParents,
    previousName: file.name,
  };
}

// Same check-before-write shape as saveAttachmentToDrive and moveFile: source
// validated, then target, then the collision check, then the one write. The
// source is only ever read; the collision check does not exclude the source
// id, because a source already sitting in the target folder under the target
// name would make the copy a duplicate, which is what the check refuses.
async function copyFile(
  drive: drive_v3.Drive,
  input: { fileId: string; targetFolderId: string; newName?: string; copiedAt: string },
): Promise<{ file: FileProjection; sourceFileId: string }> {
  const outcome = "Nothing was copied.";
  const source = await getFileForCopy(drive, input.fileId, outcome);

  await getFolder(drive, input.targetFolderId, outcome);

  const targetName = input.newName ?? source.file.name;
  const existing = await findByExactName(drive, targetName, input.targetFolderId);
  if (existing) {
    throw new Error(
      `A file named "${targetName}" already exists in that folder (id ${existing.id}, ${existing.webViewLink}). Pass a different newName. ${outcome}`,
    );
  }

  const description = copyProvenanceDescription({
    sourceName: source.file.name,
    sourceId: source.file.id,
    copiedAt: input.copiedAt,
    existing: source.description,
  });

  // No mimeType in the body: Drive keeps the source's type, so a Google Doc
  // copies as a Google Doc and a PDF as a PDF.
  const response = await drive.files.copy({
    fileId: input.fileId,
    requestBody: { name: targetName, parents: [input.targetFolderId], description },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });

  return { file: fileProjection(response.data), sourceFileId: input.fileId };
}

// --- drive_trash_file ---

// The one Drive tool that removes anything, and it only ever moves a file to
// the trash: files.update with trashed=true, which Drive undoes from the
// trash for 30 days. There is no permanent delete and no emptyTrash here,
// and there never will be a second flag that turns this into one.
//
// Two guards sit in front of the write. `expectedName` must equal the file's
// current name exactly, so a wrong or stale id (Drive ids are opaque; a
// deletion list built yesterday can point at a file renamed today) is
// refused rather than acted on. `confirm` must be true, otherwise the call
// returns the file it would trash and changes nothing, so the decision is
// made against the real name, type and parents. A folder needs
// `confirmFolder: true` on top, because trashing a folder takes everything
// inside it along.
export function assertTrashPreconditions(
  file: FileProjection,
  input: { expectedName: string; confirm?: boolean; confirmFolder?: boolean },
  outcome: string,
): { wouldTrash: true; file: FileProjection; isFolder: boolean } | undefined {
  // Names are compared after NFC normalisation: Drive stores what the
  // uploading client sent, and a macOS upload carries decomposed accents
  // (NFD, "ł" as "l" + combining stroke) while a name typed or copied
  // elsewhere is precomposed (NFC). Both spell the same file name.
  if (file.name.normalize("NFC") !== input.expectedName.normalize("NFC")) {
    throw new Error(
      `File ${file.id} is named "${file.name}", not "${input.expectedName}". The id and the expected name do not match; check the id. ${outcome}`,
    );
  }
  const isFolder = file.mimeType === FOLDER_MIME;
  if (!input.confirm) {
    return { wouldTrash: true, file, isFolder };
  }
  if (isFolder && !input.confirmFolder) {
    throw new Error(
      `File ${file.id} ("${file.name}") is a folder; trashing it trashes everything inside it. Repeat the call with confirmFolder: true if that is intended. ${outcome}`,
    );
  }
  return undefined;
}

async function trashFile(
  drive: drive_v3.Drive,
  input: { fileId: string; expectedName: string; confirm?: boolean; confirmFolder?: boolean },
): Promise<
  | { wouldTrash: true; file: FileProjection; isFolder: boolean; owners: string[]; note: string }
  | { trashed: true; file: FileProjection; isFolder: boolean; owners: string[]; note: string }
> {
  const outcome = "Nothing was trashed.";
  const { file, owners } = await getFileForTrash(drive, input.fileId, outcome);

  const preview = assertTrashPreconditions(file, input, outcome);
  if (preview) {
    return {
      ...preview,
      owners,
      note: "Nothing was trashed. Repeat the call with confirm: true to move this file to the Drive trash.",
    };
  }

  let response: { data: drive_v3.Schema$File };
  try {
    response = await drive.files.update({
      fileId: input.fileId,
      requestBody: { trashed: true },
      fields: `${FILE_FIELDS},trashed`,
      supportsAllDrives: true,
    });
  } catch (error) {
    // Only an owner (or an organiser on a shared drive) may trash a file;
    // an editor who is not the owner gets a 403. Naming the owner turns
    // "insufficient permissions" into an action: transfer ownership, or ask
    // the owner.
    if (isForbiddenError(error)) {
      throw new Error(
        `File ${file.id} ("${file.name}") is owned by ${owners.length ? owners.join(", ") : "another account"}, and only its owner can move it to the trash. Transfer ownership to this account or ask the owner. ${outcome}`,
      );
    }
    throw error;
  }

  return {
    trashed: true,
    file: fileProjection(response.data),
    isFolder: file.mimeType === FOLDER_MIME,
    owners,
    note: "Moved to the Drive trash, where Drive keeps it for 30 days and it can be restored. Nothing is permanently deleted by this server.",
  };
}

// The trash lookup also fetches the owners, so the preview shows who owns
// the file before anything is attempted, and a permission refusal can name
// them.
export async function getFileForTrash(
  drive: drive_v3.Drive,
  fileId: string,
  outcome: string,
): Promise<{ file: FileProjection; owners: string[] }> {
  const raw = await getDriveFileForCheck(drive, fileId, outcome, "File", `${CHECK_FIELDS},owners(emailAddress)`);
  const owners = (raw.owners ?? []).map((owner) => owner.emailAddress).filter((email): email is string => Boolean(email));
  return { file: fileProjection(raw), owners };
}

function isForbiddenError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  return candidate.code === 403 || candidate.status === 403 || candidate.response?.status === 403;
}

// Batch form of the same operation for a list the user has accepted: one call,
// one row per item, no row aborts the others. Each row goes through the
// identical trashFile path (name guard, confirm, confirmFolder, already
// trashed), so the batch is not a looser gate, only a shorter transcript.
// Rows are processed in order and sequentially, and a row that fails is
// reported with Google's or this server's message and nothing else changes
// for it.
export const TRASH_BATCH_MAX = 100;

export type TrashBatchRow =
  | { fileId: string; expectedName: string; status: "trashed"; file: FileProjection; isFolder: boolean; owners: string[] }
  | { fileId: string; expectedName: string; status: "wouldTrash"; file: FileProjection; isFolder: boolean; owners: string[] }
  | { fileId: string; expectedName: string; status: "refused"; error: string };

export function assertTrashBatchInput(items: { fileId: string; expectedName: string }[], outcome: string): void {
  if (items.length === 0) {
    throw new Error(`items is empty. ${outcome}`);
  }
  if (items.length > TRASH_BATCH_MAX) {
    throw new Error(`items has ${items.length} rows; the cap is ${TRASH_BATCH_MAX} per call. Split the list. ${outcome}`);
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.fileId)) {
      throw new Error(`fileId ${item.fileId} appears more than once in items. ${outcome}`);
    }
    seen.add(item.fileId);
  }
}

async function trashFiles(
  drive: drive_v3.Drive,
  input: { items: { fileId: string; expectedName: string }[]; confirm?: boolean; confirmFolder?: boolean },
): Promise<{ rows: TrashBatchRow[]; trashed: number; wouldTrash: number; refused: number; note: string }> {
  const rows: TrashBatchRow[] = [];
  for (const item of input.items) {
    try {
      const result = await trashFile(drive, { ...item, confirm: input.confirm, confirmFolder: input.confirmFolder });
      if ("trashed" in result) {
        rows.push({ ...item, status: "trashed", file: result.file, isFolder: result.isFolder, owners: result.owners });
      } else {
        rows.push({ ...item, status: "wouldTrash", file: result.file, isFolder: result.isFolder, owners: result.owners });
      }
    } catch (error) {
      rows.push({ ...item, status: "refused", error: error instanceof Error ? error.message : String(error) });
    }
  }
  const trashed = rows.filter((row) => row.status === "trashed").length;
  const wouldTrash = rows.filter((row) => row.status === "wouldTrash").length;
  const refused = rows.length - trashed - wouldTrash;
  const note = input.confirm
    ? `${trashed} moved to the Drive trash (restorable for 30 days), ${refused} refused and left untouched. Nothing is permanently deleted by this server.`
    : `Preview only: ${wouldTrash} would be trashed, ${refused} would be refused. Nothing was trashed. Repeat with confirm: true.`;
  return { rows, trashed, wouldTrash, refused, note };
}

// --- drive_export_file: readers and orchestration ---

const SHEET_TABS_FIELDS = "sheets.properties(title,index,sheetId,gridProperties(rowCount,columnCount))";

// Both Sheets calls sit in one try so a "Sheets API not enabled" 403 from
// either is rewritten into the setup message; everything else surfaces as
// Google sent it.
export async function readSheetAsCsv(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  fileName: string,
  title?: string,
): Promise<{ tab: SheetTab; tabs: SheetTab[]; text: string }> {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: SHEET_TABS_FIELDS });
    const tabs = sheetTabsFromProperties(meta.data.sheets);
    const tab = pickSheet(tabs, fileName, title);
    // FORMATTED_VALUE and FORMATTED_STRING give the text a person sees in the
    // sheet — dates as dates, amounts as formatted — which is what a registry
    // written by hand from the sheet was copied from.
    const values = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: a1SheetRange(tab.title),
      valueRenderOption: "FORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
      majorDimension: "ROWS",
    });
    return { tab, tabs, text: rowsToCsv(values.data.values) };
  } catch (error) {
    if (isServiceDisabledError(error)) {
      throw new Error(describeSheetsApiDisabled());
    }
    throw error;
  }
}

// files.export takes no supportsAllDrives parameter; the files.get before it
// is what proves the id resolves through a shared drive. Google caps this
// export at 10 MB and answers a larger Doc with its own error.
export async function readDocAsText(drive: drive_v3.Drive, fileId: string): Promise<string> {
  const response = await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
  return String(response.data);
}

// Best effort, as decided on 2026-09-09: a truncated result must still reach
// the caller when the download directory cannot be written, so a failure
// here is reported in the notice, never thrown.
export function spillExport(
  account: string,
  filename: string,
  text: string,
  totalBytes: number,
): { savedTo?: string; notice: string } {
  const over = `The export is ${totalBytes} bytes, over the ${MAX_EXPORT_TEXT_BYTES}-byte cap in the tool result`;
  let directory: string | undefined;
  try {
    directory = downloadDir(account);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const savedTo = writeAttachmentFileExclusive(directory, filename, Buffer.from(text, "utf8"));
    return { savedTo, notice: `${over}. The full text was written to ${savedTo}; read it from there.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      notice: `${over}, and writing the full text to ${directory ?? "the download directory"} failed: ${message}. Only the truncated text above is available.`,
    };
  }
}

export type ExportResult = {
  file: FileProjection;
  kind: ExportKind;
  format: "csv" | "text";
  sheet?: SheetTab;
  sheets?: string[];
  text: string;
  sizeBytes: number;
  truncated: boolean;
  savedTo?: string;
  notice?: string;
};

type ExportDeps = {
  drive: drive_v3.Drive;
  // A thunk so the Sheets client is only built on the Sheet path.
  sheets: () => Promise<sheets_v4.Sheets>;
  account: string;
};

export async function exportFile(deps: ExportDeps, input: { fileId: string; sheet?: string }): Promise<ExportResult> {
  const outcome = "Nothing was changed.";
  const file = await getFile(deps.drive, input.fileId, outcome);

  const kind = exportKindForMime(file.mimeType);
  if (kind === undefined) {
    throw new Error(
      `File ${file.id} is ${file.mimeType}, not a Google Sheet or Google Doc. drive_export_file reads only Google-native documents and never downloads a binary file. ${outcome}`,
    );
  }
  if (kind === "doc" && input.sheet !== undefined) {
    throw new Error(`sheet applies only to a Google Sheet; ${file.id} is a Google Doc. ${outcome}`);
  }

  let fullText: string;
  let sheetInfo: { tab: SheetTab; tabs: SheetTab[] } | undefined;
  if (kind === "sheet") {
    const read = await readSheetAsCsv(await deps.sheets(), file.id, file.name, input.sheet);
    fullText = read.text;
    sheetInfo = { tab: read.tab, tabs: read.tabs };
  } else {
    fullText = await readDocAsText(deps.drive, file.id);
  }

  const capped = capExportText(fullText, MAX_EXPORT_TEXT_BYTES);
  const result: ExportResult = {
    file,
    kind,
    format: kind === "sheet" ? "csv" : "text",
    text: capped.text,
    sizeBytes: capped.totalBytes,
    truncated: capped.truncated,
  };
  if (sheetInfo) {
    result.sheet = sheetInfo.tab;
    result.sheets = sheetInfo.tabs.map((tab) => tab.title);
  }
  if (capped.truncated) {
    const filename = exportFilename(file.name, kind, sheetInfo?.tab.title);
    const spill = spillExport(deps.account, filename, fullText, capped.totalBytes);
    if (spill.savedTo !== undefined) {
      result.savedTo = spill.savedTo;
    }
    result.notice = spill.notice;
  }
  return result;
}

export function registerDriveTools(server: McpServer): void {
  server.tool(
    "drive_list_files",
    "List files and folders in a Google Drive folder, or search all of Drive by a name fragment. Read-only: it never opens, downloads, or reveals file content, only metadata (name, type, size, modified time, parent folders, link, checksum). Pass folderId or nameContains, not both.",
    {
      ...accountShape,
      folderId: z
        .string()
        .min(1)
        .optional()
        .describe('Parent folder id to list the children of. Defaults to "root" when nameContains is not given.'),
      nameContains: z
        .string()
        .min(1)
        .optional()
        .describe("Search all of Drive (not one folder) for files whose name contains this fragment."),
      foldersOnly: z.boolean().optional().describe("Restrict results to folders."),
      maxResults: z.number().int().min(1).max(100).optional().default(50),
      pageToken: z.string().min(1).optional().describe("Page token from a previous call's nextPageToken."),
    },
    async ({ account, ...input }) =>
      safeTool(async () => {
        assertListInput(input);
        return await driveScopeAware(account, "Nothing was changed.", async () => {
          const drive = await driveForAccount(account);
          return await listFiles(drive, input);
        });
      }, account),
  );

  server.tool(
    "drive_create_folder",
    "Create a folder in Google Drive. If a folder with the same name already exists directly under the given parent, that folder is returned instead of creating a duplicate. Cannot rename, move, delete, upload into, or share the folder it creates or finds.",
    {
      ...accountShape,
      name: z.string().min(1).describe("Folder name."),
      parentId: z.string().min(1).optional().describe('Parent folder id. Defaults to "root".'),
    },
    async ({ account, name, parentId }) =>
      safeTool(async () => {
        assertDriveName(name);
        return await driveScopeAware(account, "Nothing was changed.", async () => {
          const drive = await driveForAccount(account);
          return await createFolder(drive, { name, parentId: parentId ?? "root" });
        });
      }, account),
  );

  server.tool(
    "drive_save_attachment",
    "Save a Gmail attachment straight into a Google Drive folder — the bytes go directly from Gmail to Drive, never through local disk and never back in the tool result. Refuses when a file with the target name already exists in that folder rather than overwriting it. Cannot delete anything, and cannot upload a local file: only an attachment already on a Gmail message.",
    {
      ...accountShape,
      messageId: z.string().min(1).describe("Gmail message id the attachment is on."),
      attachmentId: z.string().min(1).describe("Attachment id, from gmail_read_message."),
      folderId: z.string().min(1).describe("Destination Drive folder id."),
      name: z
        .string()
        .min(1)
        .optional()
        .describe("Drive file name. Defaults to the attachment's own (sanitised) filename."),
    },
    async ({ account, messageId, attachmentId, folderId, name }) =>
      safeTool(async () => {
        return await driveScopeAware(account, "Nothing was uploaded.", async () => {
          if (name !== undefined) {
            assertDriveName(name, "Nothing was uploaded.");
          }
          const drive = await driveForAccount(account);
          const gmail = await gmailForAccount(account);
          return await saveAttachmentToDrive(drive, gmail, { account, messageId, attachmentId, folderId, name });
        });
      }, account),
  );

  server.tool(
    "drive_move_file",
    "Move a Google Drive file to a different folder, rename it, or both in one call. Refuses when a file with the resulting name already exists in the target folder. Cannot delete or copy the file, and cannot move it to a different Google account.",
    {
      ...accountShape,
      fileId: z.string().min(1).describe("Drive file id to move or rename."),
      folderId: z.string().min(1).optional().describe("Destination folder id. Omit to rename without moving."),
      name: z.string().min(1).optional().describe("New file name. Omit to move without renaming."),
    },
    async ({ account, fileId, folderId, name }) =>
      safeTool(async () => {
        return await driveScopeAware(account, "Nothing was changed.", async () => {
          assertMoveInput({ folderId, name });
          if (name !== undefined) {
            assertDriveName(name);
          }
          const drive = await driveForAccount(account);
          return await moveFile(drive, { fileId, folderId, name });
        });
      }, account),
  );

  server.tool(
    "drive_copy_file",
    "Copy a Google Drive file into a folder on the same account, optionally under a new name. Drive performs the copy on its side, so no bytes pass through this server; a Google Doc or Sheet copies as the same Google type, a PDF or image byte for byte, and a copy from My Drive into a shared drive works. The copy's description records the source file and time, appended to any description the source already had. Refuses when a file with the resulting name already exists in the target folder rather than overwriting it, and refuses a folder as the source. Only copies: it cannot delete, move, rename, share, or overwrite anything, and it never modifies the source.",
    {
      ...accountShape,
      fileId: z.string().min(1).describe("Drive file id to copy. Must be a file, not a folder."),
      targetFolderId: z.string().min(1).describe("Destination Drive folder id the copy is placed in."),
      newName: z.string().min(1).optional().describe("Name of the copy. Defaults to the source file's name."),
    },
    async ({ account, fileId, targetFolderId, newName }) =>
      safeTool(async () => {
        return await driveScopeAware(account, "Nothing was copied.", async () => {
          if (newName !== undefined) {
            assertDriveName(newName, "Nothing was copied.");
          }
          const drive = await driveForAccount(account);
          return await copyFile(drive, { fileId, targetFolderId, newName, copiedAt: new Date().toISOString() });
        });
      }, account),
  );

  server.tool(
    "drive_trash_file",
    "Move one Google Drive file or folder to the Drive trash (files.update with trashed=true), where Drive keeps it for 30 days and it can be restored. Never a permanent delete: this server has no files.delete and no emptyTrash. Two guards: expectedName must equal the file's current name exactly, so a wrong or stale id is refused; and without confirm: true the call changes nothing and returns the file it would trash. A folder additionally needs confirmFolder: true, because trashing a folder trashes its contents. Refuses a file that is already in the trash.",
    {
      ...accountShape,
      fileId: z.string().min(1).describe("Drive file or folder id to trash."),
      expectedName: z
        .string()
        .min(1)
        .describe("The file's current name, exactly. Refused when it differs from the name Drive reports for fileId."),
      confirm: z.boolean().optional().describe("Must be true to trash. Omitted or false: returns what would be trashed and changes nothing."),
      confirmFolder: z
        .boolean()
        .optional()
        .describe("Required in addition to confirm when fileId is a folder; trashing a folder trashes everything inside it."),
    },
    async ({ account, fileId, expectedName, confirm, confirmFolder }) =>
      safeTool(async () => {
        return await driveScopeAware(account, "Nothing was trashed.", async () => {
          const drive = await driveForAccount(account);
          return await trashFile(drive, { fileId, expectedName, confirm, confirmFolder });
        });
      }, account),
  );

  server.tool(
    "drive_trash_files",
    "Batch form of drive_trash_file for an accepted list: up to 100 {fileId, expectedName} items in one call, processed in order, one result row per item; a refused row (name mismatch, already in the trash, not found, no permission) never stops the others. Same guards as the single tool: expectedName must equal each file's current name, confirm: true is required to trash and without it the call only previews, and a folder needs confirmFolder: true. Trash only, restorable for 30 days; no permanent delete exists in this server.",
    {
      ...accountShape,
      items: z
        .array(
          z.object({
            fileId: z.string().min(1).describe("Drive file or folder id to trash."),
            expectedName: z.string().min(1).describe("The file's current name, exactly."),
          }),
        )
        .min(1)
        .max(TRASH_BATCH_MAX)
        .describe("The rows to trash, each with its id and its exact current name."),
      confirm: z.boolean().optional().describe("Must be true to trash. Omitted or false: previews every row and changes nothing."),
      confirmFolder: z
        .boolean()
        .optional()
        .describe("Required in addition to confirm for rows that are folders; a folder row without it is refused, the others proceed."),
    },
    async ({ account, items, confirm, confirmFolder }) =>
      safeTool(async () => {
        return await driveScopeAware(account, "Nothing was trashed.", async () => {
          assertTrashBatchInput(items, "Nothing was trashed.");
          const drive = await driveForAccount(account);
          return await trashFiles(drive, { items, confirm, confirmFolder });
        });
      }, account),
  );

  server.tool(
    "drive_export_file",
    "Read the content of a Google-native document on Drive: a Google Sheet as CSV (one tab, default the first; pass sheet to pick another by title) or a Google Doc as plain text. Read-only and never a binary file: a PDF, image, or uploaded .xlsx is refused. The text in the result is capped at 200 KB; a larger export is truncated on a line boundary, and the full text is written into the account's download directory (OCTOMAIL_DOWNLOAD_DIR/<account>) with its path returned as savedTo.",
    {
      ...accountShape,
      fileId: z.string().min(1).describe("Drive file id of a Google Sheet or Google Doc."),
      sheet: z
        .string()
        .min(1)
        .optional()
        .describe("For a Google Sheet: the tab title to read (exact match). Defaults to the first tab."),
    },
    async ({ account, fileId, sheet }) =>
      safeTool(async () => {
        return await driveScopeAware(account, "Nothing was changed.", async () => {
          const drive = await driveForAccount(account);
          return await exportFile({ drive, sheets: () => sheetsForAccount(account), account }, { fileId, sheet });
        });
      }, account),
  );
}
