import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { drive_v3 } from "googleapis";
import { z } from "zod";
import {
  describeMissingDriveScope,
  driveForAccount,
  isScopeInsufficientError,
  readAccountToken,
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

// Wraps every Drive call: assertDriveScope is a preflight check against the
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

// Validates a folder before any listing or mutating call is built on top of
// it: exists (and is reachable by this account), not trashed, and actually a
// folder rather than some other file id. The outcome phrase is supplied by
// the calling tool so the refusal matches what that tool promises — "Nothing
// was changed." for create/move, "Nothing was uploaded." for a future upload
// tool. Only the fields needed for that validation are requested; the
// resulting projection is not what any tool returns to its caller.
export async function getFolder(drive: drive_v3.Drive, folderId: string, outcome: string): Promise<FileProjection> {
  let file: drive_v3.Schema$File;
  try {
    const response = await drive.files.get({
      fileId: folderId,
      fields: "id,name,mimeType,parents,trashed",
      supportsAllDrives: true,
    });
    file = response.data;
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`Folder ${folderId} not found or not accessible to this account. ${outcome}`);
    }
    throw error;
  }

  if (file.trashed) {
    throw new Error(`Folder ${folderId} is in the trash. ${outcome}`);
  }
  if (file.mimeType !== FOLDER_MIME) {
    throw new Error(`Folder ${folderId} is not a folder (mimeType ${file.mimeType}). ${outcome}`);
  }

  return fileProjection(file);
}

const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,webViewLink,md5Checksum";
const LIST_FIELDS = `nextPageToken, files(${FILE_FIELDS})`;

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
): Promise<{ files: FileProjection[]; nextPageToken?: string }> {
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
  return response.data.nextPageToken ? { files, nextPageToken: response.data.nextPageToken } : { files };
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
}
