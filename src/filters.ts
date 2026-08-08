import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { gmail_v1 } from "googleapis";
import { z } from "zod";
import {
  FILTER_SCOPE,
  describeMissingFilterScope,
  gmailForAccount,
  isScopeInsufficientError,
  readAccountToken,
  resolveLabelNames,
  tokenHasScope,
} from "./gmail.js";
import { accountShape, safeTool } from "./tools.js";

export type FilterCriteria = {
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  query?: string | null;
  negatedQuery?: string | null;
  hasAttachment?: boolean | null;
  excludeChats?: boolean | null;
  size?: number | null;
  sizeComparison?: string | null;
};

// Turns a stored filter's criteria into a Gmail search query so a filter's
// effect can be applied to mail that arrived before it existed. This is an
// APPROXIMATION: Gmail's search matching is not byte-identical to its filter
// matching, particularly `from:` against display names. That is why backfill
// is dry-run by default.
export function criteriaToQuery(criteria: FilterCriteria): string {
  const parts: string[] = [];

  if (criteria.from) parts.push(`from:(${criteria.from})`);
  if (criteria.to) parts.push(`to:(${criteria.to})`);
  if (criteria.subject) parts.push(`subject:(${criteria.subject})`);
  if (criteria.hasAttachment) parts.push("has:attachment");
  if (criteria.excludeChats) parts.push("-in:chats");
  // `!= null` rather than truthiness: size 0 is a legitimate stored value, and
  // dropping it turns "smaller:0b" (matches nothing) into no constraint at all.
  if (criteria.size != null && criteria.sizeComparison === "larger") parts.push(`larger:${criteria.size}b`);
  if (criteria.size != null && criteria.sizeComparison === "smaller") parts.push(`smaller:${criteria.size}b`);
  if (criteria.query) parts.push(criteria.query);
  if (criteria.negatedQuery) parts.push(`-(${criteria.negatedQuery})`);

  return parts.join(" ");
}

// Gmail allows at most one user-defined label per filter, counted across the
// add and remove actions together. System labels are unrestricted.
export function assertSingleUserLabel(labels: Array<{ name?: string | null; type?: string | null }>): void {
  const userLabels = labels.filter((label) => label.type !== "system").map((label) => label.name ?? "(unnamed)");

  if (userLabels.length > 1) {
    throw new Error(
      `Gmail allows at most one user-defined label per filter, across add and remove combined. Got ${userLabels.length}: ${userLabels.join(", ")}.`,
    );
  }
}

// Fails fast with an actionable message when the stored token predates the
// filter scope. Tokens that record no scope at all are unknown, not missing —
// those fall through and let Google answer, translated below.
export async function gmailWithFilterScope(account: string): Promise<gmail_v1.Gmail> {
  if (tokenHasScope(readAccountToken(account), FILTER_SCOPE) === false) {
    throw new Error(describeMissingFilterScope(account));
  }
  return await gmailForAccount(account);
}

async function withScopeErrors<T>(account: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isScopeInsufficientError(error)) {
      throw new Error(describeMissingFilterScope(account));
    }
    throw error;
  }
}

export async function filtersReferencingLabel(
  gmail: gmail_v1.Gmail,
  labelId: string,
): Promise<gmail_v1.Schema$Filter[]> {
  const response = await gmail.users.settings.filters.list({ userId: "me" });
  return (response.data.filter ?? []).filter(
    (entry) =>
      (entry.action?.addLabelIds ?? []).includes(labelId) || (entry.action?.removeLabelIds ?? []).includes(labelId),
  );
}

function labelNamesById(labels: gmail_v1.Schema$Label[]): Map<string, string> {
  return new Map(labels.filter((label) => label.id).map((label) => [label.id as string, label.name ?? (label.id as string)]));
}

async function describeFilters(
  gmail: gmail_v1.Gmail,
  filters: gmail_v1.Schema$Filter[],
): Promise<Array<Record<string, unknown>>> {
  const labels = (await gmail.users.labels.list({ userId: "me" })).data.labels ?? [];
  const names = labelNamesById(labels);
  const toNames = (ids?: string[] | null) => (ids ?? []).map((id) => names.get(id) ?? id);

  return filters.map((entry) => ({
    id: entry.id,
    criteria: entry.criteria ?? {},
    query: criteriaToQuery(entry.criteria ?? {}),
    addLabels: toNames(entry.action?.addLabelIds),
    removeLabels: toNames(entry.action?.removeLabelIds),
    ...(entry.action?.forward ? { forward: entry.action.forward } : {}),
  }));
}

