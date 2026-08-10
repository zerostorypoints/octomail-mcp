import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { gmail_v1 } from "googleapis";
import { z } from "zod";
import { attachmentSpecSchema, loadOutboundAttachments, type AttachmentSpec } from "./attachments.js";
import { getAccountConfig } from "./config.js";
import { describeAccountError, gmailForAccount, messageHeader, readAccountToken, summarizeMessage, tokenHasScope } from "./gmail.js";
import { buildMimeMessage } from "./mime.js";
import { checkRecipients, extractAddresses, type RecipientVerdict } from "./recipients.js";
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
  account: string,
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

  const attachments = await loadOutboundAttachments(gmail, input.attachments, account);

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

const COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

export function describeAllowlistRefusal(account: string, verdicts: RecipientVerdict[]): string {
  const refused = verdicts.filter((verdict) => !verdict.allowed);
  const snippet = JSON.stringify(refused.map((verdict) => verdict.address));

  return [
    `Refused to send from "${account}": ${refused.length} recipient(s) are not on that account's allowedRecipients list. Nothing was sent.`,
    ...refused.map((verdict) => `  ${verdict.address} — ${verdict.reason ?? "not allowed"}`),
    "",
    `To permit them, add to the "${account}" entry in accounts.json:`,
    // On its own line so selecting it does not drag in the surrounding prose,
    // the same reason describeMissingFilterScope formats the way it does.
    `"allowedRecipients": ${snippet}`,
    "",
    'An "@example.com" entry permits any address at that domain. Subdomains are not included.',
  ].join("\n");
}

// Serialises gmail_send_draft/gmail_update_draft/gmail_delete_draft per draft
// (keyed by "account:draftId"), so gmail_send_draft's fetch-check-send
// sequence cannot interleave with a concurrent gmail_update_draft on the same
// draft: Gmail re-reads the draft's current headers at send time, so an
// update landing between the allowlist check and the send would be
// transmitted without ever being checked. Each operation chains onto the
// previous one for its key, including when the previous one threw, so a
// failure never leaves the next caller waiting forever; the entry is removed
// once the chain settles. This closes only the in-process race between tool
// calls running in this server — a second client editing the same draft in
// Gmail concurrently is out of scope.
const draftLocks = new Map<string, Promise<unknown>>();

