# Gmail MCP Open-Source Release and Setup Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `gmail-mcp` a presentable Apache-2.0 project distributed under the Zero Story Points GitHub org, and reduce account onboarding to a single verified command.

**Architecture:** Extract the OAuth flow out of the `auth.ts` CLI into a reusable `src/oauth.ts`, so a CLI, a setup wizard, and a health check can all drive the same authorization path. Make `accounts.json` convention-driven (optional `tokenPath`, optional `label`, auto-captured `email`) by splitting config handling into a raw layer that round-trips to disk without mangling paths and a resolved layer the runtime consumes. Then layer a wizard and a doctor on top, rewrite the docs, and move the repo.

**Tech Stack:** TypeScript 5.9 (NodeNext), Node >= 20, `@modelcontextprotocol/sdk`, `googleapis`, `google-auth-library`, `zod`, `dotenv`, `tsx`. Tests use Node's built-in `node:test` — no new runtime or test dependencies.

## Global Constraints

- Node engine floor stays `>=20`. CI matrix is Node 20 and 22.
- No new runtime or test dependencies. `google-auth-library` is promoted from transitive to explicit; nothing else is added.
- Package name is `@zerostorypoints/gmail-mcp`. `"private": true` stays in `package.json`.
- The advertised MCP server name in `src/server.ts` stays `gmail-multi-mcp`. Do not change it — live Claude Code and Codex registrations depend on it.
- License is Apache-2.0, copyright holder "Zero Story Points". Author is `Piotr Dziubecki <piotr@zerostorypoints.com>`.
- Default token directory is `~/.gmail-multi-mcp/tokens`, overridable via `GMAIL_MCP_TOKEN_DIR`.
- No public doc, example, or test may contain `/Users/<user>`, `work`, or `support`. Public examples use `work`, `personal`, `support`.
- Token files are always written at mode `0600`. `.env` written by the wizard is also mode `0600`.
- No send, trash, or delete tool is ever added.
- Existing `accounts.json` files with explicit `tokenPath` values must keep working unchanged.
- Test command is `node --import tsx --test src/*.test.ts`. Do not use bare `tsx --test` — it emits a `module.register()` deprecation warning.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/config.ts` (modify) | Sole owner of `accounts.json`: raw load/save, validation, alias rules, token path resolution, alias registration |
| `src/config.test.ts` (create) | Unit tests for config resolution, validation, and registration |
| `src/oauth.ts` (create) | The one OAuth flow: loopback callback server, token exchange, profile capture, token persistence |
| `src/auth.ts` (modify) | Thin CLI wrapper over `authorizeAccount` |
| `src/gmail.ts` (modify) | Gmail API helpers plus `invalid_grant` error translation |
| `src/gmail.test.ts` (create) | Unit tests for error translation |
| `src/server.ts` (modify) | Tool definitions; account-aware error reporting; richer `gmail_list_accounts` |
| `src/doctor.ts` (create) | Non-interactive health check, reusable by the wizard |
| `src/setup.ts` (create) | Interactive and flag-driven onboarding wizard |
| `src/setup.test.ts` (create) | Unit tests for wizard argument parsing |
| `LICENSE`, `NOTICE`, `SECURITY.md` (create) | Legal and security posture |
| `.github/workflows/ci.yml` (create) | typecheck, build, test on Node 20 and 22 |
| `README.md` (rewrite), `docs/*.md` (create) | Documentation split |
| `.claude/skills/setup-gmail-mcp/SKILL.md` (create) | Agent-native onboarding |

**Key design note carried into Task 1:** `loadAccountsConfig()` expands `~` into absolute paths. If a save path reused that resolved shape, hand-written `~/...` entries would be silently rewritten to absolute paths on every save. So config splits into a **raw** layer (exactly what is on disk, round-trips safely) and a **resolved** layer (absolute paths, what the runtime uses). Writes always go through the raw layer.

---

### Task 1: Config foundations — optional tokenPath, labels, emails, registration

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type RawAccountEntry = { tokenPath?: string; label?: string; email?: string }`
  - `type RawAccountsConfig = { accounts: Record<string, RawAccountEntry> }`
  - `type AccountConfig = { tokenPath: string; label?: string; email?: string }`
  - `type AccountsConfig = { accounts: Record<string, AccountConfig> }`
  - `tokenDir(): string`
  - `defaultTokenPath(alias: string): string`
  - `assertValidAlias(alias: string): void`
  - `loadRawAccountsConfig(): RawAccountsConfig`
  - `saveAccountsConfig(config: RawAccountsConfig): void`
  - `resolveAccount(alias: string, entry: RawAccountEntry): AccountConfig`
  - `loadAccountsConfig(): AccountsConfig` (existing name, new return shape)
  - `getAccountConfig(account: string): AccountConfig` (unchanged signature)
  - `ensureAccount(alias: string, label?: string): { config: AccountConfig; created: boolean }`
  - `setAccountEmail(alias: string, email: string): void`

- [ ] **Step 1: Add the test script to `package.json`**

In the `"scripts"` block, add:

```json
    "test": "node --import tsx --test src/*.test.ts",
```

- [ ] **Step 2: Write the failing tests**

Create `src/config.test.ts`:

```ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertValidAlias,
  defaultTokenPath,
  ensureAccount,
  expandPath,
  loadAccountsConfig,
  loadRawAccountsConfig,
  saveAccountsConfig,
  setAccountEmail,
} from "./config.js";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-test-"));
  process.env.GMAIL_MCP_ACCOUNTS_FILE = path.join(workDir, "accounts.json");
  process.env.GMAIL_MCP_TOKEN_DIR = path.join(workDir, "tokens");
});

afterEach(() => {
  delete process.env.GMAIL_MCP_ACCOUNTS_FILE;
  delete process.env.GMAIL_MCP_TOKEN_DIR;
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  fs.writeFileSync(path.join(workDir, "accounts.json"), JSON.stringify(value, null, 2));
}

test("expandPath resolves a bare tilde to the home directory", () => {
  assert.equal(expandPath("~"), os.homedir());
});

test("expandPath resolves a tilde-prefixed path", () => {
  assert.equal(expandPath("~/tokens/a.json"), path.join(os.homedir(), "tokens/a.json"));
});

test("expandPath leaves an absolute path absolute", () => {
  assert.equal(expandPath("/etc/hosts"), "/etc/hosts");
});

test("defaultTokenPath honours GMAIL_MCP_TOKEN_DIR", () => {
  assert.equal(defaultTokenPath("work"), path.join(workDir, "tokens", "work.json"));
});

test("assertValidAlias accepts letters, digits, underscores and hyphens", () => {
  assert.doesNotThrow(() => assertValidAlias("work_2-a"));
});

test("assertValidAlias rejects an alias with a slash", () => {
  assert.throws(() => assertValidAlias("work/evil"), /Invalid account alias/);
});

test("loadAccountsConfig defaults tokenPath when the entry is empty", () => {
  writeConfig({ accounts: { work: {} } });
  const config = loadAccountsConfig();
  assert.equal(config.accounts.work.tokenPath, path.join(workDir, "tokens", "work.json"));
});

test("loadAccountsConfig preserves an explicit tokenPath", () => {
  writeConfig({ accounts: { work: { tokenPath: "/custom/work.json" } } });
  const config = loadAccountsConfig();
  assert.equal(config.accounts.work.tokenPath, "/custom/work.json");
});

test("loadAccountsConfig carries label and email through", () => {
  writeConfig({ accounts: { work: { label: "Work", email: "a@example.com" } } });
  const config = loadAccountsConfig();
  assert.equal(config.accounts.work.label, "Work");
  assert.equal(config.accounts.work.email, "a@example.com");
});

test("loadAccountsConfig rejects a non-object accounts value", () => {
  writeConfig({ accounts: [] });
  assert.throws(() => loadAccountsConfig(), /Expected \{"accounts"/);
});

test("loadAccountsConfig rejects a non-string label", () => {
  writeConfig({ accounts: { work: { label: 7 } } });
  assert.throws(() => loadAccountsConfig(), /Invalid "label" for account "work"/);
});

test("loadAccountsConfig reports a missing file with recovery instructions", () => {
  assert.throws(() => loadAccountsConfig(), /npm run setup/);
});

test("saveAccountsConfig does not rewrite a tilde tokenPath into an absolute path", () => {
  writeConfig({ accounts: { work: { tokenPath: "~/tokens/work.json" } } });
  saveAccountsConfig(loadRawAccountsConfig());
  const onDisk = JSON.parse(fs.readFileSync(path.join(workDir, "accounts.json"), "utf8"));
  assert.equal(onDisk.accounts.work.tokenPath, "~/tokens/work.json");
});

test("ensureAccount creates accounts.json when it is absent", () => {
  const result = ensureAccount("work");
  assert.equal(result.created, true);
  assert.equal(result.config.tokenPath, path.join(workDir, "tokens", "work.json"));
  assert.deepEqual(loadRawAccountsConfig().accounts, { work: {} });
});

test("ensureAccount leaves an existing account untouched", () => {
  writeConfig({ accounts: { work: { tokenPath: "/custom/work.json", label: "Work" } } });
  const result = ensureAccount("work");
  assert.equal(result.created, false);
  assert.equal(result.config.tokenPath, "/custom/work.json");
  assert.equal(result.config.label, "Work");
});

test("ensureAccount applies a label to an existing account", () => {
  writeConfig({ accounts: { work: {} } });
  ensureAccount("work", "Work Mail");
  assert.equal(loadRawAccountsConfig().accounts.work.label, "Work Mail");
});

test("ensureAccount rejects an invalid alias before writing anything", () => {
  assert.throws(() => ensureAccount("bad alias"), /Invalid account alias/);
  assert.equal(fs.existsSync(path.join(workDir, "accounts.json")), false);
});

test("setAccountEmail writes the email back to the config", () => {
  writeConfig({ accounts: { work: {} } });
  setAccountEmail("work", "alice@example.com");
  assert.equal(loadRawAccountsConfig().accounts.work.email, "alice@example.com");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — TypeScript cannot resolve `assertValidAlias`, `defaultTokenPath`, `loadRawAccountsConfig`, `saveAccountsConfig`, `ensureAccount`, or `setAccountEmail` from `./config.js`.

- [ ] **Step 4: Rewrite the types and helpers in `src/config.ts`**

Replace the type block (currently `src/config.ts:11-22`) with:

```ts
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
```

- [ ] **Step 5: Add path and alias helpers**

Immediately after `accountsConfigPath()` in `src/config.ts`, add:

```ts
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
```

- [ ] **Step 6: Replace `loadAccountsConfig` with the raw/resolved split**

Replace the whole existing `loadAccountsConfig` function (currently `src/config.ts:40-73`) with:

```ts
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
```

Leave `getAccountConfig` and `loadOAuthCredentials` as they are — `getAccountConfig` still calls `loadAccountsConfig()` and now transparently returns the richer `AccountConfig`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 18 tests, 0 failures.

- [ ] **Step 8: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: no output, exit code 0.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/config.test.ts package.json
git commit -m "Make accounts config convention-driven with labels and emails"
```

---

### Task 2: Extract the OAuth flow into `src/oauth.ts`

**Files:**
- Create: `src/oauth.ts`
- Modify: `src/auth.ts` (reduce to a CLI wrapper)
- Modify: `package.json` (promote `google-auth-library` to an explicit dependency)

**Interfaces:**
- Consumes: `ensureAccount`, `setAccountEmail` from Task 1; `createOAuthClient`, `GMAIL_SCOPES` from the existing `src/gmail.ts`.
- Produces:
  - `authorizeAccount(alias: string, options?: { label?: string; openBrowser?: boolean }): Promise<AuthorizeResult>`
  - `type AuthorizeResult = { alias: string; tokenPath: string; created: boolean; email?: string; hasRefreshToken: boolean }`

- [ ] **Step 1: Promote `google-auth-library` to an explicit dependency**

It is imported at `src/gmail.ts:3` but resolves only transitively through `googleapis`, so a dependency bump could break the build. Run:

```bash
npm install --save-exact google-auth-library@9.15.1
```

Expected: `package.json` gains `"google-auth-library": "9.15.1"` under `dependencies`; `package-lock.json` updates.

- [ ] **Step 2: Create `src/oauth.ts`**

This moves `startCallbackServer` verbatim out of `src/auth.ts` and wraps it in a reusable flow.

```ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { ensureAccount, setAccountEmail } from "./config.js";
import { createOAuthClient, GMAIL_SCOPES } from "./gmail.js";
import { google } from "googleapis";

export type AuthorizeResult = {
  alias: string;
  tokenPath: string;
  created: boolean;
  email?: string;
  hasRefreshToken: boolean;
};

async function startCallbackServer(): Promise<{
  redirectUri: string;
  waitForCode: Promise<string>;
}> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;

  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Authorization failed. You can close this tab.");
      rejectCode(new Error(`OAuth authorization failed: ${error}`));
      server.close();
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing authorization code.");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Authorization complete. You can close this tab and return to the terminal.");
    resolveCode(code);
    server.close();
  });

  const redirectUri = await new Promise<string>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine OAuth callback port."));
        server.close();
        return;
      }

      resolve(`http://127.0.0.1:${address.port}/oauth2callback`);
    });
  });

  return { redirectUri, waitForCode };
}

function tryOpenBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Opening a browser is a convenience. The URL is always printed as well.
  }
}

export async function authorizeAccount(
  alias: string,
  options: { label?: string; openBrowser?: boolean } = {},
): Promise<AuthorizeResult> {
  const { config, created } = ensureAccount(alias, options.label);
  if (created) {
    console.log(`Added new account alias "${alias}" to accounts.json.`);
  }

  const { redirectUri, waitForCode } = await startCallbackServer();
  const oauth2Client = createOAuthClient(redirectUri);
  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GMAIL_SCOPES],
  });

  console.log(`\nAuthorize account "${alias}" in your browser:\n`);
  console.log(authorizeUrl);
  console.log("\nWaiting for the browser callback...");

  if (options.openBrowser !== false) {
    tryOpenBrowser(authorizeUrl);
  }

  const code = await waitForCode;
  const { tokens } = await oauth2Client.getToken(code);
  const hasRefreshToken = Boolean(tokens.refresh_token);

  if (!hasRefreshToken) {
    console.warn("Authorization succeeded, but Google did not return a refresh token.");
    console.warn("If this account was authorized before, revoke the app grant and run auth again.");
  }

  fs.mkdirSync(path.dirname(config.tokenPath), { recursive: true });
  fs.writeFileSync(config.tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.chmodSync(config.tokenPath, 0o600);

  let email: string | undefined;
  try {
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    email = profile.data.emailAddress ?? undefined;
    if (email) {
      setAccountEmail(alias, email);
    }
  } catch {
    // The token is already saved. A failed profile lookup only costs the stored email.
  }

  console.log(`Saved OAuth token for "${alias}"${email ? ` (${email})` : ""} to ${config.tokenPath}.`);

  return { alias, tokenPath: config.tokenPath, created, email, hasRefreshToken };
}
```

- [ ] **Step 3: Replace `src/auth.ts` with a thin CLI wrapper**

Overwrite the entire file:

```ts
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
```

- [ ] **Step 4: Verify typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no output from typecheck, exit code 0; `dist/oauth.js` exists afterwards.

- [ ] **Step 5: Verify the CLI still rejects a missing account**

Run: `npx tsx src/auth.ts`
Expected: prints `Missing --account. Example: npm run auth -- --account work` and exits non-zero. Do not run a real authorization here — Task 9 covers that.

- [ ] **Step 6: Run the existing tests**

Run: `npm test`
Expected: PASS — 18 tests, 0 failures (Task 1's tests must not regress).

- [ ] **Step 7: Commit**

```bash
git add src/oauth.ts src/auth.ts package.json package-lock.json
git commit -m "Extract reusable OAuth flow and capture account email"
```

---

### Task 3: Error translation and richer `gmail_list_accounts`

**Files:**
- Modify: `src/gmail.ts`
- Modify: `src/server.ts`
- Test: `src/gmail.test.ts`

**Interfaces:**
- Consumes: `loadAccountsConfig` from Task 1.
- Produces:
  - `isInvalidGrantError(error: unknown): boolean`
  - `describeAccountError(account: string, error: unknown): string`

- [ ] **Step 1: Write the failing tests**

Create `src/gmail.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAccountError, isInvalidGrantError } from "./gmail.js";

test("isInvalidGrantError detects a Gaxios response body", () => {
  assert.equal(isInvalidGrantError({ response: { data: { error: "invalid_grant" } } }), true);
});

test("isInvalidGrantError detects it in the message", () => {
  assert.equal(isInvalidGrantError(new Error("invalid_grant: Token has been expired or revoked.")), true);
});

test("isInvalidGrantError ignores unrelated errors", () => {
  assert.equal(isInvalidGrantError(new Error("Rate limit exceeded")), false);
});

test("isInvalidGrantError tolerates null and primitives", () => {
  assert.equal(isInvalidGrantError(null), false);
  assert.equal(isInvalidGrantError("invalid_grant"), false);
});

test("describeAccountError names the account and the fix command", () => {
  const message = describeAccountError("work", new Error("invalid_grant"));
  assert.match(message, /Gmail account "work"/);
  assert.match(message, /npm run auth -- --account work/);
  assert.match(message, /7 days/);
});

test("describeAccountError passes other errors through unchanged", () => {
  assert.equal(describeAccountError("work", new Error("Rate limit exceeded")), "Rate limit exceeded");
});

test("describeAccountError stringifies non-Error values", () => {
  assert.equal(describeAccountError("work", "boom"), "boom");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `describeAccountError` and `isInvalidGrantError` are not exported from `./gmail.js`.

- [ ] **Step 3: Add the error helpers to `src/gmail.ts`**

Append to `src/gmail.ts`:

```ts
export function isInvalidGrantError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    message?: unknown;
    response?: { data?: { error?: unknown } };
  };

  if (candidate.response?.data?.error === "invalid_grant") {
    return true;
  }

  return typeof candidate.message === "string" && candidate.message.includes("invalid_grant");
}

export function describeAccountError(account: string, error: unknown): string {
  if (isInvalidGrantError(error)) {
    return [
      `Gmail account "${account}" authorization has expired or was revoked.`,
      `Run: npm run auth -- --account ${account}`,
      "If your Google OAuth app is still in Testing mode, refresh tokens expire after 7 days.",
      "See docs/troubleshooting.md.",
    ].join(" ");
  }

  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 25 tests, 0 failures.

- [ ] **Step 5: Make `safeTool` account-aware in `src/server.ts`**

Update the import at `src/server.ts:5` to add `describeAccountError`:

```ts
import { describeAccountError, encodeMimeMessage, gmailForAccount, messageHeader, resolveLabelNames, summarizeMessage, textResult } from "./gmail.js";
```

Replace the `safeTool` function (currently `src/server.ts:43-51`) with:

```ts
async function safeTool(fn: () => Promise<unknown>, account?: string) {
  try {
    return textResult(await fn());
  } catch (error) {
    return textResult({
      error: account ? describeAccountError(account, error) : error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **Step 6: Pass the account into every single-account tool**

In `src/server.ts`, add `, account` as the second argument to the `safeTool(...)` call in each of these tools: `gmail_get_profile`, `gmail_search`, `gmail_read_message`, `gmail_read_thread`, `gmail_list_labels`, `gmail_apply_labels`, `gmail_archive`, `gmail_create_draft`.

For example, `gmail_get_profile` becomes:

```ts
server.tool("gmail_get_profile", "Get Gmail profile for an account.", accountShape, async ({ account }) =>
  safeTool(async () => {
    const gmail = await gmailForAccount(account);
    const response = await gmail.users.getProfile({ userId: "me" });
    return response.data;
  }, account),
);
```

Leave `gmail_list_accounts` and `gmail_search_many` alone here — they are not single-account tools.

- [ ] **Step 7: Translate per-account errors inside `gmail_search_many`**

In the `results.map(...)` callback of `gmail_search_many` (currently `src/server.ts:121-131`), replace the rejected branch so it reads:

```ts
          return {
            account,
            error: describeAccountError(account, result.reason),
          };
```

- [ ] **Step 8: Widen the `gmail_list_accounts` output**

Replace the `gmail_list_accounts` tool (currently `src/server.ts:53-60`) with:

```ts
server.tool(
  "gmail_list_accounts",
  "List configured Gmail account aliases, with their email address and whether they are authorized.",
  {},
  async () =>
    safeTool(async () => {
      const config = loadAccountsConfig();
      return {
        accounts: Object.keys(config.accounts)
          .sort()
          .map((account) => {
            const entry = config.accounts[account];
            return {
              account,
              ...(entry.email ? { email: entry.email } : {}),
              ...(entry.label ? { label: entry.label } : {}),
              authorized: fs.existsSync(entry.tokenPath),
            };
          }),
      };
    }),
);
```

Add the `fs` import at the top of `src/server.ts`, above the existing imports:

```ts
import fs from "node:fs";
```

- [ ] **Step 9: Verify typecheck, build, and tests**

Run: `npm run typecheck && npm run build && npm test`
Expected: typecheck silent, build succeeds, 25 tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/gmail.ts src/gmail.test.ts src/server.ts
git commit -m "Translate expired-token errors and report account authorization state"
```

---

### Task 4: `npm run doctor` health check

**Files:**
- Create: `src/doctor.ts`
- Modify: `package.json` (add the `doctor` script)

**Interfaces:**
- Consumes: `loadAccountsConfig`, `accountsConfigPath`, `loadOAuthCredentials` from Task 1/existing config; `describeAccountError` from Task 3; `gmailForAccount` from existing `src/gmail.ts`.
- Produces:
  - `type DoctorReport = { ok: boolean; lines: string[] }`
  - `runDoctor(): Promise<DoctorReport>`

- [ ] **Step 1: Add the doctor script to `package.json`**

In `"scripts"`, add:

```json
    "doctor": "tsx src/doctor.ts",
```

- [ ] **Step 2: Create `src/doctor.ts`**

```ts
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

  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs;
    newest = Math.max(newest, mtime);
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
  const distEntry = path.join(projectRoot, "dist", "server.js");
  if (!fs.existsSync(distEntry)) {
    return { ok: false, line: "✗ dist/server.js is missing — run: npm run build" };
  }

  if (fs.statSync(distEntry).mtimeMs < newestMtime(path.join(projectRoot, "src"))) {
    return { ok: false, line: "✗ dist/ is older than src/ — run: npm run build" };
  }

  return { ok: true, line: "✓ Build is present and current" };
}

function checkCredentials(): { ok: boolean; line: string } {
  try {
    loadOAuthCredentials();
    return { ok: true, line: "✓ OAuth client credentials resolved" };
  } catch (error) {
    return { ok: false, line: `✗ ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function checkAccounts(): Promise<{ ok: boolean; lines: string[] }> {
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

  for (const alias of aliases) {
    const entry = config.accounts[alias];

    if (!fs.existsSync(entry.tokenPath)) {
      ok = false;
      lines.push(`✗ ${alias.padEnd(12)}— not authorized, run: npm run auth -- --account ${alias}`);
      continue;
    }

    const mode = fs.statSync(entry.tokenPath).mode & 0o777;
    if (mode !== 0o600) {
      lines.push(`! ${alias.padEnd(12)}— token file mode is ${mode.toString(8)}, expected 600: ${entry.tokenPath}`);
    }

    try {
      const gmail = await gmailForAccount(alias);
      const profile = await gmail.users.getProfile({ userId: "me" });
      lines.push(`✓ ${alias.padEnd(12)}→ ${profile.data.emailAddress ?? "(unknown address)"}`);
    } catch (error) {
      ok = false;
      lines.push(`✗ ${alias.padEnd(12)}— ${describeAccountError(alias, error)}`);
    }
  }

  return { ok, lines };
}

export async function runDoctor(): Promise<DoctorReport> {
  const environment = [checkNode(), checkBuild(), checkCredentials()];
  const accounts = await checkAccounts();

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
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no output, exit code 0.

- [ ] **Step 4: Verify doctor reports a missing config cleanly**

Run: `GMAIL_MCP_ACCOUNTS_FILE=/tmp/does-not-exist.json npm run doctor`
Expected: prints an Environment block and an Accounts block whose line contains `Accounts config not found`, then exits with code 1. It must not throw an unhandled exception.

- [ ] **Step 5: Verify doctor runs against the real config**

Run: `npm run doctor`
Expected: `✓ private → <some address>` for the already-authorized account, and `✗` lines with re-auth commands for the unauthorized ones. Exit code 1 is correct at this stage.

- [ ] **Step 6: Commit**

```bash
git add src/doctor.ts package.json
git commit -m "Add npm run doctor health check"
```

---

### Task 5: `npm run setup` wizard

**Files:**
- Create: `src/setup.ts`
- Test: `src/setup.test.ts`
- Modify: `package.json` (add the `setup` script)

**Interfaces:**
- Consumes: `authorizeAccount` from Task 2; `runDoctor` from Task 4; `loadOAuthCredentials`, `accountsConfigPath` from config.
- Produces:
  - `type SetupArgs = { account?: string; label?: string; skipVerify: boolean; printConfigOnly: boolean }`
  - `parseSetupArgs(argv: string[]): SetupArgs`

- [ ] **Step 1: Add the setup script to `package.json`**

In `"scripts"`, add:

```json
    "setup": "tsx src/setup.ts",
```

- [ ] **Step 2: Write the failing tests**

Create `src/setup.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSetupArgs } from "./setup.js";

test("parseSetupArgs returns defaults for no arguments", () => {
  assert.deepEqual(parseSetupArgs([]), {
    account: undefined,
    label: undefined,
    skipVerify: false,
    printConfigOnly: false,
  });
});

test("parseSetupArgs reads space-separated flags", () => {
  const args = parseSetupArgs(["--account", "work", "--label", "Work Mail"]);
  assert.equal(args.account, "work");
  assert.equal(args.label, "Work Mail");
});

test("parseSetupArgs reads equals-separated flags", () => {
  const args = parseSetupArgs(["--account=work", "--label=Work Mail"]);
  assert.equal(args.account, "work");
  assert.equal(args.label, "Work Mail");
});

test("parseSetupArgs reads boolean flags", () => {
  const args = parseSetupArgs(["--skip-verify", "--print-config"]);
  assert.equal(args.skipVerify, true);
  assert.equal(args.printConfigOnly, true);
});

test("parseSetupArgs ignores a trailing flag with no value", () => {
  assert.equal(parseSetupArgs(["--account"]).account, undefined);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `./setup.js`.

- [ ] **Step 4: Create `src/setup.ts`**

```ts
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 30 tests, 0 failures.

- [ ] **Step 6: Verify the no-TTY guard exits instead of hanging**

Run: `npm run setup < /dev/null`
Expected: prints the "No interactive terminal detected" message with the flag examples and exits with code 1 **immediately**. If this hangs, the TTY guard is wrong — fix it before continuing.

- [ ] **Step 7: Verify config printing works standalone**

Run: `npm run setup -- --print-config`
Expected: prints Claude Code, Claude Desktop, and Codex snippets containing this checkout's absolute `dist/server.js` path. Exit code 0.

- [ ] **Step 8: Verify typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: typecheck silent, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/setup.ts src/setup.test.ts package.json
git commit -m "Add npm run setup onboarding wizard"
```

---

### Task 6: License, security policy, package metadata, CI

**Files:**
- Create: `LICENSE`, `NOTICE`, `SECURITY.md`, `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: the `test`, `doctor`, and `setup` scripts from Tasks 1, 4, and 5.
- Produces: nothing consumed by later code tasks.

- [ ] **Step 1: Add the Apache-2.0 license**

Fetch the canonical text so it is byte-correct rather than paraphrased:

```bash
curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE
```

Then confirm the appendix boilerplate at the end of the file has been filled in with `Copyright 2026 Zero Story Points` replacing the `[yyyy] [name of copyright owner]` placeholder. Edit the file directly to make that substitution.

- [ ] **Step 2: Create `NOTICE`**

```
Gmail Multi MCP
Copyright 2026 Zero Story Points

This product includes software developed at Zero Story Points
(https://zerostorypoints.com).
```

- [ ] **Step 3: Create `SECURITY.md`**

```markdown
# Security Policy

## What this server can do

This MCP server talks to the Gmail API on your behalf using these OAuth scopes:

| Scope | Why |
| --- | --- |
| `gmail.readonly` | Search, read messages and threads, list labels |
| `gmail.modify` | Apply and remove labels, archive messages |
| `gmail.compose` | Create drafts |

There is deliberately **no tool that sends mail, trashes, or deletes anything**.
The most destructive action available is removing the `INBOX` label from a
message, which archives it. Nothing is ever permanently removed.

## Where your credentials live

- OAuth client ID and secret stay in a local `.env` file, written at mode `0600`.
- Per-account OAuth tokens are written outside the repository, by default under
  `~/.gmail-multi-mcp/tokens/`, each at mode `0600`.
- `.env`, `accounts.json`, and `credentials.json` are all git-ignored. No
  credential has ever been committed to this repository.
- The server speaks stdio to a local MCP client. It opens no network listener,
  except a temporary loopback callback on `127.0.0.1` during authorization.

## Reporting a vulnerability

Email piotr@zerostorypoints.com. Please do not open a public issue for a
security report. Expect an acknowledgement within a week.
```

- [ ] **Step 4: Update `package.json` metadata**

Change `"name"` and add metadata fields. The resulting file's top block must read:

```json
{
  "name": "@zerostorypoints/gmail-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Local MCP server for using multiple Gmail accounts side by side.",
  "license": "Apache-2.0",
  "author": "Piotr Dziubecki <piotr@zerostorypoints.com>",
  "homepage": "https://github.com/zerostorypoints/gmail-mcp#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/zerostorypoints/gmail-mcp.git"
  },
  "bugs": {
    "url": "https://github.com/zerostorypoints/gmail-mcp/issues"
  },
  "keywords": [
    "mcp",
    "model-context-protocol",
    "gmail",
    "claude",
    "claude-code",
    "codex",
    "typescript"
  ],
```

Leave `"private": true`, `bin`, `scripts`, `engines`, `dependencies`, and `devDependencies` as they are.

- [ ] **Step 5: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node-version: ["20", "22"]

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm

      - run: npm ci

      - run: npm run typecheck

      - run: npm run build

      - run: npm test
```

- [ ] **Step 6: Verify the full CI sequence locally**

Run: `npm run typecheck && npm run build && npm test`
Expected: typecheck silent, build succeeds, 30 tests pass. This is exactly what CI will run.

- [ ] **Step 7: Confirm the license file is complete**

Run: `head -3 LICENSE && grep -c "Copyright 2026 Zero Story Points" LICENSE && wc -l LICENSE`
Expected: first lines show the Apache License header, the grep count is at least 1, and the file is roughly 200 lines. A count of 0 means Step 1's substitution was missed.

- [ ] **Step 8: Commit**

```bash
git add LICENSE NOTICE SECURITY.md .github/workflows/ci.yml package.json
git commit -m "Add Apache-2.0 license, security policy, org metadata and CI"
```

---

### Task 7: Documentation rewrite

**Files:**
- Modify: `README.md` (rewrite), `accounts.example.json`, `.env.example`
- Create: `docs/google-cloud-setup.md`, `docs/accounts.md`, `docs/clients.md`, `docs/troubleshooting.md`

**Interfaces:**
- Consumes: the commands and behaviours built in Tasks 1-5. Every command shown must be one that exists.
- Produces: nothing consumed by later code tasks.

Every file below must obey the Global Constraints: no `/Users/<user>`, no `work`, no `support`. Use `work`, `personal`, `support` and `/path/to/gmail-mcp`.

- [ ] **Step 1: Rewrite `accounts.example.json`**

```json
{
  "accounts": {
    "personal": { "label": "Personal Gmail" },
    "work": { "label": "Work (Google Workspace)" },
    "support": {}
  }
}
```

- [ ] **Step 2: Rewrite `.env.example`**

```bash
# OAuth client credentials from your Google Cloud Desktop app client.
GOOGLE_CLIENT_ID=your-google-oauth-desktop-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret

# Instead of the two variables above, you may point at a downloaded OAuth JSON file:
# GOOGLE_OAUTH_CREDENTIALS_FILE=/absolute/path/to/credentials.json

# Optional. Defaults to ./accounts.json.
# GMAIL_MCP_ACCOUNTS_FILE=/absolute/path/to/accounts.json

# Optional. Defaults to ~/.gmail-multi-mcp/tokens.
# GMAIL_MCP_TOKEN_DIR=/absolute/path/to/tokens
```

- [ ] **Step 3: Write `docs/google-cloud-setup.md`**

Required sections, in order:

1. **Create a project and enable the Gmail API** — console URL, `APIs & Services > Library`, enable "Gmail API".
2. **Configure the OAuth consent screen** — choose **External** for a mix of personal and Workspace accounts; **Internal** only works if every account belongs to one Workspace org. Fill in app name, support email, developer contact.
3. **Publishing status: use "In Production"** — this section must state plainly that a Testing-status app with External user type issues refresh tokens that expire after **7 days**, so every account needs weekly re-authorization; that "In Production" gives non-expiring refresh tokens; and that an unverified production app shows a warning screen the user clicks through via "Advanced", with a 100-user cap that is irrelevant for personal use. Link https://developers.google.com/identity/protocols/oauth2/production-readiness/overview.
4. **Test users (only if you stay in Testing)** — add each Gmail address exactly; a missing address produces `403 access_denied`.
5. **Create the OAuth client** — `Credentials > Create Credentials > OAuth client ID`, application type **Desktop app**. Explain that the loopback redirect `http://127.0.0.1:<port>/oauth2callback` requires the Desktop type.
6. **Give the credentials to the project** — `npm run setup` prompts for them, or set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`, or point `GOOGLE_OAUTH_CREDENTIALS_FILE` at a downloaded JSON.
7. **Scopes requested** — the same table as `SECURITY.md`: `gmail.readonly`, `gmail.modify`, `gmail.compose`, and the note that no send or delete tool exists.
8. **Personal Gmail vs Google Workspace** — state explicitly that this project treats them **identically**: same config, same commands, same token storage. The only differences are the consent-screen user type above, and that a Workspace admin may block the OAuth app entirely, in which case the admin must allow it.

- [ ] **Step 4: Write `docs/accounts.md`**

Required sections:

1. **What an alias is** — the string passed as the `account` parameter by the MCP client. Rules: letters, digits, underscores, hyphens. Keep them short and stable.
2. **Adding an account** — `npm run auth -- --account work --label "Work Mail"`. State that the alias is created in `accounts.json` automatically, so no hand-editing is needed, and that the command prints `Added new account alias "work" to accounts.json` when it creates one.
3. **The `accounts.json` format** — show the example file from Step 1. Document all three optional fields: `tokenPath` (defaults to `~/.gmail-multi-mcp/tokens/<alias>.json`), `label` (free text you write), `email` (written automatically after a successful authorization; do not hand-edit).
4. **Where tokens live** — default directory, mode `0600`, `GMAIL_MCP_TOKEN_DIR` override, and that one token file per alias is required — never share a token file between aliases.
5. **Checking which accounts work** — `npm run doctor`, with a sample output block showing one `✓` line and one `✗` line.
6. **Removing an account** — delete the entry from `accounts.json`, delete its token file, and revoke the grant at https://myaccount.google.com/permissions.

- [ ] **Step 5: Write `docs/clients.md`**

Required sections:

1. **Get the paths** — `npm run setup -- --print-config` prints ready-to-paste blocks for all three clients with correct absolute paths; the rest of the page shows what those blocks look like.
2. **Claude Code** — the `claude mcp add gmail-multi --env GMAIL_MCP_ACCOUNTS_FILE=/path/to/gmail-mcp/accounts.json -- node /path/to/gmail-mcp/dist/server.js` form.
3. **Claude Desktop** — a `claude_desktop_config.json` JSON block under `mcpServers` with `command`, `args`, and `env`.
4. **Codex** — the `[mcp_servers.gmail_multi]` TOML block with `command`, `args`, `env`.
5. **After changing client config** — restart the client so it rediscovers the server; run `npm run build` first if `dist/` is stale.
6. **Moving the checkout** — a warning that all three configs embed absolute paths, so moving or renaming the directory breaks them; re-run `npm run setup -- --print-config` and paste the new values.
7. **Example prompts** — three or four, using `work` / `personal` / `support` aliases, covering `gmail_search`, `gmail_search_many`, `gmail_read_thread`, and `gmail_archive`.

- [ ] **Step 6: Write `docs/troubleshooting.md`**

One section per symptom. Each states the symptom, the cause, and the fix.

1. **`403 access_denied`, "app can only be accessed by developer-approved testers"** — the signed-in address is not on the Testing-mode test-user list, or the browser picked a different Google account. Add the address as a test user, wait a minute, retry in a private window. Better: move the app to In Production.
2. **`Gmail account "..." authorization has expired or was revoked`** — usually the 7-day Testing-mode refresh token expiry. Fix by moving the app to In Production, then re-running `npm run auth -- --account <alias>`. Cross-link `docs/google-cloud-setup.md`.
3. **"Google did not return a refresh token"** — the account was authorized before. Revoke the grant at https://myaccount.google.com/permissions and re-run auth.
4. **Workspace admin blocks the app** — authorization fails even with the user on the test-user list; the Workspace admin must allow the OAuth app or approve the Gmail scopes.
5. **Tools missing or stale in the client** — `dist/` is out of date or the client was not restarted. Run `npm run build`, then restart. `npm run doctor` reports a stale build directly.
6. **`Accounts config not found`** — run `npm run setup`, or copy `accounts.example.json` to `accounts.json`, or set `GMAIL_MCP_ACCOUNTS_FILE`.
7. **The setup wizard exits saying there is no interactive terminal** — expected when run by an agent or in a pipe. Pass flags instead: `npm run setup -- --account work --label "Work Mail"`.

- [ ] **Step 7: Rewrite `README.md`**

Target roughly 120 lines. Required sections, in order:

1. **Title and one-paragraph description** — a local MCP server that exposes several Gmail accounts side by side, each addressed by an explicit alias. No forwarding, no mailbox aggregation, no shared token.
2. **Safety** — the tool list excludes send, trash, and delete; archiving only removes the `INBOX` label; tokens are local at mode `0600`. Link `SECURITY.md`.
3. **Requirements** — Node 20 or newer, a Google Cloud project with the Gmail API enabled.
4. **Quickstart** — a single fenced block:
   ```bash
   npm install
   npm run build
   npm run setup
   ```
   followed by a sentence saying the wizard collects OAuth credentials, authorizes each account in the browser, verifies every account, and prints the client config to paste.
5. **Tools** — the existing ten-item list from the current README, unchanged in content.
6. **Documentation** — a table linking `docs/google-cloud-setup.md`, `docs/accounts.md`, `docs/clients.md`, `docs/troubleshooting.md`, with a one-line description each.
7. **Commands** — a table of `npm run setup`, `npm run auth -- --account <alias>`, `npm run doctor`, `npm run build`, `npm run dev`, `npm test`, one line each.
8. **Notes** — carry over the behavioural notes from the current README lines 249-254: `gmail_apply_labels` accepts names or IDs; `gmail_search_many` searches all accounts when `accounts` is omitted and returns per-account errors without hiding successes; `gmail_archive` only removes `INBOX`; `gmail_create_draft` never sends; unknown aliases and missing tokens return readable errors.
9. **License** — Apache-2.0, Copyright 2026 Zero Story Points.

- [ ] **Step 8: Verify no personal identifiers leaked into the docs**

Run: `grep -rniE "<user>|work|support" README.md docs/ .env.example accounts.example.json SECURITY.md; echo "exit: $?"`
Expected: no matches, `exit: 1`. Any match must be fixed before committing. Note that `docs/superpowers/` legitimately contains the spec and this plan — restrict the grep to the paths listed above.

- [ ] **Step 9: Verify every command named in the docs exists**

Run: `npm run 2>&1 | grep -E "setup|auth|doctor|build|dev|test|typecheck"`
Expected: `setup`, `auth`, `doctor`, `build`, `dev`, `test`, and `typecheck` all appear. Any command referenced in the docs but missing here is a documentation bug.

- [ ] **Step 10: Commit**

```bash
git add README.md docs/google-cloud-setup.md docs/accounts.md docs/clients.md docs/troubleshooting.md accounts.example.json .env.example
git commit -m "Split documentation into task-oriented guides"
```

---

### Task 8: Claude Code onboarding skill

**Files:**
- Create: `.claude/skills/setup-gmail-mcp/SKILL.md`

**Interfaces:**
- Consumes: the flag-driven commands from Tasks 4 and 5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Create `.claude/skills/setup-gmail-mcp/SKILL.md`**

```markdown
---
name: setup-gmail-mcp
description: Use when setting up or troubleshooting this Gmail MCP server — configuring OAuth credentials, authorizing Gmail accounts, verifying they work, or registering the server with an MCP client.
---

# Setting up Gmail MCP

This server exposes several Gmail accounts to an MCP client, each addressed by
an alias. Setting it up means: OAuth credentials once, then one authorization
per account, then registering the server with the client.

## Important: you have no TTY

`npm run setup` with no arguments prompts interactively and will refuse to run
without a terminal. Always drive it with flags instead.

## Steps

1. **Check the current state first.**

   ```bash
   npm run doctor
   ```

   Read the output before doing anything. It reports Node version, whether the
   build is current, whether OAuth credentials resolve, and for each configured
   account either `✓ alias → address` or a `✗` line containing the exact command
   that fixes it. If everything is `✓`, there is nothing to do.

2. **If OAuth credentials are missing**, do not try to create them yourself.
   Tell the user to follow `docs/google-cloud-setup.md`, and stress the
   publishing-status point: a Testing-status app expires refresh tokens after
   7 days. Ask them to paste the client ID and secret, then write them to `.env`
   at mode `0600`.

3. **Authorize each account the user names.** One command per account:

   ```bash
   npm run auth -- --account work --label "Work Mail"
   ```

   This prints a Google URL and blocks until the user completes the browser
   flow. Surface the URL to the user and wait. The alias is added to
   `accounts.json` automatically — never hand-edit that file to add an account.
   Run this in the background or with a generous timeout, since it waits on a
   human.

4. **Verify.**

   ```bash
   npm run doctor
   ```

   Every account the user asked for should now be `✓`. If one is still `✗`,
   read the message and consult `docs/troubleshooting.md` — do not guess.

5. **Register the server with the client.**

   ```bash
   npm run setup -- --print-config
   ```

   This prints correct absolute paths for Claude Code, Claude Desktop, and
   Codex. For Claude Code, run the printed `claude mcp add` command. For the
   other two, give the user the block to paste and tell them to restart the
   client.

## Rules

- Never write, read back, or echo OAuth tokens, client secrets, or the contents
  of files under the token directory.
- Never add an account by editing `accounts.json` directly; use `npm run auth`.
- If `npm run doctor` says the build is stale, run `npm run build` before
  drawing any other conclusion.
```

- [ ] **Step 2: Verify the skill file is discoverable and well-formed**

Run: `head -5 .claude/skills/setup-gmail-mcp/SKILL.md`
Expected: a YAML frontmatter block opening with `---`, containing `name:` and `description:` keys.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/setup-gmail-mcp/SKILL.md
git commit -m "Add Claude Code onboarding skill"
```

---

### Task 9: Local setup and end-to-end verification

**Files:** none. This task changes the operator's machine, not the repository.

**Interfaces:**
- Consumes: every command built in Tasks 1-5.
- Produces: a verified working installation.

This task requires the operator at a browser. An agent must not attempt to complete the Google consent screen.

- [ ] **Step 1: Build the current code**

Run: `npm run build`
Expected: succeeds, `dist/server.js` is newer than everything in `src/`.

- [ ] **Step 2: Establish the baseline**

Run: `npm run doctor`
Expected: `✓ private → <address>`; `✗` lines for `work` and `support` telling you to run auth. Record which accounts are failing.

- [ ] **Step 3: Authorize the remaining accounts**

For each unauthorized alias, and for any additional account the operator wants:

```bash
npm run auth -- --account work --label "Work (Workspace)"
```

The command prints a URL, opens the browser, and waits. In the browser, pick the Google account that matches the alias. Repeat per account. If a `403 access_denied` appears, follow `docs/troubleshooting.md`.

- [ ] **Step 4: Verify every account**

Run: `npm run doctor`
Expected: a `✓ alias → address` line for every configured account, and exit code 0. Confirm each address is the mailbox you expected for that alias — a mismatch means the wrong Google account was picked in the browser, and the fix is re-running auth for that alias.

- [ ] **Step 5: Repoint the Codex config**

`~/.codex/config.toml` currently points `[mcp_servers.gmail_multi]` at `/Users/<user>/Projects/gmail-mcp/dist/server.js`, which no longer exists — the project moved under `_arch/`. Get the correct block:

```bash
npm run setup -- --print-config
```

Replace the existing `[mcp_servers.gmail_multi]` block in `~/.codex/config.toml` with the printed Codex block. Do not add a second block.

- [ ] **Step 6: Verify the Codex path resolves**

Run: `node -e "const t=require('fs').readFileSync(process.env.HOME+'/.codex/config.toml','utf8'); const m=t.match(/args = \[\"([^\"]+)\"\]/); console.log(m[1], require('fs').existsSync(m[1]) ? 'EXISTS' : 'MISSING')"`
Expected: prints the server path followed by `EXISTS`. `MISSING` means Step 5 was not applied correctly.

- [ ] **Step 7: Confirm the Claude Code registration**

Run: `claude mcp list`
Expected: `gmail-multi` is listed and points at `/Users/<user>/Projects/_arch/gmail-mcp/dist/server.js`. If the path is wrong, re-add it with the command printed in Step 5.

- [ ] **Step 8: Restart the MCP clients**

Restart Claude Code and Codex so they rediscover the server with the new tool shapes.

- [ ] **Step 9: End-to-end check through a client**

In an MCP client, call `gmail_list_accounts`.
Expected: every alias appears with `authorized: true`, its captured `email`, and its `label` where one was set.

Then, for each account, run a real search:

```text
Use gmail_search with account work and query "newer_than:7d" and maxResults 3.
```

Expected: real messages come back for every account. This is the proof that the whole chain works.

- [ ] **Step 10: Record the outcome**

No commit — nothing in the repository changed. Report to the operator which accounts are live and their resolved addresses, and flag any that still fail.

---

### Task 10: Transfer the repository to the org

**Files:** none in the working tree. This task changes GitHub state.

**Interfaces:**
- Consumes: the metadata from Task 6.
- Produces: the repository at its final home.

**This task is outward-facing and effectively irreversible. Do not run any step here without explicit confirmation from the operator in the current session.** Run it only after Tasks 1-9 are complete and verified.

- [ ] **Step 1: Confirm all work is merged and pushed**

Run: `git status -sb && git log --oneline -1 origin/main`
Expected: a clean working tree, and `origin/main` containing the completed work. Do not transfer with unmerged work outstanding.

- [ ] **Step 2: Ask the operator to confirm the transfer**

State plainly: this transfers `<old-owner>/gmail-mcp` to `zerostorypoints/gmail-mcp`, moving all commits, issues, and stars, and leaving a redirect at the old URL. Wait for an explicit yes. Do not proceed on inference.

- [ ] **Step 3: Transfer the repository**

```bash
gh api -X POST repos/<old-owner>/gmail-mcp/transfer -f new_owner=zerostorypoints
```

Expected: HTTP 202 with the repository JSON.

- [ ] **Step 4: Verify the transfer landed**

Run: `gh api repos/zerostorypoints/gmail-mcp --jq '{full_name, visibility, license: .license.spdx_id}'`
Expected: `zerostorypoints/gmail-mcp`, `public`, `Apache-2.0`. The license field proves GitHub detected `LICENSE` from Task 6.

- [ ] **Step 5: Set the description and topics**

```bash
gh api -X PATCH repos/zerostorypoints/gmail-mcp \
  -f description='Local MCP server for using multiple Gmail accounts side by side, with per-account OAuth and no send or delete tools.'

gh api -X PUT repos/zerostorypoints/gmail-mcp/topics \
  -f 'names[]=mcp' -f 'names[]=model-context-protocol' -f 'names[]=gmail' \
  -f 'names[]=claude' -f 'names[]=claude-code' -f 'names[]=typescript'
```

Expected: both return the updated JSON.

- [ ] **Step 6: Update the local git remote**

```bash
git remote set-url origin git@github.com:zerostorypoints/gmail-mcp.git
git remote -v
```

Expected: both fetch and push lines show `zerostorypoints/gmail-mcp`.

- [ ] **Step 7: Verify the remote still works**

Run: `git fetch origin && git status -sb`
Expected: the fetch succeeds against the new URL and the branch tracks normally.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: module boundaries and config format to Task 1; the OAuth extraction and email capture to Task 2; error translation and `gmail_list_accounts` to Task 3; doctor to Task 4; the wizard, TTY handling, and browser step to Task 5; hygiene, license, `SECURITY.md`, and CI to Task 6; the documentation split and the 7-day expiry treatment to Task 7; the agent-native skill to Task 8; local setup to Task 9; the repo transfer to Task 10. The dependency fix lands in Task 2 Step 1. The spec's four risks are each addressed: the transfer is gated behind explicit confirmation (Task 10 Step 2), the `gmail_list_accounts` shape change is documented in Task 7, typo'd aliases produce the loud `Added new account alias` line (Task 2 Step 2), and the wizard's untestable browser leg is covered by unit tests on `parseSetupArgs` plus manual verification in Task 9.

**Placeholder scan.** No TBD or TODO markers. Every code step carries complete code. The prose documentation steps in Task 7 specify required sections and the exact technical facts each must state rather than reproducing several hundred lines of finished prose — the constraints, commands, and links are all pinned, which is what an implementer needs.

**Type consistency.** `AccountConfig` gains optional `label` and `email` in Task 1 and is consumed with those fields in Tasks 3 and 4. `ensureAccount` returns `{ config, created }` in Task 1 and is destructured that way in Task 2. `runDoctor` returns `{ ok, lines }` in Task 4 and is consumed as `report.lines.join("\n")` in Task 5. `describeAccountError(account, error)` keeps that argument order in Tasks 3, 4, and 5. `authorizeAccount(alias, { label, openBrowser })` is called with that shape from both `src/auth.ts` and `src/setup.ts`.

**One deviation flagged for the operator.** The spec fixes the CI matrix at Node 20 and 22, and this plan follows it. Node 20 reached end of life in April 2026, so testing against it is a compatibility guarantee for the declared `engines` floor rather than a supported-runtime claim. Raising the floor to 22 would be a reasonable separate decision.
