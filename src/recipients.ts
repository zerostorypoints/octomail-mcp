// Deliberately broad: anything with an @ and no structural delimiters counts
// as an address token. This is not an RFC 5322 parser and must not become one.
//
// The direction of error matters. A parser that guesses wrong extracts the
// WRONG address and can approve a send that should have been refused. An
// over-extractor that guesses wrong extracts EXTRA addresses and can only
// refuse a send that should have been allowed. For a deny-based gate,
// over-extraction is the safe failure.
const ADDRESS_TOKEN = /[^\s<>,;:"'{}()[\]\\]+@[^\s<>,;:"'{}()[\]\\]+/gu;

const ASCII_ONLY = /^[\x21-\x7e]+$/;

export function extractAddresses(...headerValues: (string | null | undefined)[]): string[] {
  const found = new Set<string>();

  for (const value of headerValues) {
    if (!value) {
      continue;
    }

    for (const match of value.matchAll(ADDRESS_TOKEN)) {
      // Sentence-final punctuation ("Reach me at alice@example.com.") can attach
      // to the token. Every other delimiter here is already excluded from
      // ADDRESS_TOKEN itself, so only a trailing dot can ever occur.
      const trimmed = match[0].replace(/\.+$/, "");
      if (trimmed) {
        found.add(trimmed);
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
