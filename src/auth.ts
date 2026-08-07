import process from "node:process";
import { readFlagValue } from "./cli-args.js";
import { authorizeAccount } from "./oauth.js";

function parseArgs(argv: string[]): { account?: string; label?: string } {
  return {
    account: readFlagValue(argv, "account"),
    label: readFlagValue(argv, "label"),
  };
}

async function main(): Promise<void> {
  const { account, label } = parseArgs(process.argv.slice(2));
  if (!account) {
    throw new Error("Missing --account. Example: npm run auth -- --account work");
  }

  await authorizeAccount(account, { label });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