export function registerFilterTools(server: McpServer): void {
  server.tool(
    "gmail_list_filters",
    "List Gmail filters for an account, with each filter's criteria rendered as the equivalent search query.",
    accountShape,
    async ({ account }) =>
      safeTool(async () => {
        const gmail = await gmailWithFilterScope(account);
        return await withScopeErrors(account, async () => {
          const response = await gmail.users.settings.filters.list({ userId: "me" });
          return { filters: await describeFilters(gmail, response.data.filter ?? []) };
        });
      }, account),
  );

  server.tool(
    "gmail_create_filter",
    "Create a Gmail filter. Filters only affect mail that arrives after they are created — use gmail_backfill_filter for existing mail. Gmail allows at most one user-defined label per filter.",
    {
      ...accountShape,
      from: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
      query: z.string().optional().describe("Raw Gmail search syntax, e.g. list:something.example.com."),
      negatedQuery: z.string().optional(),
      hasAttachment: z.boolean().optional(),
      excludeChats: z.boolean().optional(),
      size: z.number().int().min(1).optional().describe("Message size in bytes."),
      sizeComparison: z.enum(["smaller", "larger"]).optional(),
      addLabelNames: z.array(z.string().min(1)).optional(),
      removeLabelNames: z.array(z.string().min(1)).optional().describe('Use "INBOX" to skip the inbox, "SPAM" to never mark as spam.'),
      forward: z.string().optional().describe("Must already be a verified forwarding address on this account."),
    },
    async ({ account, addLabelNames, removeLabelNames, forward, ...criteria }) =>
      safeTool(async () => {
        const gmail = await gmailWithFilterScope(account);

        if (!criteriaToQuery(criteria).trim()) {
          throw new Error("A filter needs at least one criterion — refusing to create one that matches every message.");
        }

        return await withScopeErrors(account, async () => {
          const labels = (await gmail.users.labels.list({ userId: "me" })).data.labels ?? [];
          const named = [...(addLabelNames ?? []), ...(removeLabelNames ?? [])];
          assertSingleUserLabel(
            named.map((name) => {
              const match = labels.find((label) => label.name === name || label.id === name);
              if (!match) {
                throw new Error(`Label "${name}" does not exist on this account.`);
              }
              return match;
            }),
          );

          const response = await gmail.users.settings.filters.create({
            userId: "me",
            requestBody: {
              criteria,
              action: {
                addLabelIds: await resolveLabelNames(gmail, addLabelNames),
                removeLabelIds: await resolveLabelNames(gmail, removeLabelNames),
                ...(forward ? { forward } : {}),
              },
            },
          });

          return {
            created: response.data.id,
            query: criteriaToQuery(criteria),
            note: "This affects new mail only. Run gmail_backfill_filter to apply it to existing messages.",
          };
        });
      }, account),
  );

  server.tool(
    "gmail_delete_filter",
    "Delete a Gmail filter. Without confirm: true this only reports the filter's full definition and changes nothing. The Gmail API has no filter update — edit by deleting and recreating.",
    {
      ...accountShape,
      filterId: z.string().min(1),
      confirm: z.boolean().optional().describe("Must be true to actually delete."),
    },
    async ({ account, filterId, confirm }) =>
      safeTool(async () => {
        const gmail = await gmailWithFilterScope(account);
        return await withScopeErrors(account, async () => {
          const existing = await gmail.users.settings.filters.get({ userId: "me", id: filterId });
          const [described] = await describeFilters(gmail, [existing.data]);

          if (!confirm) {
            return {
              wouldDelete: described,
              message: "Nothing was deleted. Call again with confirm: true. Keep this definition — recreating a filter is the only way to edit one.",
            };
          }

          await gmail.users.settings.filters.delete({ userId: "me", id: filterId });
          return { deleted: filterId, definition: described };
        });
      }, account),
  );
}
