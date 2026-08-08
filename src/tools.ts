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
