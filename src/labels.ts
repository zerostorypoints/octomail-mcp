import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { gmail_v1 } from "googleapis";
import { z } from "zod";
import { filtersReferencingLabel } from "./filters.js";
import { gmailForAccount, isScopeInsufficientError, resolveLabelNames } from "./gmail.js";
import { accountShape, safeTool } from "./tools.js";

// Gmail rejects any colour outside this predefined palette. Verified complete
// against the reference on 2026-08-07 (102 values). Source:
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels#Label.Color
export const LABEL_COLORS: readonly string[] = [
  "#000000", "#434343", "#666666", "#999999", "#cccccc", "#efefef", "#f3f3f3", "#ffffff",
  "#fb4c2f", "#ffad47", "#fad165", "#16a766", "#43d692", "#4a86e8", "#a479e2", "#f691b3",
  "#f6c5be", "#ffe6c7", "#fef1d1", "#b9e4d0", "#c6f3de", "#c9daf8", "#e4d7f5", "#fcdee8",
  "#efa093", "#ffd6a2", "#fce8b3", "#89d3b2", "#a0eac9", "#a4c2f4", "#d0bcf1", "#fbc8d9",
  "#e66550", "#ffbc6b", "#fcda83", "#44b984", "#68dfa9", "#6d9eeb", "#b694e8", "#f7a7c0",
  "#cc3a21", "#eaa041", "#f2c960", "#149e60", "#3dc789", "#3c78d8", "#8e63ce", "#e07798",
  "#ac2b16", "#cf8933", "#d5ae49", "#0b804b", "#2a9c68", "#285bac", "#653e9b", "#b65775",
  "#822111", "#a46a21", "#aa8831", "#076239", "#1a764d", "#1c4587", "#41236d", "#83334c",
  "#464646", "#e7e7e7", "#0d3472", "#b6cff5", "#0d3b44", "#98d7e4", "#3d188e", "#e3d7ff",
  "#711a36", "#fbd3e0", "#8a1c0a", "#f2b2a8", "#7a2e0b", "#ffc8af", "#7a4706", "#ffdeb5",
  "#594c05", "#fbe983", "#684e07", "#fdedc1", "#0b4f30", "#b3efd3", "#04502e", "#a2dcc1",
  "#c2c2c2", "#4986e7", "#2da2bb", "#b99aff", "#994a64", "#f691b2", "#ff7537", "#ffad46",
  "#662e37", "#ebdbde", "#cca6ac", "#094228", "#42d692", "#16a765",
];

export function assertValidLabelColors(textColor?: string, backgroundColor?: string): void {
  if ((textColor === undefined) !== (backgroundColor === undefined)) {
    throw new Error("Set both textColor and backgroundColor, or neither — Gmail rejects a partial colour.");
  }

  for (const color of [textColor, backgroundColor]) {
    if (color !== undefined && !LABEL_COLORS.includes(color)) {
      throw new Error(
        `Colour ${color} is not in Gmail's allowed label palette. Allowed values: ${LABEL_COLORS.join(", ")}.`,
      );
    }
  }
}

// Gmail has no nesting field — hierarchy is encoded in the name as a path, and
// each level is an independent label resource. "Clients2" is NOT a child of
// "Clients"; only "Clients/..." is.
export function descendantsOf(parentName: string, allNames: string[]): string[] {
  const prefix = `${parentName}/`;
  return allNames.filter((name) => name.startsWith(prefix));
}

export function renameDescendant(oldParent: string, newParent: string, descendant: string): string {
  return `${newParent}${descendant.slice(oldParent.length)}`;
}

const visibilityShape = {
  labelListVisibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
  messageListVisibility: z.enum(["show", "hide"]).optional(),
};

const colorShape = {
  textColor: z.string().optional().describe("Hex colour from Gmail's fixed label palette, e.g. #ffffff."),
  backgroundColor: z.string().optional().describe("Hex colour from Gmail's fixed label palette, e.g. #fb4c2f."),
};

export function findLabel(labels: gmail_v1.Schema$Label[], needle: string): gmail_v1.Schema$Label {
  const match = labels.find((label) => label.name === needle || label.id === needle);
  if (!match) {
    throw new Error(`Label "${needle}" does not exist on this account.`);
  }
  return match;
}

async function listLabels(gmail: gmail_v1.Gmail): Promise<gmail_v1.Schema$Label[]> {
  const response = await gmail.users.labels.list({ userId: "me" });
  return response.data.labels ?? [];
}

