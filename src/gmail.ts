import fs from "node:fs";
import { google, gmail_v1, calendar_v3, drive_v3, sheets_v4 } from "googleapis";
import { Credentials, OAuth2Client } from "google-auth-library";
import { getAccountConfig, loadOAuthCredentials } from "./config.js";

export const FILTER_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  FILTER_SCOPE,
] as const;

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

// Requested now so accounts need only one manual re-consent: the upcoming
// busy-block sync writes events. No write tool is registered yet — a scope
// grants nothing on its own, only a registered tool can act on it.
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// Full drive scope, not drive.file: drive.file cannot see folders the app
// did not create.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

// Scopes requested on the consent screen. Gmail scopes stay grouped in
// GMAIL_SCOPES so mail code can reason about them alone; the consent screen
// asks for everything Octomail can use.
//
// Typed as readonly string[] rather than `as const`: with a literal tuple
// type, a test asserting a scope is ABSENT ("no overlap between these types")
// fails to compile instead of failing as an assertion.
//
// calendar.events is listed alongside calendar.readonly, not instead of it:
// calendarList.list requires calendar.readonly on its own — calendar.events
// alone does not cover it — so the read tools still need both scopes.
export const AUTH_SCOPES: readonly string[] = [...GMAIL_SCOPES, CALENDAR_SCOPE, CALENDAR_EVENTS_SCOPE, DRIVE_SCOPE];

export function createOAuthClient(redirectUri = "http://127.0.0.1"): OAuth2Client {
  const credentials = loadOAuthCredentials();
  return new google.auth.OAuth2(credentials.clientId, credentials.clientSecret, redirectUri);
}

export function readAccountToken(account: string): Credentials {
  const accountConfig = getAccountConfig(account);
  if (!fs.existsSync(accountConfig.tokenPath)) {
    throw new Error(
      `Gmail account "${account}" is configured but not authorized. Run: npm run auth -- --account ${account}`,
    );
  }

  return JSON.parse(fs.readFileSync(accountConfig.tokenPath, "utf8")) as Credentials;
}

export async function gmailForAccount(account: string): Promise<gmail_v1.Gmail> {
  const token = readAccountToken(account);
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(token);
  return google.gmail({ version: "v1", auth: oauth2Client });
}

export async function calendarForAccount(account: string): Promise<calendar_v3.Calendar> {
  const token = readAccountToken(account);
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(token);
  return google.calendar({ version: "v3", auth: oauth2Client });
}

export async function driveForAccount(account: string): Promise<drive_v3.Drive> {
  const token = readAccountToken(account);
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(token);
  return google.drive({ version: "v3", auth: oauth2Client });
}

// The Sheets API accepts the Drive scope, so the same token serves it; only
// drive_export_file uses this client, for two read methods.
export async function sheetsForAccount(account: string): Promise<sheets_v4.Sheets> {
  const token = readAccountToken(account);
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(token);
  return google.sheets({ version: "v4", auth: oauth2Client });
}

export async function listLabelsByName(gmail: gmail_v1.Gmail): Promise<Map<string, string>> {
  const response = await gmail.users.labels.list({ userId: "me" });
  const labels = response.data.labels ?? [];
  const byName = new Map<string, string>();

  for (const label of labels) {
    if (label.id) {
      byName.set(label.id, label.id);
    }
    if (label.name && label.id) {
      byName.set(label.name, label.id);
    }
  }

  return byName;
}

export async function resolveLabelNames(gmail: gmail_v1.Gmail, names: string[] | undefined): Promise<string[] | undefined> {
  if (!names?.length) {
    return undefined;
  }

  const labels = await listLabelsByName(gmail);
  return names.map((name) => {
    const id = labels.get(name);
    if (!id) {
      throw new Error(`Label "${name}" does not exist on this account.`);
    }
    return id;
  });
}

export function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function collectBodies(part: gmail_v1.Schema$MessagePart | undefined, mimeType: string, bodies: string[]): void {
  if (!part) {
    return;
  }

  if (part.mimeType === mimeType && part.body?.data) {
    bodies.push(decodeBase64Url(part.body.data));
  }

  for (const child of part.parts ?? []) {
    collectBodies(child, mimeType, bodies);
  }
}

export type AttachmentMetadata = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  attachmentId: string;
  inline: boolean;
};

