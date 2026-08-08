import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDestructiveLabelsConfirmed } from "./tools.js";

test("assertDestructiveLabelsConfirmed does not throw with no destructive label and no confirm", () => {
  assert.doesNotThrow(() => assertDestructiveLabelsConfirmed(["Receipts"], undefined, "gmail_apply_labels"));
});

test("assertDestructiveLabelsConfirmed throws for TRASH without confirm, naming TRASH", () => {
  assert.throws(() => assertDestructiveLabelsConfirmed(["TRASH"], undefined, "gmail_apply_labels"), /TRASH/);
});

test("assertDestructiveLabelsConfirmed throws for SPAM without confirm", () => {
  assert.throws(() => assertDestructiveLabelsConfirmed(["SPAM"], undefined, "gmail_apply_labels"), /SPAM/);
});

test("assertDestructiveLabelsConfirmed does not throw for TRASH with confirm: true", () => {
  assert.doesNotThrow(() => assertDestructiveLabelsConfirmed(["TRASH"], true, "gmail_apply_labels"));
});

test("assertDestructiveLabelsConfirmed throws for lowercase trash without confirm", () => {
  assert.throws(() => assertDestructiveLabelsConfirmed(["trash"], undefined, "gmail_apply_labels"), /trash/);
});

test("assertDestructiveLabelsConfirmed does not throw with an undefined add list", () => {
  assert.doesNotThrow(() => assertDestructiveLabelsConfirmed(undefined, undefined, "gmail_apply_labels"));
});
