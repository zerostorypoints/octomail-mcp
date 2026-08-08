import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL_COLORS, assertValidLabelColors, descendantsOf, renameDescendant } from "./labels.js";

test("every palette entry is a lowercase 7-character hex string", () => {
  for (const color of LABEL_COLORS) {
    assert.match(color, /^#[0-9a-f]{6}$/, `${color} is not lowercase #rrggbb`);
  }
});

test("assertValidLabelColors accepts a palette pair", () => {
  assert.doesNotThrow(() => assertValidLabelColors("#ffffff", "#fb4c2f"));
});

test("assertValidLabelColors accepts neither colour", () => {
  assert.doesNotThrow(() => assertValidLabelColors(undefined, undefined));
});

test("assertValidLabelColors rejects a colour outside the palette", () => {
  assert.throws(() => assertValidLabelColors("#123456", "#fb4c2f"), /#123456/);
});

test("assertValidLabelColors rejects uppercase hex, which Gmail does not accept", () => {
  assert.throws(() => assertValidLabelColors("#FFFFFF", "#fb4c2f"), /#FFFFFF/);
});

test("assertValidLabelColors rejects one colour without the other", () => {
  assert.throws(() => assertValidLabelColors("#ffffff", undefined), /both/i);
  assert.throws(() => assertValidLabelColors(undefined, "#ffffff"), /both/i);
});

test("descendantsOf matches path children but not name prefixes", () => {
  const all = ["Clients", "Clients/Acme", "Clients/Acme/Q1", "Clients2", "ClientsArchive", "Other"];
  assert.deepEqual(descendantsOf("Clients", all), ["Clients/Acme", "Clients/Acme/Q1"]);
});

test("descendantsOf excludes the parent itself", () => {
  assert.deepEqual(descendantsOf("Clients", ["Clients"]), []);
});

test("descendantsOf returns empty for a leaf label", () => {
  assert.deepEqual(descendantsOf("Receipts", ["Clients/Acme", "Receipts"]), []);
});

test("renameDescendant rewrites only the parent prefix", () => {
  assert.equal(renameDescendant("Clients", "Work/Clients", "Clients/Acme"), "Work/Clients/Acme");
  assert.equal(renameDescendant("Clients", "Work/Clients", "Clients/Acme/Q1"), "Work/Clients/Acme/Q1");
});
