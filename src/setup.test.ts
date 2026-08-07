import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSetupArgs, printClientConfig } from "./setup.js";

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

test("parseSetupArgs does not swallow the next flag as an account value", () => {
  const args = parseSetupArgs(["--account", "--label", "x"]);
  assert.equal(args.account, undefined);
  assert.equal(args.label, "x");
});

test("printClientConfig quotes a project path containing a space", () => {
  const root = "/tmp/My Projects/octomail-mcp";
  const accountsFile = "/tmp/My Projects/octomail-mcp/accounts.json";
  const originalAccountsFile = process.env.OCTOMAIL_ACCOUNTS_FILE;
  process.env.OCTOMAIL_ACCOUNTS_FILE = accountsFile;

  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  };

  try {
    printClientConfig(root);
  } finally {
    console.log = originalLog;
    if (originalAccountsFile === undefined) {
      delete process.env.OCTOMAIL_ACCOUNTS_FILE;
    } else {
      process.env.OCTOMAIL_ACCOUNTS_FILE = originalAccountsFile;
    }
  }

  const output = printed.join("\n");
  const serverPath = `${root}/dist/server.js`;

  // Claude Code block: both the accounts file and the server path are quoted.
  assert.match(
    output,
    new RegExp(
      `claude mcp add octomail --env OCTOMAIL_ACCOUNTS_FILE="${accountsFile.replace(/[/.]/g, "\\$&")}" -- node "${serverPath.replace(/[/.]/g, "\\$&")}"`,
    ),
  );

  // Claude Desktop block: JSON.stringify already quotes correctly.
  assert.match(output, /"args":\s*\[\s*"\/tmp\/My Projects\/octomail-mcp\/dist\/server\.js"\s*\]/);
  assert.match(
    output,
    /"env":\s*\{\s*"OCTOMAIL_ACCOUNTS_FILE":\s*"\/tmp\/My Projects\/octomail-mcp\/accounts\.json"\s*\}/,
  );

  // Codex TOML block: values go through JSON.stringify, which is valid TOML basic-string escaping.
  assert.match(output, /args = \["\/tmp\/My Projects\/octomail-mcp\/dist\/server\.js"\]/);
  assert.match(output, /env = \{ OCTOMAIL_ACCOUNTS_FILE = "\/tmp\/My Projects\/octomail-mcp\/accounts\.json" \}/);
});
