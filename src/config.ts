import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load only this project's own .env (resolved relative to this module, not
// the process cwd). MCP clients launch this server with cwd set to whatever
// project the user happens to be sitting in, and dotenv's default
// `override: false` means whichever .env loads first wins a given key. A
// cwd .env belonging to an unrelated project — unremarkable in any project
// doing Google auth — would otherwise silently shadow GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, OCTOMAIL_ACCOUNTS_FILE, or OCTOMAIL_TOKEN_DIR and
// point this server at the wrong credentials or the wrong accounts file.
// Do not add a second `dotenv.config()` call for the cwd: there is no
// documented use case for it, and every real override path (per-client env
// vars passed via `claude mcp add --env ...` / `claude_desktop_config.json`)
// already works because those set process.env before this module loads.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"), quiet: true });

export type RawAccountEntry = {
  tokenPath?: string;
  label?: string;
  email?: string;
  allowedRecipients?: string[];
};

export type RawAccountsConfig = {
  accounts: Record<string, RawAccountEntry>;
};

export type AccountConfig = {
  tokenPath: string;
  label?: string;
  email?: string;
  allowedRecipients?: string[];
};

export type AccountsConfig = {
  accounts: Record<string, AccountConfig>;
};

export type OAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

const ALIAS_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Entries are either a full address or "@domain". Empty or absent means
// the account cannot send at all — the fail-closed default.
const ALLOWLIST_ENTRY = /^[A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function expandPath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return path.resolve(value);
}

export function accountsConfigPath(): string {
  return expandPath(process.env.OCTOMAIL_ACCOUNTS_FILE ?? "accounts.json");
}

export function tokenDir(): string {
  // Was ~/.gmail-multi-mcp/tokens before the project was renamed to Octomail.
  // Existing users' tokens live at the old path; OCTOMAIL_TOKEN_DIR (or a
  // one-time move of the directory) is how they migrate.
  return expandPath(process.env.OCTOMAIL_TOKEN_DIR ?? "~/.octomail/tokens");
}

export function defaultTokenPath(alias: string): string {
  return path.join(tokenDir(), `${alias}.json`);
}

export function downloadRoot(): string {
  return expandPath(process.env.OCTOMAIL_DOWNLOAD_DIR ?? "~/.octomail/attachments");
}

export function downloadDir(account: string): string {
  // Guard the alias before it becomes a path segment: aliases are validated on
  // config load, but this function is reachable with a caller-supplied string.
  assertValidAlias(account);
  return path.join(downloadRoot(), account);
}

export function assertValidAlias(alias: string): void {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error(`Invalid account alias "${alias}". Use letters, digits, underscores or hyphens.`);
  }
}

export function validateRawConfig(parsed: unknown, configPath: string): RawAccountsConfig {
  const shapeError = `Invalid accounts config at ${configPath}. Expected {"accounts": {...}}.`;
  if (typeof parsed !== "object" || parsed === null || !("accounts" in parsed)) {
    throw new Error(shapeError);
  }

  const rawAccounts = (parsed as { accounts: unknown }).accounts;
  if (typeof rawAccounts !== "object" || rawAccounts === null || Array.isArray(rawAccounts)) {
    throw new Error(shapeError);
  }

  const accounts: Record<string, RawAccountEntry> = {};
  for (const [alias, entry] of Object.entries(rawAccounts as Record<string, unknown>)) {
    assertValidAlias(alias);

    if (entry !== null && (typeof entry !== "object" || Array.isArray(entry))) {
      throw new Error(`Invalid account config for "${alias}". Expected an object such as {} or {"label": "Work"}.`);
    }

    const value = (entry ?? {}) as RawAccountEntry;
    for (const field of ["tokenPath", "label", "email"] as const) {
      if (value[field] !== undefined && typeof value[field] !== "string") {
        throw new Error(`Invalid "${field}" for account "${alias}". Expected a string.`);
      }
    }

    if (value.allowedRecipients !== undefined) {
      if (!Array.isArray(value.allowedRecipients)) {
        throw new Error(
          `Invalid "allowedRecipients" for account "${alias}". Expected an array of addresses such as ["@example.com", "person@example.com"].`,
        );
      }

      for (const recipient of value.allowedRecipients) {
        if (typeof recipient !== "string") {
          throw new Error(`Invalid allowedRecipients entry for account "${alias}". Expected a string.`);
        }
        if (recipient.trim() === "") {
          throw new Error(
            `allowedRecipients entry for account "${alias}" is empty. Expected a full address or an "@domain" entry.`,
          );
        }
        if (!/^[\x21-\x7e]+$/.test(recipient)) {
          throw new Error(
            `allowedRecipients entry "${recipient}" for account "${alias}" contains non-ASCII characters. Use ASCII only — a non-ASCII domain cannot be distinguished from a homograph.`,
          );
        }
        if (!ALLOWLIST_ENTRY.test(recipient)) {
          throw new Error(
            `allowedRecipients entry "${recipient}" for account "${alias}" is not a full address or an "@domain" entry.`,
          );
        }
      }
    }

    accounts[alias] = value;
  }

  return { accounts };
}

