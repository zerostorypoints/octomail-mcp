import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { drive_v3 } from "googleapis";
import { z } from "zod";
import { isWithinRoot, resolveFileWithinRoot, sanitizeAttachmentFilename } from "./attachments.js";
import type { RootedPathMessages } from "./attachments.js";
import { downloadDir } from "./config.js";
import {
  DOC_MIME,
  FILE_FIELDS,
  MAX_DESCRIPTION_CHARS,
  SHEET_MIME,
  assertDriveName,
  driveScopeAware,
  fileProjection,
  findByExactName,
  getFileForDownload,
  getFolder,
} from "./drive.js";
import type { FileProjection } from "./drive.js";
import { driveForAccount } from "./gmail.js";
import { accountShape, safeTool } from "./tools.js";

// Local files in and out of Drive. Both directions are confined to the
// account's own download directory (OCTOMAIL_DOWNLOAD_DIR/<account>), the
// same one gmail_get_attachment writes into and gmail_create_draft attaches
// from, and both refuse a same-named target rather than overwrite it: a Drive
// file on upload, a local file on download. Neither deletes, renames, moves or
// shares anything.

const UPLOAD_OUTCOME = "Nothing was uploaded.";
const DOWNLOAD_OUTCOME = "Nothing was downloaded.";

// googleapis sends a files.create with media as uploadType=multipart and has no
// resumable path, and Drive caps a multipart upload at 5 MB. A larger file is
// refused here, before any network call, rather than failing inside Google.
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

// A download is held in memory until its size and md5 are checked, so nothing
// unverified reaches disk; the cap bounds that memory.
export const DOWNLOAD_DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

const OCTET_STREAM = "application/octet-stream";

const UPLOAD_MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".zip": "application/zip",
};

// Drive converts on upload when the metadata names a Google type and the
// media part carries the source type, so the source type has to be right for
// these; an unknown extension goes up as application/octet-stream.
export function uploadMimeType(filename: string): string {
  return UPLOAD_MIME_TYPES[path.extname(filename).toLowerCase()] ?? OCTET_STREAM;
}

const CONVERSION_TARGETS: Record<string, string> = {
  ".docx": DOC_MIME,
  ".doc": DOC_MIME,
  ".odt": DOC_MIME,
  ".rtf": DOC_MIME,
  ".txt": DOC_MIME,
  ".xlsx": SHEET_MIME,
  ".xls": SHEET_MIME,
  ".ods": SHEET_MIME,
  ".csv": SHEET_MIME,
};

export function conversionTargetFor(filename: string): string | undefined {
  return CONVERSION_TARGETS[path.extname(filename).toLowerCase()];
}

function describeConvertible(): string {
  const byTarget = (target: string) =>
    Object.entries(CONVERSION_TARGETS)
      .filter(([, mime]) => mime === target)
      .map(([extension]) => extension)
      .join(", ");
  return `${byTarget(DOC_MIME)} (Google Doc); ${byTarget(SHEET_MIME)} (Google Sheet)`;
}

// --- drive_upload_file ---

const UPLOAD_PATH_MESSAGES: RootedPathMessages = {
  outside: (inputPath, realRoot) =>
    `filePath "${inputPath}" resolves outside this account's download directory ${realRoot}. drive_upload_file uploads only files inside that directory. ${UPLOAD_OUTCOME}`,
  missing: (inputPath, realRoot) =>
    `filePath "${inputPath}" does not exist inside this account's download directory ${realRoot}. ${UPLOAD_OUTCOME}`,
};

export type LocalUpload = {
  path: string;
  // The name the caller used, which is what the Drive name and the media type
  // are taken from — a symlink inside the directory uploads under its own name.
  filename: string;
  sizeBytes: number;
  mimeType: string;
  convertTo?: string;
};

