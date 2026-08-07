import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { accountsConfigPath, loadOAuthCredentials } from "./config.js";
import { runDoctor } from "./doctor.js";
import { authorizeAccount } from "./oauth.js";

export type SetupArgs = {
  account?: string;
  label?: string;
  skipVerify: boolean;
  printConfigOnly: boolean;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseSetupArgs(argv: string[]): SetupArgs {
  const readValue = (key: string): string | undefined => {
    const flagIndex = argv.indexOf(`--${key}`);
    if (flagIndex >= 0 && argv[flagIndex + 1] && !argv[flagIndex + 1].startsWith("--")) {
      return argv[flagIndex + 1];
    }

    const inline = argv.find((arg) => arg.startsWith(`--${key}=`));
    return inline ? inline.slice(`--${key}=`.length) : undefined;
  };

  return {
    account: readValue("account"),
    label: readValue("label"),
    skipVerify: argv.includes("--skip-verify"),
    printConfigOnly: argv.includes("--print-config"),
  };
}

const GOOGLE_CLOUD_STEPS = `
No OAuth client credentials found. Set one up first:

  1. Open https://console.cloud.google.com/ and create or select a project.
  2. APIs & Services > Library > enable "Gmail API".
  3. APIs & Services > OAuth consent screen > User type "External".
  4. IMPORTANT: set the publishing status to "In Production".
     In "Testing" status Google expires refresh tokens after 7 days,
     so you would have to re-authorize every account weekly.
     An unverified production app shows a warning screen you click through.
  5. APIs & Services > Credentials > Create Credentials > OAuth client ID.
  6. Application type: "Desktop app". Copy the client ID and secret.

Full walkthrough: docs/google-cloud-setup.md
`;

function printClientConfig(): void {
  const serverPath = path.join(projectRoot, "dist", "server.js");
  const accountsPath = accountsConfigPath();

  console.log("\nClaude Code — run this once:\n");
  console.log(`  claude mcp add gmail-multi --env GMAIL_MCP_ACCOUNTS_FILE=${accountsPath} -- node ${serverPath}`);

  console.log("\nClaude Desktop — add to claude_desktop_config.json under \"mcpServers\":\n");
  console.log(
    JSON.stringify(
      { "gmail-multi": { command: "node", args: [serverPath], env: { GMAIL_MCP_ACCOUNTS_FILE: accountsPath } } },
      null,
      2,
    )
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );

  console.log("\nCodex — add to ~/.codex/config.toml:\n");
  console.log(`  [mcp_servers.gmail_multi]`);
  console.log(`  command = "node"`);
  console.log(`  args = ["${serverPath}"]`);
  console.log(`  env = { GMAIL_MCP_ACCOUNTS_FILE = "${accountsPath}" }`);
  console.log("\nRestart the client afterwards so it rediscovers the server.");
}

async function ensureCredentials(rl: readline.Interface | undefined): Promise<void> {
  try {
    loadOAuthCredentials();
    console.log("✓ OAuth client credentials found.");
    return;
  } catch {
    // Fall through to collect them.
  }

  console.log(GOOGLE_CLOUD_STEPS);

  if (!rl) {
    throw new Error(
      "No OAuth credentials and no interactive terminal. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then re-run.",
    );
  }

  const clientId = (await rl.question("Client ID: ")).trim();
  const clientSecret = (await rl.question("Client secret: ")).trim();
  if (!clientId || !clientSecret) {
    throw new Error("Both a client ID and a client secret are required.");
  }

  const envPath = path.join(projectRoot, ".env");
  const existing = fs.existsSync(envPath) ? `${fs.readFileSync(envPath, "utf8").trimEnd()}\n` : "";
  fs.writeFileSync(envPath, `${existing}GOOGLE_CLIENT_ID=${clientId}\nGOOGLE_CLIENT_SECRET=${clientSecret}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(envPath, 0o600);

  process.env.GOOGLE_CLIENT_ID = clientId;
  process.env.GOOGLE_CLIENT_SECRET = clientSecret;
  console.log(`✓ Wrote credentials to ${envPath} (mode 600).`);
}

async function main(): Promise<void> {
  const args = parseSetupArgs(process.argv.slice(2));

  if (args.printConfigOnly) {
    printClientConfig();
    return;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;

  try {
    if (!interactive && !args.account) {
      throw new Error(
        [
          "No interactive terminal detected, so the wizard cannot prompt.",
          "Pass what you need as flags instead, for example:",
          "  npm run setup -- --account work --label \"Work Mail\"",
          "Other flags: --skip-verify, --print-config",
        ].join("\n"),
      );
    }

    await ensureCredentials(rl);

    if (args.account) {
      await authorizeAccount(args.account, { label: args.label });
    } else if (rl) {
      for (;;) {
        const alias = (await rl.question("\nAccount alias (blank to finish): ")).trim();
        if (!alias) {
          break;
        }

        const label = (await rl.question("Label (optional): ")).trim();
        try {
          await authorizeAccount(alias, { label: label || undefined });
        } catch (error) {
          console.error(`Authorization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (!args.skipVerify) {
      console.log("\nVerifying...\n");
      const report = await runDoctor();
      console.log(report.lines.join("\n"));
    }

    printClientConfig();
  } finally {
    rl?.close();
  }
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
