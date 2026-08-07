import process from "node:process";
import { authorizeAccount } from "./oauth.js";

function parseArgs(argv: string[]): { account?: string; label?: string } {
  const result: { account?: string; label?: string } = {};

  for (const key of ["account", "label"] as const) {
    const flagIndex = argv.indexOf(`--${key}`);
    if (flagIndex >= 0 && argv[flagIndex + 1]) {
      result[key] = argv[flagIndex + 1];
      continue;
    }

    const inline = argv.find((arg) => arg.startsWith(`--${key}=`));
    if (inline) {
      result[key] = inline.slice(`--${key}=`.length);
    }
  }

  return result;
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
