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
  validateRawConfig,
} from "./config.js";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-test-"));
  process.env.OCTOMAIL_ACCOUNTS_FILE = path.join(workDir, "accounts.json");
  process.env.OCTOMAIL_TOKEN_DIR = path.join(workDir, "tokens");
});

afterEach(() => {
  delete process.env.OCTOMAIL_ACCOUNTS_FILE;
  delete process.env.OCTOMAIL_TOKEN_DIR;
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

test("defaultTokenPath honours OCTOMAIL_TOKEN_DIR", () => {
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

test("ensureAccount does not rewrite a tilde tokenPath into an absolute path when adding a label", () => {
  writeConfig({ accounts: { work: { tokenPath: "~/x.json" } } });
  ensureAccount("work", "New Label");
  const onDisk = JSON.parse(fs.readFileSync(path.join(workDir, "accounts.json"), "utf8"));
  assert.equal(onDisk.accounts.work.tokenPath, "~/x.json");
  assert.equal(onDisk.accounts.work.label, "New Label");
});

test("validateRawConfig accepts an allowedRecipients list", () => {
  const config = validateRawConfig(
    { accounts: { work: { allowedRecipients: ["@example.com", "a@b.pl"] } } },
    "test.json",
  );
  assert.deepEqual(config.accounts.work.allowedRecipients, ["@example.com", "a@b.pl"]);
});

test("validateRawConfig accepts an account with no allowedRecipients", () => {
  const config = validateRawConfig({ accounts: { work: {} } }, "test.json");
  assert.equal(config.accounts.work.allowedRecipients, undefined);
});

test("validateRawConfig rejects allowedRecipients that is not an array", () => {
  assert.throws(
    () => validateRawConfig({ accounts: { work: { allowedRecipients: "@example.com" } } }, "test.json"),
    /allowedRecipients/,
  );
});

test("validateRawConfig rejects a malformed allowlist entry", () => {
  assert.throws(
    () => validateRawConfig({ accounts: { work: { allowedRecipients: ["example.com"] } } }, "test.json"),
    /example\.com/,
  );
});

test("validateRawConfig rejects a non-ASCII allowlist entry", () => {
  assert.throws(
    () => validateRawConfig({ accounts: { work: { allowedRecipients: ["@ex\u0430mple.com"] } } }, "test.json"),
    /ASCII/i,
  );
});
