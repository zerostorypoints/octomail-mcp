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