// Every local check, with no network call: containment, a regular file, the
// size cap, and a convertible format when conversion was asked for.
export function prepareLocalUpload(account: string, filePath: string, convert: boolean): LocalUpload {
  const root = downloadDir(account);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const resolved = resolveFileWithinRoot(filePath, root, UPLOAD_PATH_MESSAGES);
  const filename = path.basename(filePath);

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`filePath "${filePath}" is not a regular file. ${UPLOAD_OUTCOME}`);
  }
  if (stat.size > UPLOAD_MAX_BYTES) {
    throw new Error(
      `${filename} is ${stat.size} bytes, over the ${UPLOAD_MAX_BYTES}-byte limit of a single-request Drive upload. A larger file needs a resumable upload, which this server does not implement. ${UPLOAD_OUTCOME}`,
    );
  }

  const upload: LocalUpload = { path: resolved, filename, sizeBytes: stat.size, mimeType: uploadMimeType(filename) };
  if (convert) {
    const target = conversionTargetFor(filename);
    if (target === undefined) {
      throw new Error(
        `${filename} cannot be converted to a Google Doc or Sheet. Convertible: ${describeConvertible()}. Omit convertToGoogleDoc to upload it as it is. ${UPLOAD_OUTCOME}`,
      );
    }
    upload.convertTo = target;
  }
  return upload;
}

// Same check-before-write order as saveAttachmentToDrive: folder, name,
// collision, then the one files.create. Parents plus supportsAllDrives is all
// a shared-drive folder needs; the drive id follows from the parent.
async function uploadFile(
  drive: drive_v3.Drive,
  input: { local: LocalUpload; folderId: string; name?: string; description?: string },
): Promise<{ file: FileProjection; source: { path: string; sizeBytes: number; mimeType: string }; converted: boolean }> {
  const { local } = input;
  await getFolder(drive, input.folderId, UPLOAD_OUTCOME);

  // A converted file is a Google Doc or Sheet, which carries no extension in
  // Drive — Drive's own "Save as Google Docs" drops it too.
  const defaultName = local.convertTo ? path.basename(local.filename, path.extname(local.filename)) : local.filename;
  const targetName = input.name ?? defaultName;
  assertDriveName(targetName, UPLOAD_OUTCOME);
  const existing = await findByExactName(drive, targetName, input.folderId);
  if (existing) {
    throw new Error(
      `A file named "${targetName}" already exists in that folder (id ${existing.id}, ${existing.webViewLink}). Pass a different name. ${UPLOAD_OUTCOME}`,
    );
  }

  const requestBody: drive_v3.Schema$File = { name: targetName, parents: [input.folderId] };
  if (input.description !== undefined) {
    requestBody.description = input.description;
  }
  if (local.convertTo !== undefined) {
    requestBody.mimeType = local.convertTo;
  }

  const response = await drive.files.create({
    requestBody,
    media: { mimeType: local.mimeType, body: Readable.from(fs.readFileSync(local.path)) },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });

  return {
    file: fileProjection(response.data),
    source: { path: local.path, sizeBytes: local.sizeBytes, mimeType: local.mimeType },
    converted: local.convertTo !== undefined,
  };
}

// --- drive_download_file ---

// A caller-supplied local name is refused rather than silently cleaned, so a
// "../" never turns into some other file name the caller did not ask for. A
// name taken from Drive is cleaned instead, the way gmail_get_attachment
// cleans a sender's attachment filename.
export function assertLocalFilename(name: string, outcome: string): void {
  const cleaned = sanitizeAttachmentFilename(name, "download");
  if (cleaned !== name) {
    throw new Error(`name "${name}" is not a plain file name. Pass a name with no path or reserved characters, such as "${cleaned}". ${outcome}`);
  }
}

function describeOutsideOutDir(inputDir: string | undefined, realRoot: string, outcome: string): string {
  return `outDir "${inputDir}" resolves outside the account's download directory ${realRoot}. ${outcome}`;
}

