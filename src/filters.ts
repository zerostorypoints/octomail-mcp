export type FilterCriteria = {
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  query?: string | null;
  negatedQuery?: string | null;
  hasAttachment?: boolean | null;
  excludeChats?: boolean | null;
  size?: number | null;
  sizeComparison?: string | null;
};

// Turns a stored filter's criteria into a Gmail search query so a filter's
// effect can be applied to mail that arrived before it existed. This is an
// APPROXIMATION: Gmail's search matching is not byte-identical to its filter
// matching, particularly `from:` against display names. That is why backfill
// is dry-run by default.
export function criteriaToQuery(criteria: FilterCriteria): string {
  const parts: string[] = [];

  if (criteria.from) parts.push(`from:(${criteria.from})`);
  if (criteria.to) parts.push(`to:(${criteria.to})`);
  if (criteria.subject) parts.push(`subject:(${criteria.subject})`);
  if (criteria.hasAttachment) parts.push("has:attachment");
  if (criteria.excludeChats) parts.push("-in:chats");
  // `!= null` rather than truthiness: size 0 is a legitimate stored value, and
  // dropping it turns "smaller:0b" (matches nothing) into no constraint at all.
  if (criteria.size != null && criteria.sizeComparison === "larger") parts.push(`larger:${criteria.size}b`);
  if (criteria.size != null && criteria.sizeComparison === "smaller") parts.push(`smaller:${criteria.size}b`);
  if (criteria.query) parts.push(criteria.query);
  if (criteria.negatedQuery) parts.push(`-(${criteria.negatedQuery})`);

  return parts.join(" ");
}

// Gmail allows at most one user-defined label per filter, counted across the
// add and remove actions together. System labels are unrestricted.
export function assertSingleUserLabel(labels: Array<{ name?: string | null; type?: string | null }>): void {
  const userLabels = labels.filter((label) => label.type !== "system").map((label) => label.name ?? "(unnamed)");

  if (userLabels.length > 1) {
    throw new Error(
      `Gmail allows at most one user-defined label per filter, across add and remove combined. Got ${userLabels.length}: ${userLabels.join(", ")}.`,
    );
  }
}
