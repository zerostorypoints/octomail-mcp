import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import ICAL from "ical.js";
import { z } from "zod";
import { getFeedConfig, listFeedAliases } from "./config.js";
import { safeTool } from "./tools.js";

// A subscribed iCal feed is a file served over HTTP. There is no write verb in
// the format, so everything here reads: nothing in this module can change a
// remote calendar, and no amount of tooling on top of it could.

// webcal:// is the click-to-subscribe scheme calendar apps register; on the
// wire it is plain HTTPS. Rewriting it here means a URL copied out of a
// "Subscribe" button works as pasted.
export function feedFetchUrl(url: string): string {
  const trimmed = url.trim();
  const normalized = /^webcal:\/\//i.test(trimmed) ? trimmed.replace(/^webcal:\/\//i, "https://") : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Feed URL is not a URL: ${JSON.stringify(url)}`);
  }

  // Feed URLs are bearer secrets — anyone holding the link reads the calendar.
  // Over http they travel in clear, so plain http is refused rather than
  // silently downgraded to a working-but-leaking fetch.
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Feed URL must be https (or webcal, which is https on the wire); got ${parsed.protocol.replace(":", "")}. A calendar feed URL is a secret and must not travel unencrypted.`,
    );
  }

  return parsed.toString();
}

// 20 MB of iCalendar is far past any real subscription — a year of a busy
// calendar is tens of kilobytes. The cap is here so a wrong URL pointing at
// something large cannot exhaust memory in a server the user cannot see.
export const MAX_FEED_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export async function fetchFeed(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(feedFetchUrl(url), {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.5" },
  });

  if (!response.ok) {
    throw new Error(
      `Feed returned HTTP ${response.status}. A private feed URL that used to work usually means the link was rotated by the calendar's owner.`,
    );
  }

  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
    throw new Error(`Feed is ${declared} bytes, over the ${MAX_FEED_BYTES}-byte cap. Nothing was read.`);
  }

  const body = await response.text();
  // Content-Length is a claim, not a guarantee, and a chunked response omits
  // it — so the real size is checked once the body is in hand as well.
  if (body.length > MAX_FEED_BYTES) {
    throw new Error(`Feed body is ${body.length} bytes, over the ${MAX_FEED_BYTES}-byte cap. Nothing was read.`);
  }

  return body;
}

export type FeedEvent = {
  uid?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: string;
  end?: string;
  allDay: boolean;
  status?: string;
  organizer?: string;
  // True when this entry is one occurrence generated from a recurrence rule
  // rather than a standalone VEVENT. Worth surfacing: rescheduling "that
  // Tuesday" in the source calendar moves one occurrence, not the series.
  fromRecurrence?: boolean;
};

// Unlike calendar_list_events, which drops descriptions as conference-detail
// ballast, feed events keep a trimmed one. A subscribed feed is usually the
// only view of that calendar, and in practice its description carries the
// payload — the room, the order number, the match — not a dial-in block.
const MAX_DESCRIPTION = 500;

function trimDescription(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const collapsed = value.trim();
  return collapsed.length > MAX_DESCRIPTION ? `${collapsed.slice(0, MAX_DESCRIPTION)}…` : collapsed;
}

// An unbounded rule (FREQ=DAILY with no UNTIL or COUNT) iterates forever, and
// a window far in the future would walk to it one step at a time. The cap
// bounds the walk per event; it is not a limit on results.
const MAX_OCCURRENCE_STEPS = 5000;

function toIso(time: ICAL.Time | null | undefined): string | undefined {
  return time ? time.toJSDate().toISOString() : undefined;
}

export type FeedWindow = { from: Date; to: Date };

// Overlap, not containment: an event that started before the window and is
// still running during it is exactly what "what is on today" has to return.
function overlaps(start: Date | undefined, end: Date | undefined, window: FeedWindow): boolean {
  const from = start ?? end;
  const to = end ?? start;
  if (!from || !to) {
    return false;
  }
  return from < window.to && to > window.from;
}

