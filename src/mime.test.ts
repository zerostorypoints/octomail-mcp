import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAddressHeaderValue, encodeFilenameParameter, encodeHeaderValue } from "./mime.js";
import { buildMimeMessage, buildMimeString } from "./mime.js";

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

const plain = { to: "jan@example.pl", subject: "Hello", body: "Body text" };

test("buildMimeString produces a single-part text/plain message with no attachments", () => {
  const raw = buildMimeString(plain);
  assert.match(raw, /^To: jan@example\.pl\r\n/);
  assert.ok(raw.includes('Content-Type: text/plain; charset="UTF-8"'));
  assert.ok(!raw.includes("multipart"), "unexpected multipart for an attachment-free message");
});

test("buildMimeString base64-encodes the body rather than sending 8bit", () => {
  const raw = buildMimeString(plain);
  assert.ok(raw.includes("Content-Transfer-Encoding: base64"));
  const body = raw.split("\r\n\r\n")[1];
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Body text");
});

test("buildMimeString omits headers that were not supplied", () => {
  const raw = buildMimeString(plain);
  assert.ok(!raw.includes("Cc:"));
  assert.ok(!raw.includes("Bcc:"));
  assert.ok(!raw.includes("In-Reply-To:"));
});

test("buildMimeString includes threading headers when supplied", () => {
  const raw = buildMimeString({ ...plain, inReplyTo: "<a@b>", references: "<x@y> <a@b>" });
  assert.ok(raw.includes("In-Reply-To: <a@b>"));
  assert.ok(raw.includes("References: <x@y> <a@b>"));
});

test("buildMimeString encodes a Polish subject as an encoded-word", () => {
  const raw = buildMimeString({ ...plain, subject: "Faktura za wrzesień" });
  assert.ok(raw.includes("Subject: =?UTF-8?B?"), "subject was not encoded");
  assert.ok(!raw.includes("wrzesień"), "raw UTF-8 leaked into the header");
});

const withAttachment = {
  ...plain,
  attachments: [
    { filename: "faktura_wrzesień.pdf", mimeType: "application/pdf", content: Buffer.from("PDFDATA") },
  ],
};

test("buildMimeString switches to multipart/mixed when attachments are present", () => {
  const raw = buildMimeString(withAttachment, () => "deadbeef");
  assert.ok(raw.includes('Content-Type: multipart/mixed; boundary="----octomail-deadbeef"'));
});

test("buildMimeString closes the multipart with a terminating boundary", () => {
  const raw = buildMimeString(withAttachment, () => "deadbeef");
  assert.ok(raw.endsWith("\r\n------octomail-deadbeef--"), `bad terminator: ${JSON.stringify(raw.slice(-40))}`);
});

test("buildMimeString marks the attachment part with disposition and RFC 2231 filename", () => {
  const raw = buildMimeString(withAttachment, () => "deadbeef");
  assert.ok(raw.includes("Content-Disposition: attachment; filename*=UTF-8''"));
  assert.ok(raw.includes("Content-Type: application/pdf"));
});

test("buildMimeString base64-encodes attachment content", () => {
  const raw = buildMimeString(withAttachment, () => "deadbeef");
  assert.ok(raw.includes(Buffer.from("PDFDATA").toString("base64")));
});

test("buildMimeString wraps base64 payloads at 76 characters", () => {
  const raw = buildMimeString({
    ...plain,
    attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", content: Buffer.alloc(5000, 7) }],
  }, () => "deadbeef");
  for (const line of raw.split("\r\n")) {
    assert.ok(line.length <= 76, `line of ${line.length} characters exceeds 76`);
  }
});

test("buildMimeString refuses a boundary that collides with message content", () => {
  assert.throws(
    () => buildMimeString({ ...plain, body: "----octomail-collide", attachments: withAttachment.attachments }, () => "collide"),
    /boundary/i,
  );
});

test("buildMimeMessage returns base64url that decodes back to the raw message", () => {
  const encoded = buildMimeMessage(plain);
  assert.ok(!encoded.includes("+") && !encoded.includes("/"), "not base64url");
  assert.equal(Buffer.from(encoded, "base64url").toString("utf8"), buildMimeString(plain));
});

test("buildMimeMessage refuses a message over the 5 MB Gmail simple-upload limit", () => {
  assert.throws(
    () =>
      buildMimeMessage({
        ...plain,
        attachments: [{ filename: "huge.bin", mimeType: "application/octet-stream", content: Buffer.alloc(5 * 1024 * 1024) }],
      }),
    /resumable/i,
  );
});

test("buildMimeMessage accepts a message just under the limit", () => {
  const content = Buffer.alloc(3 * 1024 * 1024);
  assert.doesNotThrow(() =>
    buildMimeMessage({ ...plain, attachments: [{ filename: "ok.bin", mimeType: "application/octet-stream", content }] }),
  );
});
