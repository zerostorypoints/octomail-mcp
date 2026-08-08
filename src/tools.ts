import { z } from "zod";
import { describeAccountError, textResult } from "./gmail.js";

export const accountShape = {
  account: z.string().min(1).describe("Configured Gmail account alias, e.g. work, personal, support."),
};

export async function safeTool(fn: () => Promise<unknown>, account?: string) {
  try {
    return textResult(await fn());
  } catch (error) {
    return textResult({
      error: account ? describeAccountError(account, error) : error instanceof Error ? error.message : String(error),
    });
  }
}

// Adding either of these destroys mail: Gmail purges trashed and spammed
// messages after 30 days. Removing them is a recovery action and is not gated.
export const DESTRUCTIVE_LABELS = ["TRASH", "SPAM"];

export function assertDestructiveLabelsConfirmed(
  addLabelNames: string[] | undefined,
  confirm: boolean | undefined,
  action: string,
): void {
  const destructive = (addLabelNames ?? []).filter((name) =>
    DESTRUCTIVE_LABELS.includes(name.toUpperCase()),
  );

  if (destructive.length && !confirm) {
    throw new Error(
      `${action} would add ${destructive.join(" and ")}, which destroys mail — Gmail purges those messages after 30 days. Nothing was changed. Call again with confirm: true if that is what you intend.`,
    );
  }
}