// Resolves outDir without creating it, so a call refused later (a Google Doc,
// a local name clash) leaves no empty directory behind. The deepest part of
// the path that already exists is resolved to its real path and checked, so a
// symlink inside the directory that points elsewhere is refused before
// anything could be created through it. The result is expressed on the real
// path of that existing part.
export function resolveOutDir(inputDir: string | undefined, root: string, outcome: string): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);
  const resolved = path.resolve(realRoot, inputDir ?? ".");
  if (!isWithinRoot(resolved, realRoot, true) && !isWithinRoot(resolved, path.resolve(root), true)) {
    throw new Error(describeOutsideOutDir(inputDir, realRoot, outcome));
  }

  let existing = resolved;
  while (!fs.existsSync(existing)) {
    existing = path.dirname(existing);
  }
  const realExisting = fs.realpathSync(existing);
  if (!isWithinRoot(realExisting, realRoot, true)) {
    throw new Error(describeOutsideOutDir(inputDir, realRoot, outcome));
  }
  return path.join(realExisting, path.relative(existing, resolved));
}

export type DownloadVerdict = {
  sizeBytes: number;
  md5Checksum: string;
  verified: { size: true | "unavailable"; md5: true | "unavailable" };
};

export function verifyDownloadedBytes(bytes: Buffer, file: FileProjection, outcome: string): DownloadVerdict {
  const sizeBytes = bytes.byteLength;
  const md5Checksum = crypto.createHash("md5").update(bytes).digest("hex");
  if (file.sizeBytes !== undefined && file.sizeBytes !== sizeBytes) {
    throw new Error(
      `Downloaded ${sizeBytes} bytes, but Drive reports ${file.sizeBytes} for file ${file.id} ("${file.name}"). The download is incomplete; retry. ${outcome}`,
    );
  }
  if (file.md5Checksum !== undefined && file.md5Checksum !== md5Checksum) {
    throw new Error(
      `Downloaded content has md5 ${md5Checksum}, but Drive reports ${file.md5Checksum} for file ${file.id} ("${file.name}"). The download is corrupt; retry. ${outcome}`,
    );
  }
  return {
    sizeBytes,
    md5Checksum,
    verified: {
      size: file.sizeBytes === undefined ? "unavailable" : true,
      md5: file.md5Checksum === undefined ? "unavailable" : true,
    },
  };
}

function describeLocalExists(target: string): string {
  return `A local file already exists at ${target}. Pass a different name; this tool never overwrites a local file. ${DOWNLOAD_OUTCOME}`;
}

