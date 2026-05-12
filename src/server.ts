import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAccountsConfig } from "./config.js";
import { encodeMimeMessage, gmailForAccount, messageHeader, resolveLabelNames, summarizeMessage, textResult } from "./gmail.js";

const server = new McpServer({
  name: "gmail-multi-mcp",
  version: "0.1.0",
});

const accountShape = {
  account: z.string().min(1).describe("Configured Gmail account alias, e.g. work, private, support."),
};

async function searchAccount(account: string, query: string, maxResults: number) {
  const gmail = await gmailForAccount(account);
  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  const messages = await Promise.all(
    (list.data.messages ?? []).map(async (message) => {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: message.id ?? "",
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      return summarizeMessage(detail.data);
    }),
  );

  return {
    account,
    resultSizeEstimate: list.data.resultSizeEstimate,
    messages,
  };
}

async function safeTool(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (error) {
    return textResult({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

server.tool("gmail_list_accounts", "List configured Gmail account aliases.", {}, async () =>
  safeTool(async () => {
    const config = loadAccountsConfig();
    return {
      accounts: Object.keys(config.accounts).sort(),
    };
  }),
);

server.tool("gmail_get_profile", "Get Gmail profile for an account.", accountShape, async ({ account }) =>
  safeTool(async () => {
    const gmail = await gmailForAccount(account);
    const response = await gmail.users.getProfile({ userId: "me" });
    return response.data;
  }),
);

server.tool(
  "gmail_search",
  "Search Gmail messages on one account.",
  {
    ...accountShape,
    query: z.string().describe("Gmail search query, e.g. from:alice@example.com newer_than:7d."),
    maxResults: z.number().int().min(1).max(50).optional().default(10),
  },
  async ({ account, query, maxResults }) =>
    safeTool(async () => {
      const result = await searchAccount(account, query, maxResults);
      return {
        resultSizeEstimate: result.resultSizeEstimate,
        messages: result.messages,
      };
    }),
);

server.tool(
  "gmail_search_many",
  "Search Gmail messages across multiple configured accounts. Results are grouped by account.",
  {
    accounts: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("Configured account aliases to search. If omitted, all configured accounts are searched."),
    query: z.string().describe("Gmail search query, e.g. from:alice@example.com newer_than:7d."),
    maxResultsPerAccount: z.number().int().min(1).max(50).optional().default(10),
  },
  async ({ accounts, query, maxResultsPerAccount }) =>
    safeTool(async () => {
      const config = loadAccountsConfig();
      const configuredAccounts = Object.keys(config.accounts).sort();
      const targetAccounts = accounts?.length ? accounts : configuredAccounts;
      const unknownAccounts = targetAccounts.filter((account) => !config.accounts[account]);

      if (unknownAccounts.length) {
        throw new Error(
          `Unknown Gmail account alias(es): ${unknownAccounts.join(", ")}. Known accounts: ${configuredAccounts.join(", ") || "(none configured)"}.`,
        );
      }

      const results = await Promise.allSettled(
        targetAccounts.map((account) => searchAccount(account, query, maxResultsPerAccount)),
      );

      return {
        query,
        maxResultsPerAccount,
        accounts: targetAccounts,
        results: results.map((result, index) => {
          const account = targetAccounts[index];
          if (result.status === "fulfilled") {
            return result.value;
          }

          return {
            account,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
        }),
      };
    }),
);

server.tool(
  "gmail_read_message",
  "Read one Gmail message.",
  {
    ...accountShape,
    messageId: z.string().min(1),
  },
  async ({ account, messageId }) =>
    safeTool(async () => {
      const gmail = await gmailForAccount(account);
      const response = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });
      return summarizeMessage(response.data);
    }),
);

server.tool(
  "gmail_read_thread",
  "Read one Gmail thread.",
  {
    ...accountShape,
    threadId: z.string().min(1),
  },
  async ({ account, threadId }) =>
    safeTool(async () => {
      const gmail = await gmailForAccount(account);
      const response = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "full",
      });
      return {
        id: response.data.id,
        historyId: response.data.historyId,
        messages: (response.data.messages ?? []).map(summarizeMessage),
      };
    }),
);

server.tool("gmail_list_labels", "List Gmail labels for an account.", accountShape, async ({ account }) =>
  safeTool(async () => {
    const gmail = await gmailForAccount(account);
    const response = await gmail.users.labels.list({ userId: "me" });
    return response.data.labels ?? [];
  }),
);

server.tool(
  "gmail_apply_labels",
  "Add and/or remove labels on Gmail messages. Label names may also be Gmail label IDs.",
  {
    ...accountShape,
    messageIds: z.array(z.string().min(1)).min(1),
    addLabelNames: z.array(z.string().min(1)).optional(),
    removeLabelNames: z.array(z.string().min(1)).optional(),
  },
  async ({ account, messageIds, addLabelNames, removeLabelNames }) =>
    safeTool(async () => {
      const gmail = await gmailForAccount(account);
      const addLabelIds = await resolveLabelNames(gmail, addLabelNames);
      const removeLabelIds = await resolveLabelNames(gmail, removeLabelNames);

      const results = await Promise.all(
        messageIds.map((id) =>
          gmail.users.messages.modify({
            userId: "me",
            id,
            requestBody: {
              addLabelIds,
              removeLabelIds,
            },
          }),
        ),
      );

      return {
        modified: results.map((result) => result.data.id),
      };
    }),
);

server.tool(
  "gmail_archive",
  "Archive Gmail messages by removing the INBOX label.",
  {
    ...accountShape,
    messageIds: z.array(z.string().min(1)).min(1),
  },
  async ({ account, messageIds }) =>
    safeTool(async () => {
      const gmail = await gmailForAccount(account);
      const results = await Promise.all(
        messageIds.map((id) =>
          gmail.users.messages.modify({
            userId: "me",
            id,
            requestBody: {
              removeLabelIds: ["INBOX"],
            },
          }),
        ),
      );

      return {
        archived: results.map((result) => result.data.id),
      };
    }),
);

server.tool(
  "gmail_create_draft",
  "Create a Gmail draft. This tool does not send email.",
  {
    ...accountShape,
    to: z.string().min(1),
    subject: z.string(),
    body: z.string(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    replyToMessageId: z.string().optional(),
  },
  async ({ account, to, subject, body, cc, bcc, replyToMessageId }) =>
    safeTool(async () => {
      const gmail = await gmailForAccount(account);
      let threadId: string | undefined;
      let inReplyTo: string | undefined;
      let references: string | undefined;

      if (replyToMessageId) {
        const replyTo = await gmail.users.messages.get({
          userId: "me",
          id: replyToMessageId,
          format: "metadata",
          metadataHeaders: ["Message-ID", "References"],
        });
        threadId = replyTo.data.threadId ?? undefined;
        inReplyTo = messageHeader(replyTo.data, "Message-ID");
        const priorReferences = messageHeader(replyTo.data, "References");
        references = [priorReferences, inReplyTo].filter(Boolean).join(" ") || undefined;
      }

      const draft = await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: {
            raw: encodeMimeMessage({ to, subject, body, cc, bcc, inReplyTo, references }),
            threadId,
          },
        },
      });

      return draft.data;
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
