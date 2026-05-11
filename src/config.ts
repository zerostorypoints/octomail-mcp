import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"), quiet: true });

export type AccountConfig = {
  tokenPath: string;
};

export type AccountsConfig = {
  accounts: Record<string, AccountConfig>;
};

export type OAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

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

export function loadAccountsConfig(): AccountsConfig {
  const configPath = accountsConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Accounts config not found at ${configPath}. Copy accounts.example.json to accounts.json or set GMAIL_MCP_ACCOUNTS_FILE.`,
    );
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("accounts" in parsed) ||
    typeof (parsed as AccountsConfig).accounts !== "object" ||
    (parsed as AccountsConfig).accounts === null
  ) {
    throw new Error(`Invalid accounts config at ${configPath}. Expected {"accounts": {...}}.`);
  }

  const accounts: Record<string, AccountConfig> = {};
  for (const [alias, account] of Object.entries((parsed as AccountsConfig).accounts)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(alias)) {
      throw new Error(`Invalid account alias "${alias}". Use letters, digits, underscores or hyphens.`);
    }

    if (typeof account !== "object" || account === null || typeof account.tokenPath !== "string") {
      throw new Error(`Invalid account config for "${alias}". Expected a tokenPath string.`);
    }

    accounts[alias] = { tokenPath: expandPath(account.tokenPath) };
  }

  return { accounts };
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
