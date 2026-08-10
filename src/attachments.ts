import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { gmail_v1 } from "googleapis";
import { downloadDir, downloadRoot } from "./config.js";
import { collectAttachments, gmailForAccount } from "./gmail.js";
import { accountShape, safeTool } from "./tools.js";
import type { OutboundAttachment } from "./mime.js";

// Control characters and both separator styles. The sender chooses the
// filename parameter, so nothing in it is trusted.
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f\\/:*?"<>|]/g;

export function sanitizeAttachmentFilename(filename: string | undefined, attachmentId: string): string {
  const base = path.basename(filename ?? "");
  const cleaned = base.replace(UNSAFE_FILENAME_CHARS, "_").replace(/^[.\s]+/, "").trim();

  if (!cleaned) {
    const safeId = attachmentId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unnamed";
    return `attachment-${safeId}`;
  }

  return cleaned;
}

export function uniqueFilePath(dir: string, filename: string, exists: (candidate: string) => boolean): string {
  const extension = path.extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);

  let candidate = path.join(dir, filename);
  let counter = 2;
  while (exists(candidate)) {
    candidate = path.join(dir, `${stem} (${counter})${extension}`);
    counter += 1;
  }

  return candidate;
}

// Base64 in a tool result lands in model context. 750 KB of payload is about
// 1 MB of base64 — already large. Anything bigger belongs on disk.
export const MAX_INLINE_BASE64_BYTES = 750 * 1024;

export function assertInlineSizeWithinLimit(sizeBytes: number): void {
  if (sizeBytes > MAX_INLINE_BASE64_BYTES) {
    throw new Error(
      `Attachment is ${sizeBytes} bytes, over the ${MAX_INLINE_BASE64_BYTES}-byte inline limit. Call again with encoding: "file" to write it to disk instead.`,
    );
  }
}

export function registerAttachmentTools(server: McpServer): void {
  server.tool(
    "gmail_get_attachment",
    "Fetch one attachment from a Gmail message. Writes it into the account's download directory and returns the path (encoding: file, the default), or returns the bytes inline as base64 (encoding: base64, capped at 750 KB). Attachment ids come from the attachments array on gmail_read_message.",
    {
      ...accountShape,
      messageId: z.string().min(1),
      attachmentId: z.string().min(1),
      encoding: z.enum(["file", "base64"]).optional().default("file"),
    },
    async ({ account, messageId, attachmentId, encoding }) =>
      safeTool(async () => {
        const gmail = await gmailForAccount(account);

        const message = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const metadata = collectAttachments(message.data.payload).find(
          (candidate) => candidate.attachmentId === attachmentId,
        );

        if (!metadata) {
          throw new Error(
            `Message ${messageId} has no attachment with id ${attachmentId}. Call gmail_read_message for the current attachment ids — they change when a message is re-synced.`,
          );
        }

        const response = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: attachmentId,
        });

        if (!response.data.data) {
          throw new Error(`Gmail returned no data for attachment ${attachmentId} on message ${messageId}.`);
        }

        const content = Buffer.from(response.data.data, "base64url");

        if (encoding === "base64") {
          assertInlineSizeWithinLimit(content.byteLength);

          return {
            filename: metadata.filename,
            mimeType: metadata.mimeType,
            sizeBytes: content.byteLength,
            base64: content.toString("base64"),
          };
        }

        const directory = downloadDir(account);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

        const target = uniqueFilePath(
          directory,
          sanitizeAttachmentFilename(metadata.filename, attachmentId),
          (candidate) => fs.existsSync(candidate),
        );
        fs.writeFileSync(target, content, { mode: 0o600 });

        return {
          filename: metadata.filename,
          mimeType: metadata.mimeType,
          sizeBytes: content.byteLength,
          path: target,
        };
      }, account),
  );
}

export const attachmentSpecSchema = z.union([
  z
    .object({ path: z.string().min(1) })
    .describe("A file inside OCTOMAIL_DOWNLOAD_DIR. Relative paths resolve against that root."),
  z
    .object({ messageId: z.string().min(1), attachmentId: z.string().min(1) })
    .describe("An attachment on an existing Gmail message, re-attached without downloading it."),
]);

export type AttachmentSpec = z.infer<typeof attachmentSpecSchema>;

// Containment by string prefix is bypassable: a symlink placed inside the root
// and pointing outside it passes a prefix test. Both sides are resolved to
// real paths before comparison.
//
// Escape is checked twice: once lexically (on the joined-but-not-yet-real
// path, before touching the filesystem) and once again on the realpath'd
// target. The lexical check is what lets a traversal like "../../etc/hosts"
// be reported as an escape rather than "does not exist" — realpathSync can
// only resolve paths that exist, and a `..` traversal from a deeply nested
// tmp directory (as on macOS) may not land on a real file at all, even
// though it plainly leaves the root. The realpath check is what catches a
// symlink that sits inside the root but points outside it — a case the
// lexical check alone cannot see, since the symlink's own path is inside
// the root right up until it's dereferenced.
function assertWithinRoot(candidate: string, realRoot: string, inputPath: string): void {
  const relative = path.relative(realRoot, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Attachment path "${inputPath}" resolves outside the download root ${realRoot}. Outbound file attachments must live inside OCTOMAIL_DOWNLOAD_DIR. Nothing was created.`,
    );
  }
}

export function resolveAttachmentPath(
  inputPath: string,
  root: string,
  realpathSync: (candidate: string) => string = fs.realpathSync,
): string {
  const realRoot = realpathSync(root);
  const resolved = path.resolve(realRoot, inputPath);
  assertWithinRoot(resolved, realRoot, inputPath);

  let realTarget: string;
  try {
    realTarget = realpathSync(resolved);
  } catch {
    throw new Error(
      `Attachment path "${inputPath}" does not exist inside the download root ${realRoot}.`,
    );
  }

  assertWithinRoot(realTarget, realRoot, inputPath);

  return realTarget;
}

export async function loadOutboundAttachments(
  gmail: gmail_v1.Gmail,
  specs: AttachmentSpec[] | undefined,
): Promise<OutboundAttachment[]> {
  if (!specs?.length) {
    return [];
  }

  const loaded: OutboundAttachment[] = [];

  for (const spec of specs) {
    if ("path" in spec) {
      const resolved = resolveAttachmentPath(spec.path, downloadRoot());
      loaded.push({
        filename: path.basename(resolved),
        mimeType: "application/octet-stream",
        content: fs.readFileSync(resolved),
      });
      continue;
    }

    const message = await gmail.users.messages.get({ userId: "me", id: spec.messageId, format: "full" });
    const metadata = collectAttachments(message.data.payload).find(
      (candidate) => candidate.attachmentId === spec.attachmentId,
    );

    if (!metadata) {
      throw new Error(
        `Message ${spec.messageId} has no attachment with id ${spec.attachmentId}. Nothing was created.`,
      );
    }

    const response = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: spec.messageId,
      id: spec.attachmentId,
    });

    if (!response.data.data) {
      throw new Error(`Gmail returned no data for attachment ${spec.attachmentId}. Nothing was created.`);
    }

    loaded.push({
      filename: sanitizeAttachmentFilename(metadata.filename, spec.attachmentId),
      mimeType: metadata.mimeType,
      content: Buffer.from(response.data.data, "base64url"),
    });
  }

  return loaded;
}
