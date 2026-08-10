import { randomBytes } from "node:crypto";

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const LINE_BREAK = /[\r\n]/;

// An RFC 2047 encoded-word may not exceed 75 characters including delimiters.
// "=?UTF-8?B?" + "?=" costs 12, and base64 expands 3 bytes to 4 characters,
// so 45 source bytes yields 60 characters and a 72-character word.
const MAX_ENCODED_WORD_PAYLOAD_BYTES = 45;

// A CR or LF inside a header value would let the caller inject arbitrary
// headers (or body content) into the assembled MIME message, so it is
// rejected outright rather than encoded or stripped.
function assertNoLineBreak(value: string): void {
  if (LINE_BREAK.test(value)) {
    throw new Error(
      "Header value contains a line break, which would inject headers into the message. Nothing was built.",
    );
  }
}

function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function encodeHeaderValue(value: string): string {
  assertNoLineBreak(value);

  if (ASCII_PRINTABLE.test(value)) {
    return value;
  }

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  // Iterating the string yields whole code points, so a multi-byte character
  // is never split across two encoded-words.
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (currentBytes + size > MAX_ENCODED_WORD_PAYLOAD_BYTES) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += size;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.map(encodedWord).join("\r\n ");
}

// Encoded-words are permitted in display names but not inside an addr-spec, so
// only the segments outside angle brackets are encoded.
export function encodeAddressHeaderValue(value: string): string {
  assertNoLineBreak(value);

  if (ASCII_PRINTABLE.test(value)) {
    return value;
  }

  return value
    .split(/(<[^>]*>)/)
    .map((segment) => {
      if (segment.startsWith("<")) {
        // RFC 2047 forbids encoded-words inside an addr-spec, so a
        // non-ASCII bracketed segment cannot be encoded — it can only be
        // rejected. Trusting it verbatim (the previous behaviour) let raw
        // non-ASCII bytes reach the header unencoded.
        if (!ASCII_PRINTABLE.test(segment)) {
          throw new Error(
            "Address must be ASCII; internationalized domains must be supplied in punycode.",
          );
        }
        return segment;
      }

      if (!segment.trim()) {
        return segment;
      }

      const leading = /^\s*/.exec(segment)?.[0] ?? "";
      const trailing = /\s*$/.exec(segment)?.[0] ?? "";
      return `${leading}${encodeHeaderValue(segment.trim())}${trailing}`;
    })
    .join("");
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function encodeFilenameParameter(filename: string): string {
  if (ASCII_PRINTABLE.test(filename) && !/["\\]/.test(filename)) {
    return `filename="${filename}"`;
  }

  return `filename*=UTF-8''${encodeRfc5987(filename)}`;
}

export type OutboundAttachment = {
  filename: string;
  mimeType: string;
  content: Buffer;
};

export type MimeMessageInput = {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutboundAttachment[];
};

// Gmail's simple upload path caps at 5 MB. Beyond it a resumable upload is
// required, which this server does not implement.
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join("\r\n");
}

export function buildMimeString(input: MimeMessageInput, randomHex: () => string = () => randomBytes(16).toString("hex")): string {
  if (input.inReplyTo !== undefined) {
    assertNoLineBreak(input.inReplyTo);
  }
  if (input.references !== undefined) {
    assertNoLineBreak(input.references);
  }

  const headers = [
    `To: ${encodeAddressHeaderValue(input.to)}`,
    input.cc ? `Cc: ${encodeAddressHeaderValue(input.cc)}` : undefined,
    input.bcc ? `Bcc: ${encodeAddressHeaderValue(input.bcc)}` : undefined,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : undefined,
    input.references ? `References: ${input.references}` : undefined,
    "MIME-Version: 1.0",
  ].filter((header): header is string => header !== undefined);

  const bodyBase64 = wrapBase64(Buffer.from(input.body, "utf8").toString("base64"));
  const attachments = input.attachments ?? [];

  if (!attachments.length) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      bodyBase64,
    ].join("\r\n");
  }

  for (const attachment of attachments) {
    assertNoLineBreak(attachment.mimeType);
    if (!ASCII_PRINTABLE.test(attachment.mimeType)) {
      throw new Error(`Attachment media type must be ASCII: ${JSON.stringify(attachment.mimeType)}`);
    }
  }

  const boundary = `----octomail-${randomHex()}`;
  const attachmentPayloads = attachments.map((attachment) => wrapBase64(attachment.content.toString("base64")));

  // Standard base64's alphabet excludes "-", so none of these payloads can
  // contain the boundary today. The check stays because switching any of
  // them to base64url (whose alphabet includes "-") would make a collision
  // possible, and a boundary inside a part would silently truncate the
  // message at the receiving end.
  for (const payload of [bodyBase64, ...attachmentPayloads, input.body, input.subject]) {
    if (payload.includes(boundary)) {
      throw new Error("Generated MIME boundary collides with message content; refusing to build a corrupt message.");
    }
  }

  const parts = [
    ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", bodyBase64].join("\r\n"),
    ...attachments.map((attachment, index) =>
      [
        `Content-Type: ${attachment.mimeType}`,
        `Content-Disposition: attachment; ${encodeFilenameParameter(attachment.filename)}`,
        "Content-Transfer-Encoding: base64",
        "",
        attachmentPayloads[index],
      ].join("\r\n"),
    ),
  ];

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts.map((part) => `--${boundary}\r\n${part}`),
    `--${boundary}--`,
  ].join("\r\n");
}

export function buildMimeMessage(input: MimeMessageInput, randomHex?: () => string): string {
  const raw = buildMimeString(input, randomHex);
  const size = Buffer.byteLength(raw, "utf8");

  if (size > MAX_MESSAGE_BYTES) {
    throw new Error(
      `Encoded message is ${size} bytes, over Gmail's ${MAX_MESSAGE_BYTES}-byte simple-upload limit. Sending a message this large needs resumable upload, which Octomail does not implement. Nothing was created.`,
    );
  }

  return Buffer.from(raw, "utf8").toString("base64url");
}
