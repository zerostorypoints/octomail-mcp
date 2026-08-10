import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAddressHeaderValue, encodeFilenameParameter, encodeHeaderValue } from "./mime.js";

test("encodeHeaderValue leaves a plain ASCII value untouched", () => {
  assert.equal(encodeHeaderValue("Invoice for August"), "Invoice for August");
});

test("encodeHeaderValue emits an RFC 2047 encoded-word for Polish text", () => {
  const encoded = encodeHeaderValue("Faktura za wrzesień");
  assert.match(encoded, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  const payload = encoded.slice("=?UTF-8?B?".length, -"?=".length);
  assert.equal(Buffer.from(payload, "base64").toString("utf8"), "Faktura za wrzesień");
});

test("encodeHeaderValue splits long values into encoded-words under the 75-character limit", () => {
  const encoded = encodeHeaderValue("ą".repeat(120));
  const words = encoded.split("\r\n ");
  assert.ok(words.length > 1, "expected more than one encoded-word");
  for (const word of words) {
    assert.ok(word.length <= 75, `encoded-word is ${word.length} characters: ${word}`);
  }
});

test("encodeHeaderValue never splits a multi-byte character across encoded-words", () => {
  const encoded = encodeHeaderValue("ż".repeat(100));
  const decoded = encoded
    .split("\r\n ")
    .map((word) => Buffer.from(word.slice("=?UTF-8?B?".length, -"?=".length), "base64").toString("utf8"))
    .join("");
  assert.equal(decoded, "ż".repeat(100));
});

test("encodeAddressHeaderValue leaves a plain address alone", () => {
  assert.equal(encodeAddressHeaderValue("jan@example.pl"), "jan@example.pl");
});

test("encodeAddressHeaderValue encodes the display name but never the address", () => {
  const encoded = encodeAddressHeaderValue("Michał Kowalczyk <michal@example.pl>");
  assert.ok(encoded.includes("<michal@example.pl>"), `address was altered: ${encoded}`);
  assert.ok(encoded.startsWith("=?UTF-8?B?"), `display name was not encoded: ${encoded}`);
});

test("encodeAddressHeaderValue keeps the space between display name and address", () => {
  const encoded = encodeAddressHeaderValue("Michał Kowalczyk <michal@example.pl>");
  assert.match(encoded, /\?= <michal@example\.pl>$/);
});

test("encodeHeaderValue never splits an astral-plane (4-byte UTF-8) character across encoded-words", () => {
  const original = "😀".repeat(80);
  const encoded = encodeHeaderValue(original);
  const decoded = encoded
    .split("\r\n ")
    .map((word) => Buffer.from(word.slice("=?UTF-8?B?".length, -"?=".length), "base64").toString("utf8"))
    .join("");
  assert.equal(decoded, original);
});

test("encodeAddressHeaderValue encodes only the non-ASCII display name across multiple recipients", () => {
  const encoded = encodeAddressHeaderValue("Michał Kowalczyk <michal@example.pl>, Jan Nowak <jan@example.com>");
  assert.ok(encoded.includes("<michal@example.pl>"), `first address was altered: ${encoded}`);
  assert.ok(encoded.includes("<jan@example.com>"), `second address was altered: ${encoded}`);
  assert.ok(encoded.includes("Jan Nowak <jan@example.com>"), `ASCII display name was altered: ${encoded}`);
  assert.ok(encoded.startsWith("=?UTF-8?B?"), `non-ASCII display name was not encoded: ${encoded}`);
});

test("encodeAddressHeaderValue throws when a bracketed segment contains non-ASCII", () => {
  assert.throws(
    () => encodeAddressHeaderValue("Zespół <Sprzedaż> <zespol@example.pl>"),
    /ASCII/,
  );
});

test("encodeHeaderValue throws on a value containing a line break", () => {
  assert.throws(() => encodeHeaderValue("Invoice\r\nBcc: attacker@example.com"), /line break/);
});

test("encodeAddressHeaderValue throws on a value containing a line break", () => {
  assert.throws(
    () => encodeAddressHeaderValue("a@example.com\r\nBcc: attacker@example.com"),
    /line break/,
  );
});

test("encodeFilenameParameter quotes a plain ASCII filename", () => {
  assert.equal(encodeFilenameParameter("faktura.pdf"), 'filename="faktura.pdf"');
});

test("encodeFilenameParameter uses RFC 2231 for a non-ASCII filename", () => {
  const encoded = encodeFilenameParameter("faktura_wrzesień.pdf");
  assert.match(encoded, /^filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(encoded.slice("filename*=UTF-8''".length)), "faktura_wrzesień.pdf");
});

test("encodeFilenameParameter escapes a filename containing a quote", () => {
  const encoded = encodeFilenameParameter('in"voice.pdf');
  assert.ok(!/^filename="[^"]*"[^"]/.test(encoded), `unescaped quote broke the parameter: ${encoded}`);
});