function localPathTaken(target: string): boolean {
  try {
    // lstat, so a dangling symlink at the target counts as taken too.
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

// Order: file checks (type, size) and the local name clash all come before the
// content request, so a refusal never costs a download; the bytes are verified
// in memory and only then written, with flag "wx" so a file that appeared in
// the meantime is still never overwritten.
async function downloadFile(
  drive: drive_v3.Drive,
  input: { account: string; fileId: string; directory: string; name?: string; maxBytes: number },
): Promise<{ file: FileProjection; savedTo: string } & DownloadVerdict> {
  const file = await getFileForDownload(drive, input.fileId, DOWNLOAD_OUTCOME);
  const overCap = (size: number) =>
    `File ${file.id} ("${file.name}") is ${size} bytes, over maxBytes ${input.maxBytes}. Pass a larger maxBytes to download it. ${DOWNLOAD_OUTCOME}`;
  if (file.sizeBytes !== undefined && file.sizeBytes > input.maxBytes) {
    throw new Error(overCap(file.sizeBytes));
  }

  const target = path.join(input.directory, input.name ?? sanitizeAttachmentFilename(file.name, file.id));
  if (localPathTaken(target)) {
    throw new Error(describeLocalExists(target));
  }

  const response = await drive.files.get(
    { fileId: file.id, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  const bytes = Buffer.from(response.data as unknown as ArrayBuffer);
  if (bytes.byteLength > input.maxBytes) {
    throw new Error(overCap(bytes.byteLength));
  }
  const verdict = verifyDownloadedBytes(bytes, file, DOWNLOAD_OUTCOME);

  fs.mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(downloadDir(input.account));
  if (!isWithinRoot(fs.realpathSync(input.directory), realRoot, true)) {
    throw new Error(describeOutsideOutDir(input.directory, realRoot, DOWNLOAD_OUTCOME));
  }
  try {
    fs.writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(describeLocalExists(target));
    }
    throw error;
  }

  return { file, savedTo: target, ...verdict };
}

export function registerDriveTransferTools(server: McpServer): void {
  server.tool(
    "drive_upload_file",
    "Upload a local file into a Google Drive folder (My Drive or a shared drive). filePath must be inside this account's own download directory (OCTOMAIL_DOWNLOAD_DIR/<account>) — the directory gmail_get_attachment and drive_download_file write into; anything outside it is refused. Up to 5 MB. With convertToGoogleDoc: true a .docx/.doc/.odt/.rtf/.txt becomes a Google Doc and an .xlsx/.xls/.ods/.csv a Google Sheet, named without the extension by default. Refuses when a file with the resulting name already exists in the folder rather than overwriting it. Only creates: it cannot delete, rename, move, or share anything.",
    {
      ...accountShape,
      filePath: z
        .string()
        .min(1)
        .describe("Local file inside OCTOMAIL_DOWNLOAD_DIR/<account>. Relative paths resolve against that directory."),
      folderId: z.string().min(1).describe("Destination Drive folder id (My Drive or a shared drive)."),
      name: z
        .string()
        .min(1)
        .optional()
        .describe("Drive file name. Defaults to the local file name, without its extension when converting."),
      convertToGoogleDoc: z
        .boolean()
        .optional()
        .describe("Convert on upload: word-processing files to a Google Doc, spreadsheets and .csv to a Google Sheet."),
      description: z.string().max(MAX_DESCRIPTION_CHARS).optional().describe("Drive file description."),
    },
    async ({ account, filePath, folderId, name, convertToGoogleDoc, description }) =>
      safeTool(async () => {
        if (name !== undefined) {
          assertDriveName(name, UPLOAD_OUTCOME);
        }
        const local = prepareLocalUpload(account, filePath, convertToGoogleDoc ?? false);
        return await driveScopeAware(account, UPLOAD_OUTCOME, async () => {
          const drive = await driveForAccount(account);
          return await uploadFile(drive, { local, folderId, name, description });
        });
      }, account),
  );

  server.tool(
    "drive_download_file",
    "Download a Drive file that has bytes of its own (a PDF, .docx, .xlsx, image, archive) into this account's download directory (OCTOMAIL_DOWNLOAD_DIR/<account>, or an outDir inside it) and return the path as savedTo — never the content. The size and md5 are checked against Drive's metadata before anything is written, and both are returned. A Google Doc, Sheet or other Google-native file is refused: read those with drive_export_file. Refuses when the local file already exists rather than overwriting it. Files over maxBytes (default 100 MB) are refused before any content is fetched. Read-only on Drive.",
    {
      ...accountShape,
      fileId: z.string().min(1).describe("Drive file id of a non-Google-native file."),
      outDir: z
        .string()
        .min(1)
        .optional()
        .describe("Directory inside OCTOMAIL_DOWNLOAD_DIR/<account>, created if missing. Relative paths resolve against it. Defaults to that directory."),
      name: z
        .string()
        .min(1)
        .optional()
        .describe("Local file name, with no path. Defaults to the Drive file name with unsafe characters replaced."),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`Refuse files larger than this many bytes. Default ${DOWNLOAD_DEFAULT_MAX_BYTES} (100 MB).`),
    },
    async ({ account, fileId, outDir, name, maxBytes }) =>
      safeTool(async () => {
        const directory = resolveOutDir(outDir, downloadDir(account), DOWNLOAD_OUTCOME);
        if (name !== undefined) {
          assertLocalFilename(name, DOWNLOAD_OUTCOME);
        }
        return await driveScopeAware(account, DOWNLOAD_OUTCOME, async () => {
          const drive = await driveForAccount(account);
          return await downloadFile(drive, {
            account,
            fileId,
            directory,
            name,
            maxBytes: maxBytes ?? DOWNLOAD_DEFAULT_MAX_BYTES,
          });
        });
      }, account),
  );
}