export function loadRawAccountsConfig(): RawAccountsConfig {
  const configPath = accountsConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Accounts config not found at ${configPath}. Run: npm run setup — or copy accounts.example.json to accounts.json.`,
    );
  }

  return validateRawConfig(JSON.parse(fs.readFileSync(configPath, "utf8")), configPath);
}

export function saveAccountsConfig(config: RawAccountsConfig): void {
  const configPath = accountsConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function resolveAccount(alias: string, entry: RawAccountEntry): AccountConfig {
  return {
    tokenPath: entry.tokenPath ? expandPath(entry.tokenPath) : defaultTokenPath(alias),
    label: entry.label,
    email: entry.email,
    allowedRecipients: entry.allowedRecipients,
  };
}

export function loadAccountsConfig(): AccountsConfig {
  const raw = loadRawAccountsConfig();
  const accounts: Record<string, AccountConfig> = {};
  for (const [alias, entry] of Object.entries(raw.accounts)) {
    accounts[alias] = resolveAccount(alias, entry);
  }
  return { accounts };
}

export function ensureAccount(alias: string, label?: string): { config: AccountConfig; created: boolean } {
  assertValidAlias(alias);

  const configPath = accountsConfigPath();
  const raw: RawAccountsConfig = fs.existsSync(configPath) ? loadRawAccountsConfig() : { accounts: {} };
  const existing = raw.accounts[alias];
  const created = existing === undefined;
  const entry: RawAccountEntry = existing ?? {};

  if (label !== undefined) {
    entry.label = label;
  }

  if (created || label !== undefined) {
    raw.accounts[alias] = entry;
    saveAccountsConfig(raw);
  }

  return { config: resolveAccount(alias, entry), created };
}

export function setAccountEmail(alias: string, email: string): void {
  const raw = loadRawAccountsConfig();
  const entry = raw.accounts[alias];
  if (!entry) {
    return;
  }
  entry.email = email;
  saveAccountsConfig(raw);
}

export function getAccountConfig(account: string): AccountConfig {
  const config = loadAccountsConfig();
  const accountConfig = config.accounts[account];
  if (!accountConfig) {
    const known = Object.keys(config.accounts).sort().join(", ") || "(none configured)";
    throw new Error(`Unknown Gmail account alias "${account}". Known accounts: ${known}.`);
  }
  return accountConfig;
}

export function loadOAuthCredentials(): OAuthCredentials {
  const envClientId = process.env.GOOGLE_CLIENT_ID;
  const envClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envClientId && envClientSecret) {
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  const credentialsFile = process.env.GOOGLE_OAUTH_CREDENTIALS_FILE ?? "credentials.json";
  const credentialsPath = expandPath(credentialsFile);
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      "OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or set GOOGLE_OAUTH_CREDENTIALS_FILE.",
    );
  }

  const parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as {
    installed?: { client_id?: string; client_secret?: string };
    web?: { client_id?: string; client_secret?: string };
  };
  const credentials = parsed.installed ?? parsed.web;
  if (!credentials?.client_id || !credentials.client_secret) {
    throw new Error(`Invalid OAuth credentials file at ${credentialsPath}.`);
  }

  return { clientId: credentials.client_id, clientSecret: credentials.client_secret };
}
