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