function partHeader(part: gmail_v1.Schema$MessagePart, name: string): string {
  return part.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// A part carrying an attachmentId is one whose bytes Gmail did not inline and
// which must be fetched separately — which is exactly the set of parts
// gmail_get_attachment can retrieve. Body parts carry body.data instead.
export function collectAttachments(
  part: gmail_v1.Schema$MessagePart | undefined,
  found: AttachmentMetadata[] = [],
): AttachmentMetadata[] {
  if (!part) {
    return found;
  }

  const attachmentId = part.body?.attachmentId;
  if (attachmentId) {
    found.push({
      filename: part.filename ?? "",
      mimeType: part.mimeType ?? "application/octet-stream",
      sizeBytes: part.body?.size ?? 0,
      attachmentId,
      inline: partHeader(part, "Content-Disposition").trim().toLowerCase().startsWith("inline"),
    });
  }

  for (const child of part.parts ?? []) {
    collectAttachments(child, found);
  }

  return found;
}

export function messageHeader(message: gmail_v1.Schema$Message, name: string): string | undefined {
  return message.payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

export function summarizeMessage(message: gmail_v1.Schema$Message) {
  const textBodies: string[] = [];
  const htmlBodies: string[] = [];
  collectBodies(message.payload, "text/plain", textBodies);
  collectBodies(message.payload, "text/html", htmlBodies);
  const attachments = collectAttachments(message.payload);

  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds,
    snippet: message.snippet,
    internalDate: message.internalDate,
    headers: {
      from: messageHeader(message, "From"),
      to: messageHeader(message, "To"),
      cc: messageHeader(message, "Cc"),
      bcc: messageHeader(message, "Bcc"),
      subject: messageHeader(message, "Subject"),
      date: messageHeader(message, "Date"),
      messageId: messageHeader(message, "Message-ID"),
      references: messageHeader(message, "References"),
      // The header that separates bulk mail from a message written to you: a
      // newsletter addressed to your own address is otherwise indistinguishable
      // from a colleague writing directly.
      listUnsubscribe: messageHeader(message, "List-Unsubscribe"),
      // Gmail's own basis for "to me": it survives Bcc and list delivery, where
      // the recipient's address appears in no visible header.
      deliveredTo: messageHeader(message, "Delivered-To"),
    },
    bodyText: textBodies.join("\n\n").trim() || undefined,
    bodyHtml: htmlBodies.join("\n\n").trim() || undefined,
    attachments: attachments.length ? attachments : undefined,
  };
}

export function isInvalidGrantError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    message?: unknown;
    response?: { data?: { error?: unknown } };
  };

  if (candidate.response?.data?.error === "invalid_grant") {
    return true;
  }

  return typeof candidate.message === "string" && candidate.message.includes("invalid_grant");
}

export function describeAccountError(account: string, error: unknown): string {
  if (isInvalidGrantError(error)) {
    return [
      `Gmail account "${account}" authorization has expired or was revoked.`,
      // The command gets its own line so selecting it does not also drag in
      // the sentence that follows.
      `Run:\n  npm run auth -- --account ${account}\n`,
      "If your Google OAuth app is still in Testing mode, refresh tokens expire after 7 days.",
      "See docs/troubleshooting.md.",
    ].join(" ");
  }

  return error instanceof Error ? error.message : String(error);
}

// Returns undefined when the stored token records no scope at all — tokens
// written before this field was persisted. Callers treat undefined as "unknown"
// and fall back to letting Google answer.
export function tokenHasScope(token: { scope?: string | null }, scope: string): boolean | undefined {
  if (typeof token.scope !== "string" || token.scope.length === 0) {
    return undefined;
  }
  return token.scope.split(/\s+/).includes(scope);
}

export function isScopeInsufficientError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    message?: unknown;
    response?: {
      status?: unknown;
      data?: {
        error_description?: unknown;
        error?: {
          message?: unknown;
          details?: unknown;
          errors?: unknown;
        };
      };
    };
  };

  const description = candidate.response?.data?.error_description;
  if (typeof description === "string" && description.toLowerCase().includes("insufficient authentication scopes")) {
    return true;
  }

  if (typeof candidate.message === "string" && candidate.message.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
    return true;
  }

  // The shape Gmail actually returns: a GaxiosError whose top-level message is
  // just "Request failed with status code 403", with the real detail buried in
  // response.data.error.
  const gmailError = candidate.response?.data?.error;

  const status = candidate.response?.status;
  const message = gmailError?.message;
  if (status === 403 && typeof message === "string" && message.toLowerCase().includes("insufficient authentication scopes")) {
    return true;
  }

  const details = gmailError?.details;
  if (Array.isArray(details) && details.some((entry) => isRecordWithReason(entry, "ACCESS_TOKEN_SCOPE_INSUFFICIENT"))) {
    return true;
  }

  // Gmail returns the "insufficientPermissions" reason for genuine
  // resource-permission denials too, not only missing OAuth scopes — pair it
  // with the 403 status the way the message branch above does, so a
  // resource-permission failure isn't misreported as fixable by re-running
  // npm run auth.
  const errors = gmailError?.errors;
  if (status === 403 && Array.isArray(errors) && errors.some((entry) => isRecordWithReason(entry, "insufficientPermissions"))) {
    return true;
  }

  return false;
}

function isRecordWithReason(value: unknown, reason: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "reason" in value &&
    (value as { reason?: unknown }).reason === reason
  );
}

export function describeMissingFilterScope(account: string): string {
  return [
    `Gmail account "${account}" was authorized before Octomail requested filter access.`,
    `Run:\n  npm run auth -- --account ${account}\n`,
    "and approve the new permission. Label, search, and draft tools keep working meanwhile.",
  ].join(" ");
}

export function describeMissingCalendarScope(account: string): string {
  return [
    `Gmail account "${account}" was authorized before Octomail requested calendar access.`,
    `Run:\n  npm run auth -- --account ${account}\n`,
    "and approve the new permission. Mail tools keep working meanwhile.",
  ].join(" ");
}

export function describeMissingDriveScope(account: string): string {
  return [
    `Gmail account "${account}" was authorized before Octomail requested Drive access.`,
    `Run:\n  npm run auth -- --account ${account}\n`,
    "and approve the new permission. Mail and calendar tools keep working meanwhile.",
  ].join(" ");
}
