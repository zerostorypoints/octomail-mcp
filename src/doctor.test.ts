import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAccounts } from "./doctor.js";
import type { gmailForAccount } from "./gmail.js";

let workDir: string;

function setup(): void {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-doctor-test-"));
  process.env.OCTOMAIL_ACCOUNTS_FILE = path.join(workDir, "accounts.json");
  process.env.OCTOMAIL_TOKEN_DIR = path.join(workDir, "tokens");
}

function teardown(): void {
  delete process.env.OCTOMAIL_ACCOUNTS_FILE;
  delete process.env.OCTOMAIL_TOKEN_DIR;
  fs.rmSync(workDir, { recursive: true, force: true });
}

test("checkAccounts reports an unauthorized account and fails overall", async () => {
  setup();
  try {
    fs.writeFileSync(process.env.OCTOMAIL_ACCOUNTS_FILE as string, JSON.stringify({ accounts: { work: {} } }));

    const result = await checkAccounts();

    assert.equal(result.ok, false);
    const line = result.lines.find((entry) => entry.startsWith("✗ work"));
    assert.ok(line, `expected a "✗ work" line, got: ${JSON.stringify(result.lines)}`);
    assert.match(line as string, /run: npm run auth -- --account work/);
  } finally {
    teardown();
  }
});

test("checkAccounts warns on a loose token file mode without failing overall", async () => {
  setup();
  try {
    fs.writeFileSync(process.env.OCTOMAIL_ACCOUNTS_FILE as string, JSON.stringify({ accounts: { work: {} } }));

    const tokenPath = path.join(workDir, "tokens", "work.json");
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: "r" }));
    fs.chmodSync(tokenPath, 0o644);

    const fakeGmailClient: typeof gmailForAccount = (async () =>
      ({
        users: {
          getProfile: async () => ({ data: { emailAddress: "work@example.com" } }),
        },
      }) as unknown as Awaited<ReturnType<typeof gmailForAccount>>) as typeof gmailForAccount;

    const result = await checkAccounts(fakeGmailClient);

    const warningLine = result.lines.find((entry) => entry.startsWith("!"));
    assert.ok(warningLine, `expected a "!" line, got: ${JSON.stringify(result.lines)}`);
    assert.match(warningLine as string, /expected 600/);
    // The loose-mode warning alone must not fail the overall report — only a
    // real authorization/lookup failure should.
    assert.equal(result.ok, true);
  } finally {
    teardown();
  }
});

test("checkAccounts warns when the token predates the filter scope", async () => {
  setup();
  try {
    fs.writeFileSync(process.env.OCTOMAIL_ACCOUNTS_FILE as string, JSON.stringify({ accounts: { work: {} } }));

    const tokenPath = path.join(workDir, "tokens", "work.json");
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(
      tokenPath,
      JSON.stringify({ refresh_token: "r", scope: "https://www.googleapis.com/auth/gmail.modify" }),
    );
    fs.chmodSync(tokenPath, 0o600);

    const fakeGmailClient: typeof gmailForAccount = (async () =>
      ({
        users: { getProfile: async () => ({ data: { emailAddress: "work@example.com" } }) },
      }) as unknown as Awaited<ReturnType<typeof gmailForAccount>>) as typeof gmailForAccount;

    const result = await checkAccounts(fakeGmailClient);

    const warningLine = result.lines.find((entry) => entry.startsWith("!") && /filter/i.test(entry));
    assert.ok(warningLine, `expected a filter-scope "!" line, got: ${JSON.stringify(result.lines)}`);
    assert.match(warningLine as string, /npm run auth -- --account work/);
    // A missing optional scope is a warning, not a failure.
    assert.equal(result.ok, true);
  } finally {
    teardown();
  }
});

test("checkAccounts does not warn when the token already has the filter scope", async () => {
  setup();
  try {
    fs.writeFileSync(process.env.OCTOMAIL_ACCOUNTS_FILE as string, JSON.stringify({ accounts: { work: {} } }));

    const tokenPath = path.join(workDir, "tokens", "work.json");
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(
      tokenPath,
      JSON.stringify({
        refresh_token: "r",
        scope:
          "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.settings.basic",
      }),
    );
    fs.chmodSync(tokenPath, 0o600);

    const fakeGmailClient: typeof gmailForAccount = (async () =>
      ({
        users: { getProfile: async () => ({ data: { emailAddress: "work@example.com" } }) },
      }) as unknown as Awaited<ReturnType<typeof gmailForAccount>>) as typeof gmailForAccount;

    const result = await checkAccounts(fakeGmailClient);

    const filterLine = result.lines.find((entry) => /filter/i.test(entry));
    assert.equal(filterLine, undefined, `expected no filter-scope line, got: ${JSON.stringify(result.lines)}`);
    assert.equal(result.ok, true);
  } finally {
    teardown();
  }
});
