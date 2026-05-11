import fs from "node:fs";
import { google, gmail_v1 } from "googleapis";
import { Credentials, OAuth2Client } from "google-auth-library";
import { getAccountConfig, loadOAuthCredentials } from "./config.js";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

export function createOAuthClient(redirectUri = "http://127.0.0.1"): OAuth2Client {
  const credentials = loadOAuthCredentials();
  return new google.auth.OAuth2(credentials.clientId, credentials.clientSecret, redirectUri);
}

export async function gmailForAccount(account: string): Promise<gmail_v1.Gmail> {
  const accountConfig = getAccountConfig(account);
  if (!fs.existsSync(accountConfig.tokenPath)) {
    throw new Error(
      `Gmail account "${account}" is configured but not authorized. Run: npm run auth -- --account ${account}`,
    );
  }

  const token = JSON.parse(fs.readFileSync(accountConfig.tokenPath, "utf8")) as Credentials;
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(token);
  return google.gmail({ version: "v1", auth: oauth2Client });
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

export function messageHeader(message: gmail_v1.Schema$Message, name: string): string | undefined {
  return message.payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

export function summarizeMessage(message: gmail_v1.Schema$Message) {
  const textBodies: string[] = [];
  const htmlBodies: string[] = [];
  collectBodies(message.payload, "text/plain", textBodies);
  collectBodies(message.payload, "text/html", htmlBodies);

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
      subject: messageHeader(message, "Subject"),
      date: messageHeader(message, "Date"),
      messageId: messageHeader(message, "Message-ID"),
      references: messageHeader(message, "References"),
    },
    bodyText: textBodies.join("\n\n").trim() || undefined,
    bodyHtml: htmlBodies.join("\n\n").trim() || undefined,
  };
}

export function encodeMimeMessage(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : undefined,
    input.bcc ? `Bcc: ${input.bcc}` : undefined,
    `Subject: ${input.subject}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : undefined,
    input.references ? `References: ${input.references}` : undefined,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);

  const message = `${headers.join("\r\n")}\r\n\r\n${input.body}`;
  return Buffer.from(message).toString("base64url");
}
