import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"), quiet: true });

export type RawAccountEntry = {
  tokenPath?: string;
  label?: string;
  email?: string;
};

export type RawAccountsConfig = {
  accounts: Record<string, RawAccountEntry>;
};

export type AccountConfig = {
  tokenPath: string;
  label?: string;
  email?: string;
};

export type AccountsConfig = {
  accounts: Record<string, AccountConfig>;
};

export type OAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

const ALIAS_PATTERN = /^[a-zA-Z0-9_-]+$/;

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
  return expandPath(process.env.GMAIL_MCP_ACCOUNTS_FILE ?? "accounts.json");
}

export function tokenDir(): string {
  return expandPath(process.env.GMAIL_MCP_TOKEN_DIR ?? "~/.gmail-multi-mcp/tokens");
}

export function defaultTokenPath(alias: string): string {
  return path.join(tokenDir(), `${alias}.json`);
}

export function assertValidAlias(alias: string): void {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error(`Invalid account alias "${alias}". Use letters, digits, underscores or hyphens.`);
  }
}

function validateRawConfig(parsed: unknown, configPath: string): RawAccountsConfig {
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
