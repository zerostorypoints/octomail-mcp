import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { accountsConfigPath, loadAccountsConfig, loadOAuthCredentials, type AccountsConfig } from "./config.js";
import { describeAccountError, gmailForAccount } from "./gmail.js";

export type DoctorReport = { ok: boolean; lines: string[] };

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function newestMtime(dir: string): number {
  if (!fs.existsSync(dir)) {
    return 0;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory vanished or became unreadable mid-scan — contributes nothing.
    return 0;
  }

  let newest = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      const mtime = entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs;
      newest = Math.max(newest, mtime);
    } catch {
      // File vanished or became unreadable between readdir and stat — skip it.
    }
  }
  return newest;
}

function checkNode(): { ok: boolean; line: string } {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 20
    ? { ok: true, line: `✓ Node ${process.versions.node}` }
    : { ok: false, line: `✗ Node ${process.versions.node} — this project requires Node 20 or newer` };
}

function checkBuild(): { ok: boolean; line: string } {
  try {
    const distEntry = path.join(projectRoot, "dist", "server.js");
    if (!fs.existsSync(distEntry)) {
      return { ok: false, line: "✗ dist/server.js is missing — run: npm run build" };
    }

    if (fs.statSync(distEntry).mtimeMs < newestMtime(path.join(projectRoot, "src"))) {
      return { ok: false, line: "✗ dist/ is older than src/ — run: npm run build" };
    }

    return { ok: true, line: "✓ Build is present and current" };
  } catch (error) {
    return {
      ok: false,
      line: `✗ Could not check build status: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function checkCredentials(): { ok: boolean; line: string } {
  try {
    loadOAuthCredentials();
    return { ok: true, line: "✓ OAuth client credentials resolved" };
  } catch (error) {
    return { ok: false, line: `✗ ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function checkAccounts(
  getGmailClient: typeof gmailForAccount = gmailForAccount,
): Promise<{ ok: boolean; lines: string[] }> {
  let config: AccountsConfig;
  try {
    config = loadAccountsConfig();
  } catch (error) {
    return { ok: false, lines: [`✗ ${error instanceof Error ? error.message : String(error)}`] };
  }

  const aliases = Object.keys(config.accounts).sort();
  if (aliases.length === 0) {
    return { ok: false, lines: [`✗ No accounts configured in ${accountsConfigPath()} — run: npm run setup`] };
  }

  const lines: string[] = [];
  let ok = true;

  // Size the alias column from the actual aliases so a long one does not
  // collide with the text after it.
  const width = Math.max(...aliases.map((alias) => alias.length)) + 1;

  for (const alias of aliases) {
    const entry = config.accounts[alias];

    if (!fs.existsSync(entry.tokenPath)) {
      ok = false;
      lines.push(`✗ ${alias.padEnd(width)}— not authorized, run: npm run auth -- --account ${alias}`);
      continue;
    }

    try {
      const mode = fs.statSync(entry.tokenPath).mode & 0o777;
      if (mode !== 0o600) {
        lines.push(`! ${alias.padEnd(width)}— token file mode is ${mode.toString(8)}, expected 600: ${entry.tokenPath}`);
      }
    } catch {
      // Token file vanished/rotated between existsSync and statSync — the getProfile
      // check below is the real signal for this account, so don't fail it here.
    }

    try {
      const gmail = await getGmailClient(alias);
      const profile = await gmail.users.getProfile({ userId: "me" });
      lines.push(`✓ ${alias.padEnd(width)}→ ${profile.data.emailAddress ?? "(unknown address)"}`);
    } catch (error) {
      ok = false;
      lines.push(`✗ ${alias.padEnd(width)}— ${describeAccountError(alias, error)}`);
    }
  }

  return { ok, lines };
}

export async function runDoctor(
  getGmailClient: typeof gmailForAccount = gmailForAccount,
): Promise<DoctorReport> {
  const environment = [checkNode(), checkBuild(), checkCredentials()];
  const accounts = await checkAccounts(getGmailClient);

  return {
    ok: environment.every((check) => check.ok) && accounts.ok,
    lines: [
      "Environment:",
      ...environment.map((check) => `  ${check.line}`),
      "",
      "Accounts:",
      ...accounts.lines.map((line) => `  ${line}`),
    ],
  };
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const report = await runDoctor();
  console.log(report.lines.join("\n"));
  if (!report.ok) {
    console.log("\nSome checks failed. Fix the lines marked ✗ and run npm run doctor again.");
    process.exitCode = 1;
  }
}
