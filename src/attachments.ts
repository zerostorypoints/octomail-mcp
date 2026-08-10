import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { downloadDir } from "./config.js";
import { collectAttachments, gmailForAccount } from "./gmail.js";
import { accountShape, safeTool } from "./tools.js";

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
