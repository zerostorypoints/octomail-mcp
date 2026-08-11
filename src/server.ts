import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerAttachmentTools } from "./attachments.js";
import { registerCalendarTools } from "./calendar.js";
import { loadAccountsConfig } from "./config.js";
import { registerDraftTools } from "./drafts.js";
import { registerFilterTools } from "./filters.js";
import { describeAccountError, gmailForAccount, summarizeMessage } from "./gmail.js";
import { registerLabelTools } from "./labels.js";
import { accountShape, safeTool } from "./tools.js";

const server = new McpServer({
  name: "octomail",
  version: "0.1.0",
});

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

server.tool(
  "gmail_list_accounts",
  "List configured Gmail account aliases, with their email address and whether they are authorized.",
  {},
  async () =>
    safeTool(async () => {
      const config = loadAccountsConfig();
      return {
        accounts: Object.keys(config.accounts)
          .sort()
          .map((account) => {
            const entry = config.accounts[account];
            return {
              account,
              ...(entry.email ? { email: entry.email } : {}),
              ...(entry.label ? { label: entry.label } : {}),
              authorized: fs.existsSync(entry.tokenPath),
            };
          }),
      };
    }),
);

server.tool("gmail_get_profile", "Get Gmail profile for an account.", accountShape, async ({ account }) =>
  safeTool(async () => {
    const gmail = await gmailForAccount(account);
    const response = await gmail.users.getProfile({ userId: "me" });
    return response.data;
  }, account),
);

server.tool(
  "gmail_search",
  "Search Gmail messages on one account. Results do not include attachment info (fetched with format: metadata, which never populates the MIME parts tree) — use gmail_read_message on a specific message to see its attachments.",
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
    }, account),
);

server.tool(
  "gmail_search_many",
  "Search Gmail messages across multiple configured accounts. Results are grouped by account. Results do not include attachment info (fetched with format: metadata, which never populates the MIME parts tree) — use gmail_read_message on a specific message to see its attachments.",
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
            error: describeAccountError(account, result.reason),
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
    }, account),
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
    }, account),
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
    }, account),
);

registerLabelTools(server);
registerFilterTools(server);
registerAttachmentTools(server);
registerDraftTools(server);
registerCalendarTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
