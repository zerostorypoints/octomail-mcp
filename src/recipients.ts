// Deliberately broad: anything with an @ and no structural delimiters counts
// as an address token. This is not an RFC 5322 parser and must not become one.
//
// The direction of error matters. A parser that guesses wrong extracts the
// WRONG address and can approve a send that should have been refused. An
// over-extractor that guesses wrong extracts EXTRA addresses and can only
// refuse a send that should have been allowed. For a deny-based gate,
// over-extraction is the safe failure.
//
// The exclusion set below must be kept as small as possible, and every
// character in it must be justified individually. Both `+`-quantified runs
// sit directly against the literal `@`. Any character excluded from the
// character classes therefore cannot appear immediately next to the `@` —
// and if it does appear there in the input (e.g. a quoted local part like
// "evil"@attacker.com, or a stray apostrophe/brace glued to the address),
// the regex simply fails to match that `@` at all. The address is not
// mis-extracted, it is not extracted, so it never reaches the allowlist
// check and is silently allowed through. That is under-extraction, and for
// a deny-based gate it is the UNSAFE failure — the opposite of the
// over-extraction above. So this set holds only genuine address-list
// separators: whitespace and the list/route syntax characters `<`, `>`,
// `,`, `;`. Everything else (including `"`, `(`, `)`, `[`, `]`, `\`, `:`,
// and `'`) stays inside the token: a character left inside the token can
// only ever make the token fail to match an allowlist entry, which refuses
// the send — always the safe direction.
const ADDRESS_TOKEN = /[^\s<>,;]+@[^\s<>,;]+/gu;

const ASCII_ONLY = /^[\x21-\x7e]+$/;

// RFC 5322 permits CFWS (comments and whitespace) around the `@` inside an
// addr-spec, so `evil @attacker.com` and `evil@ attacker.com` are both legal
// spellings of `evil@attacker.com`. ADDRESS_TOKEN's two runs sit directly
// against the literal `@`, so whitespace there is exactly the adjacency
// problem described above: the tokenizer would fail to match that `@` at
// all. Collapsing `\s*@\s*` first turns those forms into the ordinary
// adjacency the tokenizer already handles, without touching the whitespace
// that genuinely separates one recipient from the next in a header value.
const normalizeAtSpacing = (value: string): string => value.replace(/\s*@\s*/gu, "@");

export function extractAddresses(...headerValues: (string | null | undefined)[]): string[] {
  const found = new Set<string>();

  for (const value of headerValues) {
    if (!value) {
      continue;
    }

    const normalized = normalizeAtSpacing(value);
    const spans: Array<[number, number]> = [];

    for (const match of normalized.matchAll(ADDRESS_TOKEN)) {
      const start = match.index!;
      spans.push([start, start + match[0].length]);

      // Sentence-final punctuation ("Reach me at alice@example.com.") can attach
      // to the token, so a trailing dot is trimmed as a deliberate accommodation.
      // ADDRESS_TOKEN now excludes only whitespace and `<>,;`, so other trailing
      // punctuation (a stray `"`, `'`, `:`, brace, paren, bracket, backslash) can
      // also end up glued to a match. Those are NOT trimmed here, and that is
      // deliberate: leaving them in the token can only cause it to fail the
      // allowlist comparison below, which refuses the send — the safe outcome.
      // Trimming them would risk the opposite: turning a decorated, refusable
      // token into a bare address that matches an allowlist entry it shouldn't.
      const trimmed = match[0].replace(/\.+$/, "");
      if (trimmed) {
        found.add(trimmed);
      }
    }

    // Every `@` in the normalised value must fall inside some matched span.
    // This is the invariant that actually closes the bypass class, not just
    // this one instance of it: the whitespace case above is just today's way
    // of gluing an excluded character against the `@`. Any future change to
    // the exclusion set, an exotic delimiter we haven't thought of, a second
    // `@` in a weird position — anything that produces an adjacency the
    // tokenizer can't claim — hits this check instead of silently vanishing.
    // An address the tokenizer cannot see is exactly the unsafe failure this
    // module exists to prevent, so there is no safe way to keep going:
    // refuse the whole value rather than return a partial, possibly-wrong
    // recipient list built on top of it.
    for (let i = 0; i < normalized.length; i++) {
      if (normalized[i] !== "@") {
        continue;
      }
      if (!spans.some(([start, end]) => i >= start && i < end)) {
        throw new Error(
          `recipient list could not be parsed safely, an "@" is outside every extracted address in: ${JSON.stringify(value)} — nothing was sent`,
        );
      }
    }
  }

  return [...found];
}

export type RecipientVerdict = {
  address: string;
  allowed: boolean;
  reason?: string;
};

// Returns one verdict per input address, in order — an empty `addresses` array
// yields an empty array of verdicts. Callers must check
// `verdicts.length > 0 && verdicts.every(...)`: a bare `.every(...)` on an
// empty array is vacuously true and would read "no recipients found" as "all allowed".
export function checkRecipients(addresses: string[], allowlist: string[] | undefined): RecipientVerdict[] {
  if (!allowlist?.length) {
    return addresses.map((address) => ({
      address,
      allowed: false,
      reason: "no allowedRecipients configured for this account, so sending is disabled",
    }));
  }

  const entries = new Set(allowlist.map((entry) => entry.toLowerCase()));

  return addresses.map((address) => {
    // A domain that looks identical to an allowlisted one but uses non-ASCII
    // code points is refused outright rather than normalised. Normalisation
    // invites an equivalence bug; refusal cannot be wrong in the unsafe
    // direction.
    if (!ASCII_ONLY.test(address)) {
      return {
        address,
        allowed: false,
        reason: "address contains non-ASCII characters and may be a homograph of an allowlisted domain",
      };
    }

    const lower = address.toLowerCase();
    const at = lower.lastIndexOf("@");
    const domain = at === -1 ? "" : lower.slice(at + 1);

    if (!domain) {
      return { address, allowed: false, reason: "address has no domain" };
    }

    if (entries.has(lower) || entries.has(`@${domain}`)) {
      return { address, allowed: true };
    }

    return { address, allowed: false, reason: "not on allowedRecipients" };
  });
}