export function registerLabelTools(server: McpServer): void {
  server.tool("gmail_list_labels", "List Gmail labels for an account.", accountShape, async ({ account }) =>
    safeTool(async () => {
      const gmail = await gmailForAccount(account);
      return await listLabels(gmail);
    }, account),
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
              requestBody: { addLabelIds, removeLabelIds },
            }),
          ),
        );

        return { modified: results.map((result) => result.data.id) };
      }, account),
  );

  server.tool(
    "gmail_create_label",
    'Create a Gmail label. Nest it by using a path name such as "Clients/Acme".',
    {
      ...accountShape,
      name: z.string().min(1),
      ...colorShape,
      ...visibilityShape,
    },
    async ({ account, name, textColor, backgroundColor, labelListVisibility, messageListVisibility }) =>
      safeTool(async () => {
        assertValidLabelColors(textColor, backgroundColor);
        const gmail = await gmailForAccount(account);
        const response = await gmail.users.labels.create({
          userId: "me",
          requestBody: {
            name,
            labelListVisibility,
            messageListVisibility,
            ...(textColor && backgroundColor ? { color: { textColor, backgroundColor } } : {}),
          },
        });
        return response.data;
      }, account),
  );

  server.tool(
    "gmail_update_label",
    "Rename and/or restyle a Gmail label. Gmail stores hierarchy in the name, so renaming a parent does not rename its children unless renameDescendants is true.",
    {
      ...accountShape,
      label: z.string().min(1),
      newName: z.string().min(1).optional(),
      ...colorShape,
      ...visibilityShape,
      renameDescendants: z
        .boolean()
        .optional()
        .describe("Required when renaming a label that has children. True rewrites their prefix too; false renames only the parent."),
    },
    async ({ account, label, newName, textColor, backgroundColor, labelListVisibility, messageListVisibility, renameDescendants }) =>
      safeTool(async () => {
        assertValidLabelColors(textColor, backgroundColor);
        const gmail = await gmailForAccount(account);
        const all = await listLabels(gmail);
        const target = findLabel(all, label);

        if (target.type === "system") {
          throw new Error(`"${target.name}" is a Gmail system label and cannot be modified.`);
        }

        const targetName = target.name ?? "";
        const children = newName ? descendantsOf(targetName, all.map((entry) => entry.name ?? "")) : [];

        if (children.length && renameDescendants === undefined) {
          return {
            renamed: [],
            message: `"${targetName}" has ${children.length} child label(s). Call again with renameDescendants: true to rewrite their prefix, or false to rename only the parent.`,
            descendants: children,
          };
        }

        const requestBody: gmail_v1.Schema$Label = {
          ...(newName ? { name: newName } : {}),
          ...(labelListVisibility ? { labelListVisibility } : {}),
          ...(messageListVisibility ? { messageListVisibility } : {}),
          ...(textColor && backgroundColor ? { color: { textColor, backgroundColor } } : {}),
        };

        const renamed: string[] = [];
        await gmail.users.labels.patch({ userId: "me", id: target.id as string, requestBody });
        renamed.push(targetName);

        if (newName && renameDescendants) {
          for (const child of children) {
            const childLabel = findLabel(all, child);
            try {
              await gmail.users.labels.patch({
                userId: "me",
                id: childLabel.id as string,
                requestBody: { name: renameDescendant(targetName, newName, child) },
              });
              renamed.push(child);
            } catch (error) {
              // Each descendant is its own patch call, so this is not atomic.
              // Report exactly how far it got rather than leaving it a mystery.
              throw new Error(
                `Renamed ${renamed.join(", ")} then failed on "${child}": ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }

        return { renamed, newName: newName ?? targetName };
      }, account),
  );

  server.tool(
    "gmail_delete_label",
    "Delete a Gmail label. Without confirm: true this only reports what would be lost and changes nothing. Deleting a label does not delete messages, but their categorisation is lost permanently.",
    {
      ...accountShape,
      label: z.string().min(1),
      confirm: z.boolean().optional().describe("Must be true to actually delete."),
    },
    async ({ account, label, confirm }) =>
      safeTool(async () => {
        const gmail = await gmailForAccount(account);
        const all = await listLabels(gmail);
        const target = findLabel(all, label);

        if (target.type === "system") {
          throw new Error(`"${target.name}" is a Gmail system label and cannot be deleted.`);
        }

        const detail = await gmail.users.labels.get({ userId: "me", id: target.id as string });
        const children = descendantsOf(target.name ?? "", all.map((entry) => entry.name ?? ""));

        // A filter pointing at a deleted label is silently broken, and the
        // Gmail UI never warns about it. A missing filter scope is expected —
        // label deletion does not need it — so degrade quietly there. Any other
        // failure must NOT masquerade as "no filters reference this label",
        // because this report is what the user confirms an irreversible delete
        // against.
        let referencingFilters: string[] = [];
        let filterCheckWarning: string | undefined;
        try {
          const found = await filtersReferencingLabel(gmail, target.id as string);
          referencingFilters = found.map((entry) => entry.id ?? "(unknown)");
        } catch (error) {
          if (!isScopeInsufficientError(error)) {
            filterCheckWarning = `Could not check which filters reference this label: ${error instanceof Error ? error.message : String(error)}`;
          }
        }

        if (!confirm) {
          return {
            wouldDelete: target.name,
            messagesTotal: detail.data.messagesTotal ?? 0,
            threadsTotal: detail.data.threadsTotal ?? 0,
            orphanedDescendants: children,
            referencingFilters,
            ...(filterCheckWarning ? { filterCheckWarning } : {}),
            message: "Nothing was deleted. Call again with confirm: true to delete this label.",
          };
        }

        await gmail.users.labels.delete({ userId: "me", id: target.id as string });
        return {
          deleted: target.name,
          orphanedDescendants: children,
          referencingFilters,
          ...(filterCheckWarning ? { filterCheckWarning } : {}),
        };
      }, account),
  );
}