export function parseFeed(ics: string, window: FeedWindow, maxResults = 100): FeedEvent[] {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch (error) {
    throw new Error(
      `That feed is not parseable iCalendar (${error instanceof Error ? error.message : String(error)}). A URL that returns an HTML sign-in page instead of a .ics file fails exactly this way.`,
    );
  }

  const found: FeedEvent[] = [];

  for (const component of root.getAllSubcomponents("vevent")) {
    const event = new ICAL.Event(component);

    // Overrides ("this one Tuesday moved") are separate VEVENTs carrying a
    // RECURRENCE-ID. ICAL.Event applies them while expanding the series it
    // belongs to, so emitting them again here would double-count.
    if (event.isRecurrenceException()) {
      continue;
    }

    const base: Omit<FeedEvent, "start" | "end" | "allDay"> = {
      uid: event.uid ?? undefined,
      summary: event.summary ?? undefined,
      location: event.location ?? undefined,
      description: trimDescription(event.description),
      status: component.getFirstPropertyValue("status")?.toString() ?? undefined,
      organizer: event.organizer ?? undefined,
    };

    if (!event.isRecurring()) {
      const start = event.startDate?.toJSDate();
      const end = event.endDate?.toJSDate();
      if (overlaps(start, end, window)) {
        found.push({
          ...base,
          start: toIso(event.startDate),
          end: toIso(event.endDate),
          allDay: event.startDate?.isDate === true,
        });
      }
      continue;
    }

    const iterator = event.iterator();
    for (let step = 0; step < MAX_OCCURRENCE_STEPS; step++) {
      const next = iterator.next();
      if (!next) {
        break;
      }
      if (next.toJSDate() >= window.to) {
        break;
      }

      const details = event.getOccurrenceDetails(next);
      const start = details.startDate?.toJSDate();
      const end = details.endDate?.toJSDate();
      if (!overlaps(start, end, window)) {
        continue;
      }

      found.push({
        ...base,
        summary: details.item.summary ?? base.summary,
        location: details.item.location ?? base.location,
        description: trimDescription(details.item.description) ?? base.description,
        start: toIso(details.startDate),
        end: toIso(details.endDate),
        allDay: details.startDate?.isDate === true,
        fromRecurrence: true,
      });

      if (found.length >= maxResults * 4) {
        // Enough to sort and cut below without walking a decade of a daily rule.
        break;
      }
    }
  }

  return found
    .sort((left, right) => (left.start ?? "").localeCompare(right.start ?? ""))
    .slice(0, maxResults);
}

function parseWindow(timeMin: string, timeMax: string): FeedWindow {
  const from = new Date(timeMin);
  const to = new Date(timeMax);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("timeMin and timeMax must be RFC3339 timestamps, e.g. 2026-08-17T00:00:00Z.");
  }
  if (to <= from) {
    throw new Error("timeMax must be after timeMin.");
  }
  return { from, to };
}

export function registerIcalTools(server: McpServer): void {
  server.tool(
    "ical_list_feeds",
    "List the subscribed iCal feeds configured in accounts.json under \"calendarFeeds\". Feeds are read-only by nature: an .ics subscription is a file served over HTTP and has no write protocol.",
    {},
    async () =>
      safeTool(async () =>
        listFeedAliases().map((alias) => {
          const feed = getFeedConfig(alias);
          return {
            feed: alias,
            label: feed.label,
            // The URL itself is withheld: a feed link is a bearer secret for
            // the whole calendar, and it would otherwise land in transcripts.
            host: new URL(feedFetchUrl(feed.url)).host,
          };
        }),
      ),
  );

  server.tool(
    "ical_list_events",
    "Read events from one subscribed iCal feed within a time range. Recurring rules are expanded into individual occurrences, and overrides of single occurrences are applied. Read-only: an .ics feed cannot be written to. Takes a feed alias from accounts.json, never a URL — so nothing read from a page or a message can make this server fetch an arbitrary host.",
    {
      feed: z.string().min(1).describe('Feed alias from accounts.json, as listed by ical_list_feeds.'),
      timeMin: z.string().min(1).describe("RFC3339 lower bound, e.g. 2026-08-17T00:00:00Z."),
      timeMax: z.string().min(1).describe("RFC3339 upper bound, e.g. 2026-08-24T00:00:00Z."),
      maxResults: z.number().int().min(1).max(500).optional().describe("Defaults to 100."),
    },
    async ({ feed, timeMin, timeMax, maxResults }) =>
      safeTool(async () => {
        const window = parseWindow(timeMin, timeMax);
        const config = getFeedConfig(feed);
        const ics = await fetchFeed(config.url);
        return {
          feed,
          label: config.label,
          events: parseFeed(ics, window, maxResults ?? 100),
        };
      }),
  );
}
