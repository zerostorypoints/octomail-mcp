import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { gmail_v1 } from "googleapis";
import { z } from "zod";
import { attachmentSpecSchema, loadOutboundAttachments, type AttachmentSpec } from "./attachments.js";
import { describeAccountError, gmailForAccount, messageHeader, summarizeMessage } from "./gmail.js";
import { buildMimeMessage } from "./mime.js";
import { accountShape, safeTool } from "./tools.js";

export const draftShape = {
  to: z.string().min(1).describe("Recipient address, or a comma-separated list."),
  subject: z.string(),
  body: z.string().describe("Plain-text body. Octomail does not compose HTML mail."),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  attachments: z.array(attachmentSpecSchema).optional(),
};

type ComposeInput = {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyToMessageId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: AttachmentSpec[];
};

// RFC 5322 section 3.6.4: References is the prior chain with the parent's
// Message-ID appended, space-separated, oldest first. Absent both inputs, the
// header must be omitted entirely rather than emitted empty.
export function buildReferences(
  priorReferences: string | undefined,
  parentMessageId: string | undefined,
): string | undefined {
  return [priorReferences, parentMessageId].filter(Boolean).join(" ") || undefined;
}

async function composeRaw(
  gmail: gmail_v1.Gmail,
  input: ComposeInput,
): Promise<{ raw: string; threadId?: string }> {
  let threadId: string | undefined;
  let inReplyTo = input.inReplyTo;
  let references = input.references;

  if (input.replyToMessageId) {
    const replyTo = await gmail.users.messages.get({
      userId: "me",
      id: input.replyToMessageId,
      format: "metadata",
      metadataHeaders: ["Message-ID", "References"],
    });
    threadId = replyTo.data.threadId ?? undefined;
    inReplyTo = messageHeader(replyTo.data, "Message-ID");
    references = buildReferences(messageHeader(replyTo.data, "References"), inReplyTo);
  }

  const attachments = await loadOutboundAttachments(gmail, input.attachments);

  return {
    raw: buildMimeMessage({
      to: input.to,
      subject: input.subject,
      body: input.body,
      cc: input.cc,
      bcc: input.bcc,
      inReplyTo,
      references,
      attachments,
    }),
    threadId,
  };
}

export function registerDraftTools(server: McpServer): void {
  server.tool(
    "gmail_create_draft",
    "Create a Gmail draft. This tool does not send: use gmail_send_draft, which is gated on the account's allowedRecipients list.",
    {
      ...accountShape,
      ...draftShape,
      replyToMessageId: z.string().optional().describe("Thread the draft as a reply to this message."),
    },
    async ({ account, replyToMessageId, ...input }) =>
      safeTool(async () => {
        const gmail = await gmailForAccount(account);
        const { raw, threadId } = await composeRaw(gmail, { ...input, replyToMessageId });

        const draft = await gmail.users.drafts.create({
          userId: "me",
          requestBody: { message: { raw, threadId } },
        });

        return draft.data;
      }, account),
  );

  server.tool(
    "gmail_list_drafts",
    "List Gmail drafts on one account, newest first.",
    {
      ...accountShape,
      maxResults: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ account, maxResults }) =>
      safeTool(async () => {
        const gmail = await gmailForAccount(account);
        const list = await gmail.users.drafts.list({ userId: "me", maxResults });

        const settled = await Promise.allSettled(
          (list.data.drafts ?? []).map(async (draft) => {
            const detail = await gmail.users.drafts.get({
              userId: "me",
              id: draft.id ?? "",
              format: "metadata",
            });
            return { draftId: detail.data.id, message: summarizeMessage(detail.data.message ?? {}) };
          }),
        );

        // A single rate-limited or failed fetch must not discard every draft
        // that fetched successfully — report the failure per-draft instead.
        const drafts = settled.map((result, index) =>
          result.status === "fulfilled"
            ? result.value
            : { draftId: list.data.drafts?.[index]?.id, error: describeAccountError(account, result.reason) },
        );

        return { resultSizeEstimate: list.data.resultSizeEstimate, drafts };
      }, account),
  );

  server.tool(
    "gmail_get_draft",
    "Read one Gmail draft. Its output feeds directly back into gmail_update_draft.",
    { ...accountShape, draftId: z.string().min(1) },
    async ({ account, draftId }) =>
      safeTool(async () => {
        const gmail = await gmailForAccount(account);
        const draft = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
        return { draftId: draft.data.id, message: summarizeMessage(draft.data.message ?? {}) };
      }, account),
  );

  server.tool(
    "gmail_update_draft",
    "Replace the contents of a Gmail draft. Gmail has no partial draft update: this replaces the whole message, so ANY ATTACHMENT NOT RE-SPECIFIED IS DROPPED. To keep an existing attachment, pass {messageId: <the draft message id from gmail_get_draft>, attachmentId: ...}.",
    { ...accountShape, draftId: z.string().min(1), ...draftShape },
    async ({ account, draftId, ...input }) =>
      safeTool(async () => {
        const gmail = await gmailForAccount(account);
        const existing = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "metadata" });
        const existingMessage = existing.data.message ?? {};

        // Gmail has no partial update: the whole message is rebuilt, so the
        // In-Reply-To/References headers of a reply-draft must be carried
        // over explicitly here or the rebuilt message loses threading in
        // every mail client that isn't Gmail itself.
        const { raw } = await composeRaw(gmail, {
          ...input,
          inReplyTo: messageHeader(existingMessage, "In-Reply-To"),
          references: messageHeader(existingMessage, "References"),
        });

        const draft = await gmail.users.drafts.update({
          userId: "me",
          id: draftId,
          requestBody: {
            message: { raw, threadId: existingMessage.threadId ?? undefined },
          },
        });

        return draft.data;
      }, account),
  );

  server.tool(
    "gmail_delete_draft",
    "Permanently delete a Gmail draft. Requires confirm: true — a deleted draft does not go to Trash and cannot be recovered.",
    { ...accountShape, draftId: z.string().min(1), confirm: z.boolean().optional().describe("Must be true to actually delete.") },
    async ({ account, draftId, confirm }) =>
      safeTool(async () => {
        const gmail = await gmailForAccount(account);
        // "full" is required, not "metadata": metadata format never populates
        // the MIME parts tree, so summarizeMessage's attachments would always
        // be undefined — and this report is the only warning a permanent
        // delete gets before it happens.
        const draft = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
        const summary = summarizeMessage(draft.data.message ?? {});

        if (!confirm) {
          return {
            wouldDelete: {
              draftId,
              to: summary.headers.to,
              subject: summary.headers.subject,
              attachments: summary.attachments?.map((attachment) => attachment.filename),
            },
            note: "Draft deletion is permanent — drafts do not go to Trash. Nothing was changed. Call again with confirm: true to delete.",
          };
        }

        await gmail.users.drafts.delete({ userId: "me", id: draftId });
        return { deleted: draftId };
      }, account),
  );
}