function withDraftLock<T>(account: string, draftId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${account}:${draftId}`;
  const previous = draftLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  draftLocks.set(key, settled);
  settled.finally(() => {
    if (draftLocks.get(key) === settled) {
      draftLocks.delete(key);
    }
  });
  return next;
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
        // extractAddresses throws on a recipient list it cannot fully account
        // for. That check must happen before drafts.create runs — otherwise a
        // draft is created, the handler throws, the model sees only an error
        // with no draft id, and retries pile up duplicate drafts.
        const verdicts = checkRecipients(
          extractAddresses(input.to, input.cc, input.bcc),
          getAccountConfig(account).allowedRecipients,
        );
        const refused = verdicts.filter((verdict) => !verdict.allowed);

        const gmail = await gmailForAccount(account);
        const { raw, threadId } = await composeRaw(gmail, { ...input, replyToMessageId }, account);

        const draft = await gmail.users.drafts.create({
          userId: "me",
          requestBody: { message: { raw, threadId } },
        });

        return {
          ...draft.data,
          ...(refused.length
            ? {
                warning: `Draft created, but it cannot be sent as addressed: ${refused
                  .map((verdict) => verdict.address)
                  .join(", ")} are not on this account's allowedRecipients. Add them to accounts.json before calling gmail_send_draft.`,
              }
            : {}),
        };
      }, account),
  );

  server.tool(
    "gmail_list_drafts",
    "List Gmail drafts on one account, newest first. Results do not include attachment info (fetched with format: metadata, which never populates the MIME parts tree) — use gmail_get_draft on a specific draft to see its attachments.",
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
      safeTool(
        () =>
          withDraftLock(account, draftId, async () => {
            const gmail = await gmailForAccount(account);
            const existing = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "metadata" });
            const existingMessage = existing.data.message ?? {};

            // Gmail has no partial update: the whole message is rebuilt, so the
            // In-Reply-To/References headers of a reply-draft must be carried
            // over explicitly here or the rebuilt message loses threading in
            // every mail client that isn't Gmail itself.
            const { raw } = await composeRaw(
              gmail,
              {
                ...input,
                inReplyTo: messageHeader(existingMessage, "In-Reply-To"),
                references: messageHeader(existingMessage, "References"),
              },
              account,
            );

            const draft = await gmail.users.drafts.update({
              userId: "me",
              id: draftId,
              requestBody: {
                message: { raw, threadId: existingMessage.threadId ?? undefined },
              },
            });

            return draft.data;
          }),
        account,
      ),
  );

  server.tool(
    "gmail_delete_draft",
    "Permanently delete a Gmail draft. Requires confirm: true — a deleted draft does not go to Trash and cannot be recovered.",
    { ...accountShape, draftId: z.string().min(1), confirm: z.boolean().optional().describe("Must be true to actually delete.") },
    async ({ account, draftId, confirm }) =>
      safeTool(
        () =>
          withDraftLock(account, draftId, async () => {
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
          }),
        account,
      ),
  );

  server.tool(
    "gmail_send_draft",
    "Send an existing Gmail draft. THIS SENDS REAL MAIL. Requires confirm: true, and every recipient on the draft's To, Cc and Bcc must be on the account's allowedRecipients list in accounts.json — an account with no such list cannot send at all. Without confirm, returns what would be sent and changes nothing.",
    { ...accountShape, draftId: z.string().min(1), confirm: z.boolean().optional() },
    async ({ account, draftId, confirm }) =>
      safeTool(
        () =>
          withDraftLock(account, draftId, async () => {
            const token = readAccountToken(account);
            if (tokenHasScope(token, COMPOSE_SCOPE) === false) {
              throw new Error(
                [
                  `Gmail account "${account}" was authorized without send access.`,
                  `Run:\n  npm run auth -- --account ${account}\n`,
                  "and approve the permission. Reading and drafting keep working meanwhile.",
                ].join(" "),
              );
            }

            const gmail = await gmailForAccount(account);
            // format: "full", not "metadata" — metadata omits the MIME parts tree,
            // so summarizeMessage would report no attachments on a draft that has
            // them, and the pre-send impact report exists to show exactly that.
            const draft = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
            const summary = summarizeMessage(draft.data.message ?? {});

            const addresses = extractAddresses(summary.headers.to, summary.headers.cc, summary.headers.bcc);
            if (!addresses.length) {
              throw new Error(`Draft ${draftId} has no recipients. Nothing was sent.`);
            }

            const { allowedRecipients } = getAccountConfig(account);
            const verdicts = checkRecipients(addresses, allowedRecipients);

            if (!confirm) {
              return {
                sent: false,
                wouldSend: {
                  draftId,
                  to: summary.headers.to,
                  cc: summary.headers.cc,
                  bcc: summary.headers.bcc,
                  subject: summary.headers.subject,
                  attachments: summary.attachments?.map((attachment) => ({
                    filename: attachment.filename,
                    sizeBytes: attachment.sizeBytes,
                  })),
                },
                recipients: verdicts,
                sendable: verdicts.every((verdict) => verdict.allowed),
                note: "Nothing was sent. Call again with confirm: true to send.",
              };
            }

            if (!verdicts.every((verdict) => verdict.allowed)) {
              throw new Error(describeAllowlistRefusal(account, verdicts));
            }

            // Fetch-check-send: the recipients checked above are the ones read
            // from this drafts.get call. Gmail re-reads the draft's *current*
            // headers when drafts.send runs — it sends by id, not by the
            // snapshot just validated — so anything that modifies this draft
            // between the get above and the send below would be transmitted
            // unchecked. withDraftLock (see module comment) is what prevents
            // that: it holds this whole handler body as one atomic unit against
            // gmail_update_draft/gmail_delete_draft on the same draft id.
            const sent = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
            return { sent: sent.data };
          }),
        account,
      ),
  );
}
