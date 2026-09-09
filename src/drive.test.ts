import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";
import type { drive_v3 } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DRIVE_SCOPE } from "./gmail.js";
import {
  DOC_MIME,
  FOLDER_MIME,
  SHEET_MIME,
  a1SheetRange,
  assertDriveName,
  assertListInput,
  assertMoveInput,
  capExportText,
  childrenQuery,
  copyProvenanceDescription,
  describeSheetsApiDisabled,
  escapeDriveQueryValue,
  exactNameInFolderQuery,
  exportFilename,
  exportKindForMime,
  fileProjection,
  isServiceDisabledError,
  missingDriveScope,
  nameContainsQuery,
  pickSheet,
  provenanceDescription,
  registerDriveTools,
  rowsToCsv,
  sheetTabsFromProperties,
} from "./drive.js";

// --- fileProjection ---

test("fileProjection sets isFolder true for a folder mime type", () => {
  const projection = fileProjection({ id: "1", name: "Reports", mimeType: FOLDER_MIME });
  assert.equal(projection.isFolder, true);
});

test("fileProjection sets isFolder false for a non-folder mime type", () => {
  const projection = fileProjection({ id: "1", name: "notes.txt", mimeType: "text/plain" });
  assert.equal(projection.isFolder, false);
});

test("fileProjection converts size string to sizeBytes number", () => {
  const projection = fileProjection({ id: "1", name: "notes.txt", mimeType: "text/plain", size: "1234" });
  assert.equal(projection.sizeBytes, 1234);
});

test("fileProjection leaves sizeBytes out when size is absent", () => {
  const projection = fileProjection({ id: "1", name: "notes.txt", mimeType: "text/plain" });
  assert.ok(!("sizeBytes" in projection));
});

test("fileProjection leaves parents, webViewLink, md5Checksum out when absent", () => {
  const projection = fileProjection({ id: "1", name: "notes.txt", mimeType: "text/plain" });
  assert.ok(!("parents" in projection));
  assert.ok(!("webViewLink" in projection));
  assert.ok(!("md5Checksum" in projection));
});

test("fileProjection throws when id is missing", () => {
  assert.throws(() => fileProjection({ name: "notes.txt", mimeType: "text/plain" } as drive_v3.Schema$File));
});

test("fileProjection throws when name is missing", () => {
  assert.throws(() => fileProjection({ id: "1", mimeType: "text/plain" } as drive_v3.Schema$File));
});

// --- escapeDriveQueryValue ---

test("escapeDriveQueryValue escapes single quotes", () => {
  assert.equal(escapeDriveQueryValue("O'Brien's"), "O\\'Brien\\'s");
});

test("escapeDriveQueryValue doubles a backslash", () => {
  assert.equal(escapeDriveQueryValue("a\\b"), "a\\\\b");
});

// --- query builders ---

test("childrenQuery builds the expected string without foldersOnly", () => {
  assert.equal(childrenQuery("folder1", false), "'folder1' in parents and trashed = false");
});

test("childrenQuery adds the mime clause when foldersOnly is true", () => {
  assert.equal(
    childrenQuery("folder1", true),
    `'folder1' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`,
  );
});

test("nameContainsQuery builds the expected string without foldersOnly", () => {
  assert.equal(nameContainsQuery("report", false), "name contains 'report' and trashed = false");
});

test("nameContainsQuery adds the mime clause when foldersOnly is true", () => {
  assert.equal(
    nameContainsQuery("report", true),
    `name contains 'report' and trashed = false and mimeType = '${FOLDER_MIME}'`,
  );
});

test("nameContainsQuery escapes its fragment", () => {
  assert.equal(nameContainsQuery("O'Brien", false), "name contains 'O\\'Brien' and trashed = false");
});

test("exactNameInFolderQuery builds the expected string without foldersOnly", () => {
  assert.equal(
    exactNameInFolderQuery("report.pdf", "folder1"),
    "name = 'report.pdf' and 'folder1' in parents and trashed = false",
  );
});

test("exactNameInFolderQuery adds the mime clause when foldersOnly is true", () => {
  assert.equal(
    exactNameInFolderQuery("Reports", "folder1", true),
    `name = 'Reports' and 'folder1' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`,
  );
});

test("every query builder's output contains trashed = false", () => {
  assert.match(childrenQuery("f", false), /trashed = false/);
  assert.match(nameContainsQuery("x", false), /trashed = false/);
  assert.match(exactNameInFolderQuery("x", "f"), /trashed = false/);
});

// --- assertListInput ---

test("assertListInput throws when both folderId and nameContains are set", () => {
  assert.throws(
    () => assertListInput({ folderId: "f", nameContains: "x" }),
    /Pass either folderId or nameContains, not both\. Nothing was changed\./,
  );
});

test("assertListInput does not throw when only folderId is set", () => {
  assert.doesNotThrow(() => assertListInput({ folderId: "f" }));
});

test("assertListInput does not throw when only nameContains is set", () => {
  assert.doesNotThrow(() => assertListInput({ nameContains: "x" }));
});

test("assertListInput does not throw when neither is set", () => {
  assert.doesNotThrow(() => assertListInput({}));
});

// --- assertMoveInput ---

test("assertMoveInput throws when neither folderId nor name is set", () => {
  assert.throws(
    () => assertMoveInput({}),
    /Pass folderId to move, name to rename, or both\. Nothing was changed\./,
  );
});

test("assertMoveInput does not throw when only folderId is set", () => {
  assert.doesNotThrow(() => assertMoveInput({ folderId: "f" }));
});

test("assertMoveInput does not throw when only name is set", () => {
  assert.doesNotThrow(() => assertMoveInput({ name: "new-name" }));
});

test("assertMoveInput does not throw when both are set", () => {
  assert.doesNotThrow(() => assertMoveInput({ folderId: "f", name: "new-name" }));
});

// --- assertDriveName ---

test("assertDriveName throws on an empty string", () => {
  assert.throws(() => assertDriveName(""), /Nothing was changed\./);
});

test("assertDriveName throws on a 256 character name", () => {
  assert.throws(() => assertDriveName("a".repeat(256)), /Nothing was changed\./);
});

test("assertDriveName throws on a name containing a slash", () => {
  assert.throws(() => assertDriveName("a/b"), /Nothing was changed\./);
});

test("assertDriveName throws on a name containing a control character", () => {
  assert.throws(() => assertDriveName("a\nb"), /Nothing was changed\./);
});

test("assertDriveName does not throw on a valid name", () => {
  assert.doesNotThrow(() => assertDriveName("Report: Q3?"));
});

test("assertDriveName ends the message with a custom outcome phrase", () => {
  assert.throws(() => assertDriveName("", "Nothing was moved."), /Nothing was moved\.$/);
});

// --- provenanceDescription ---

test("provenanceDescription includes all four lines when every header is present", () => {
  const description = provenanceDescription({
    account: "work",
    messageId: "msg1",
    subject: "Invoice",
    from: "billing@example.com",
    date: "2026-09-01",
  });
  assert.equal(
    description,
    [
      "Saved by Octomail from Gmail account work, message msg1.",
      "Subject: Invoice",
      "From: billing@example.com",
      "Date: 2026-09-01",
    ].join("\n"),
  );
});

test("provenanceDescription drops only the missing header, with no undefined anywhere", () => {
  const description = provenanceDescription({
    account: "work",
    messageId: "msg1",
    subject: "Invoice",
    date: "2026-09-01",
  });
  assert.doesNotMatch(description, /undefined/);
  assert.doesNotMatch(description, /From:/);
  assert.match(description, /Subject: Invoice/);
  assert.match(description, /Date: 2026-09-01/);
});

test("provenanceDescription cuts to exactly 1000 characters and keeps the first line intact", () => {
  const description = provenanceDescription({
    account: "work",
    messageId: "msg1",
    subject: "x".repeat(5000),
  });
  assert.equal(description.length, 1000);
  assert.ok(description.startsWith("Saved by Octomail from Gmail account work, message msg1.\nSubject: "));
});

// --- copyProvenanceDescription ---

const COPY_LINE = "Copied by Octomail from faktura.pdf (src1) on 2026-09-09T12:00:00.000Z.";

test("copyProvenanceDescription is the single provenance line when the source has no description", () => {
  const description = copyProvenanceDescription({
    sourceName: "faktura.pdf",
    sourceId: "src1",
    copiedAt: "2026-09-09T12:00:00.000Z",
  });
  assert.equal(description, COPY_LINE);
});

test("copyProvenanceDescription keeps an existing description and appends the line after a newline", () => {
  const description = copyProvenanceDescription({
    sourceName: "faktura.pdf",
    sourceId: "src1",
    copiedAt: "2026-09-09T12:00:00.000Z",
    existing: "Saved by Octomail from Gmail account work, message msg1.",
  });
  assert.equal(description, `Saved by Octomail from Gmail account work, message msg1.\n${COPY_LINE}`);
});

test("copyProvenanceDescription treats a whitespace-only existing description as absent", () => {
  const description = copyProvenanceDescription({
    sourceName: "faktura.pdf",
    sourceId: "src1",
    copiedAt: "2026-09-09T12:00:00.000Z",
    existing: "  \n ",
  });
  assert.equal(description, COPY_LINE);
});

test("copyProvenanceDescription caps at 1000 characters by trimming the existing text, never the line", () => {
  const description = copyProvenanceDescription({
    sourceName: "faktura.pdf",
    sourceId: "src1",
    copiedAt: "2026-09-09T12:00:00.000Z",
    existing: "x".repeat(2000),
  });
  assert.equal(description.length, 1000);
  assert.ok(description.endsWith(`\n${COPY_LINE}`));
  assert.ok(description.startsWith("xxx"));
});

// --- missingDriveScope ---

test("missingDriveScope returns a message naming the re-auth command when scope is lacking", () => {
  const message = missingDriveScope({ scope: "https://www.googleapis.com/auth/gmail.readonly" }, "work");
  assert.match(message ?? "", /npm run auth -- --account work/);
});

test("missingDriveScope returns undefined when the token holds the scope", () => {
  const message = missingDriveScope(
    { scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive" },
    "work",
  );
  assert.equal(message, undefined);
});

test("missingDriveScope returns undefined when scope is absent", () => {
  const message = missingDriveScope({}, "work");
  assert.equal(message, undefined);
});

// --- drive_export_file pure helpers ---

test("exportKindForMime maps a Google Sheet to sheet", () => {
  assert.equal(exportKindForMime(SHEET_MIME), "sheet");
});

test("exportKindForMime maps a Google Doc to doc", () => {
  assert.equal(exportKindForMime(DOC_MIME), "doc");
});

test("exportKindForMime returns undefined for a folder, a PDF and an uploaded xlsx", () => {
  assert.equal(exportKindForMime(FOLDER_MIME), undefined);
  assert.equal(exportKindForMime("application/pdf"), undefined);
  assert.equal(
    exportKindForMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    undefined,
  );
});

const TAB_SECOND = {
  properties: { title: "stare wpisy", index: 1, sheetId: 22, gridProperties: { rowCount: 3, columnCount: 2 } },
};
const TAB_FIRST = {
  properties: { title: "Arkusz1", index: 0, sheetId: 0, gridProperties: { rowCount: 2, columnCount: 3 } },
};

test("sheetTabsFromProperties sorts tabs by index and carries grid sizes", () => {
  const tabs = sheetTabsFromProperties([TAB_SECOND, TAB_FIRST]);
  assert.deepEqual(tabs, [
    { title: "Arkusz1", index: 0, sheetId: 0, rowCount: 2, columnCount: 3 },
    { title: "stare wpisy", index: 1, sheetId: 22, rowCount: 3, columnCount: 2 },
  ]);
});

test("sheetTabsFromProperties throws when a tab has no title", () => {
  assert.throws(() => sheetTabsFromProperties([{ properties: { index: 0, sheetId: 0 } }]));
});

const TABS = sheetTabsFromProperties([TAB_SECOND, TAB_FIRST]);

test("pickSheet defaults to the index-0 tab even when Google listed it second", () => {
  assert.equal(pickSheet(TABS, "Budżet roczny").title, "Arkusz1");
});

test("pickSheet finds a tab by exact title", () => {
  assert.equal(pickSheet(TABS, "Budżet roczny", "stare wpisy").sheetId, 22);
});

test("pickSheet treats a case mismatch as a miss", () => {
  assert.throws(() => pickSheet(TABS, "Budżet roczny", "Stare Wpisy"), /not found/);
});

test("pickSheet's miss message lists every tab title", () => {
  assert.throws(
    () => pickSheet(TABS, "Budżet roczny", "Nieistniejący"),
    /Sheet "Nieistniejący" not found in Budżet roczny\. Tabs: "Arkusz1", "stare wpisy"\. Nothing was changed\.$/,
  );
});

test("pickSheet throws on a spreadsheet with no tabs", () => {
  assert.throws(() => pickSheet([], "Budżet roczny"), /reports no tabs\. Nothing was changed\./);
});

test("a1SheetRange wraps a plain title in single quotes", () => {
  assert.equal(a1SheetRange("Arkusz1"), "'Arkusz1'");
});

test("a1SheetRange keeps spaces and Polish letters inside the quotes", () => {
  assert.equal(a1SheetRange("stare wpisy"), "'stare wpisy'");
  assert.equal(a1SheetRange("Płace"), "'Płace'");
});

test("a1SheetRange doubles a single quote in the title", () => {
  assert.equal(a1SheetRange("it's"), "'it''s'");
});

test("rowsToCsv renders plain cells with commas and newlines", () => {
  assert.equal(rowsToCsv([["a", "b"], ["c", "d"]]), "a,b\nc,d");
});

test("rowsToCsv quotes a field containing a comma", () => {
  assert.equal(rowsToCsv([["Kowalska, Anna", "x"]]), '"Kowalska, Anna",x');
});

test("rowsToCsv doubles an inner double quote", () => {
  assert.equal(rowsToCsv([['say "hi"']]), '"say ""hi"""');
});

test("rowsToCsv quotes fields containing LF or CR", () => {
  assert.equal(rowsToCsv([["a\nb", "c\rd"]]), '"a\nb","c\rd"');
});

test("rowsToCsv renders null, undefined and numbers", () => {
  assert.equal(rowsToCsv([[null, undefined, 12.5]]), ",,12.5");
});

test("rowsToCsv pads ragged rows to the widest row", () => {
  assert.equal(rowsToCsv([["a", "b", "c"], ["d"]]), "a,b,c\nd,,");
});

test("rowsToCsv renders empty or absent input as an empty string", () => {
  assert.equal(rowsToCsv([]), "");
  assert.equal(rowsToCsv(null), "");
  assert.equal(rowsToCsv(undefined), "");
});

test("rowsToCsv does not end with a newline", () => {
  assert.ok(!rowsToCsv([["a"], ["b"]]).endsWith("\n"));
});

test("capExportText returns text under the cap unchanged", () => {
  assert.deepEqual(capExportText("abc", 10), { text: "abc", truncated: false, totalBytes: 3 });
});

test("capExportText cuts on the last newline inside the cap", () => {
  const line = "x".repeat(100);
  const text = [line, line, line].join("\n");
  const result = capExportText(text, 250);
  assert.equal(result.text, `${line}\n${line}`);
  assert.equal(result.truncated, true);
  assert.equal(result.totalBytes, 302);
});

test("capExportText without a newline inside the cap cuts on a character boundary", () => {
  const text = "ł".repeat(100);
  const result = capExportText(text, 101);
  assert.equal(result.text, "ł".repeat(50));
  assert.ok(!result.text.includes("�"));
  assert.equal(result.truncated, true);
  assert.equal(result.totalBytes, 200);
});

test("exportFilename gives a doc a .txt name", () => {
  assert.equal(exportFilename("Budżet roczny", "doc"), "Budżet roczny.txt");
});

test("exportFilename gives a sheet tab a .csv name carrying the tab title", () => {
  assert.equal(exportFilename("Budżet roczny", "sheet", "stare wpisy"), "Budżet roczny - stare wpisy.csv");
});

test("exportFilename sanitises a slash in the tab title", () => {
  assert.ok(!exportFilename("Budżet roczny", "sheet", "a/b").includes("/"));
});

test("isServiceDisabledError recognises the accessNotConfigured reason", () => {
  assert.equal(
    isServiceDisabledError({
      response: { status: 403, data: { error: { message: "disabled", errors: [{ reason: "accessNotConfigured" }] } } },
    }),
    true,
  );
});

test("isServiceDisabledError recognises the has-not-been-used message", () => {
  assert.equal(
    isServiceDisabledError({
      response: {
        status: 403,
        data: { error: { message: "Google Sheets API has not been used in project 123 before or it is disabled." } },
      },
    }),
    true,
  );
});

test("isServiceDisabledError recognises the SERVICE_DISABLED detail reason", () => {
  assert.equal(
    isServiceDisabledError({
      response: { status: 403, data: { error: { message: "x", details: [{ reason: "SERVICE_DISABLED" }] } } },
    }),
    true,
  );
});

test("isServiceDisabledError is false for a 404 and for a scope 403", () => {
  assert.equal(isServiceDisabledError({ response: { status: 404, data: { error: { message: "not found" } } } }), false);
  assert.equal(
    isServiceDisabledError({
      response: { status: 403, data: { error: { message: "Request had insufficient authentication scopes." } } },
    }),
    false,
  );
});

test("describeSheetsApiDisabled names the setup step and ends with the outcome phrase", () => {
  assert.match(describeSheetsApiDisabled(), /Google Sheets API is not enabled/);
  assert.match(describeSheetsApiDisabled(), /docs\/google-cloud-setup\.md, step 1/);
  assert.match(describeSheetsApiDisabled(), /Nothing was changed\.$/);
});

// --- end-to-end: registerDriveTools against a fake Drive network ---
//
// Same fake-fetch harness as src/gate.test.ts (test files in this repo do not
// import each other, so it is copied rather than shared) — a fake
// fetchImplementation merged onto the shared `google` singleton intercepts
// every request googleapis makes, with no change to production code. These
// tests call the real registered handlers, so they prove the refusal paths
// (assertListInput, assertDriveName, the missing-scope preflight) actually
// stop the network call, not just that the pure helpers return the right
// verdict in isolation.

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function createFakeServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      const handler = args[args.length - 1] as Handler;
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

async function callTool(
  handlers: Map<string, Handler>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = handlers.get(name);
  if (!handler) {
    throw new Error(`No handler registered for "${name}"`);
  }
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

type FakeCall = { method: string; pathname: string; url: URL; body?: string };
// `host` restricts a route to one API host (Sheets traffic goes to
// sheets.googleapis.com); a route without it matches any host, as before.
type FakeRoute = {
  method: string;
  host?: string;
  test: (pathname: string) => boolean;
  respond: (url: URL) => unknown;
};

// A route's respond() normally returns an object sent as JSON with status
// 200. Returning fakeReply(status, body) instead sends that status; a string
// body goes out as text/plain, verbatim, which is what a Doc export returns.
class FakeReply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

function fakeReply(status: number, body: unknown): FakeReply {
  return new FakeReply(status, body);
}

// googleapis sends a plain JSON requestBody as a string, but routes a
// files.create call with `media` (drive_save_attachment's upload) as a
// multipart/related body built from a Node Readable stream — gaxios pipes
// the metadata part and the content part into it rather than handing fetch a
// string. Reading it fully here is what lets a test assert on the metadata
// JSON substring and the raw uploaded bytes.
async function readBodyText(body: unknown): Promise<string | undefined> {
  if (typeof body === "string") {
    return body;
  }
  if (body && typeof (body as { pipe?: unknown }).pipe === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return undefined;
}

function installFakeNetwork(routes: FakeRoute[]): { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  google.options({
    fetchImplementation: async (url: unknown, opts?: { method?: string; body?: unknown }) => {
      const parsed = new URL(String(url));
      const method = (opts?.method ?? "GET").toUpperCase();
      const body = await readBodyText(opts?.body);
      calls.push(
        body === undefined
          ? { method, pathname: parsed.pathname, url: parsed }
          : { method, pathname: parsed.pathname, url: parsed, body },
      );

      const route = routes.find(
        (candidate) =>
          candidate.method === method &&
          (candidate.host === undefined || candidate.host === parsed.hostname) &&
          candidate.test(parsed.pathname),
      );
      if (!route) {
        return new Response(
          JSON.stringify({ error: { code: 404, message: `no fake route for ${method} ${parsed.pathname}` } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      const reply = route.respond(parsed);
      if (reply instanceof FakeReply) {
        if (typeof reply.body === "string") {
          return new Response(reply.body, { status: reply.status, headers: { "content-type": "text/plain" } });
        }
        return new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { calls };
}

const ACCOUNT = "work";
let fixtureDir: string;

function setupAccountFixture(withDriveScope = true): void {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-drive-test-"));
  process.env.OCTOMAIL_ACCOUNTS_FILE = path.join(fixtureDir, "accounts.json");
  process.env.OCTOMAIL_TOKEN_DIR = path.join(fixtureDir, "tokens");
  process.env.OCTOMAIL_DOWNLOAD_DIR = path.join(fixtureDir, "downloads");
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

  fs.mkdirSync(process.env.OCTOMAIL_TOKEN_DIR, { recursive: true });
  fs.writeFileSync(process.env.OCTOMAIL_ACCOUNTS_FILE, JSON.stringify({ accounts: { [ACCOUNT]: {} } }));

  const scopes = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify"];
  if (withDriveScope) {
    scopes.push(DRIVE_SCOPE);
  }

  fs.writeFileSync(
    path.join(process.env.OCTOMAIL_TOKEN_DIR, `${ACCOUNT}.json`),
    JSON.stringify({
      access_token: "fake-access-token",
      refresh_token: "fake-refresh-token",
      scope: scopes.join(" "),
      token_type: "Bearer",
      // Far enough out that OAuth2Client never attempts a refresh.
      expiry_date: Date.now() + 60 * 60 * 1000,
    }),
  );
}

function teardownAccountFixture(): void {
  delete process.env.OCTOMAIL_ACCOUNTS_FILE;
  delete process.env.OCTOMAIL_TOKEN_DIR;
  delete process.env.OCTOMAIL_DOWNLOAD_DIR;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  google.options({});
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

const FOLDER_A = { id: "folderA", name: "Reports", mimeType: FOLDER_MIME };
const FILE_A = { id: "fileA", name: "notes.txt", mimeType: "text/plain" };
const PARENT_FOLDER = { id: "parent1", name: "Parent", mimeType: FOLDER_MIME };
const EXISTING_FOLDER = { id: "existing1", name: "Invoices", mimeType: FOLDER_MIME };
const CREATED_FOLDER = { id: "new1", name: "Invoices", mimeType: FOLDER_MIME };

test("drive_list_files with both folderId and nameContains refuses before any network call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([]);

    const result = await callTool(handlers, "drive_list_files", {
      account: ACCOUNT,
      folderId: "folder1",
      nameContains: "report",
    });

    assert.match(result.error as string, /Pass either folderId or nameContains, not both\. Nothing was changed\./);
    assert.deepEqual(calls, []);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_list_files lists a folder's children with all-drives params and the expected query", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: [FOLDER_A, FILE_A] }) },
    ]);

    const result = await callTool(handlers, "drive_list_files", {
      account: ACCOUNT,
      folderId: "folder1",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    const files = result.files as Array<{ id: string }>;
    assert.equal(files.length, 2);
    assert.equal(files[0].id, "folderA");

    const listCall = calls.find((call) => call.method === "GET" && call.pathname === "/drive/v3/files");
    assert.ok(listCall, `expected a GET to /drive/v3/files; calls were: ${JSON.stringify(calls)}`);
    const q = listCall!.url.searchParams.get("q") ?? "";
    assert.match(q, /'folder1' in parents/);
    assert.match(q, /trashed = false/);
    assert.equal(listCall!.url.searchParams.get("supportsAllDrives"), "true");
    assert.equal(listCall!.url.searchParams.get("includeItemsFromAllDrives"), "true");
  } finally {
    teardownAccountFixture();
  }
});

test("drive_list_files surfaces incompleteSearch: true when Drive returns it", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    installFakeNetwork([
      {
        method: "GET",
        test: (p) => p === "/drive/v3/files",
        respond: () => ({ files: [FOLDER_A], incompleteSearch: true }),
      },
    ]);

    const result = await callTool(handlers, "drive_list_files", {
      account: ACCOUNT,
      folderId: "folder1",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal(result.incompleteSearch, true);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_create_folder returns the existing folder and creates nothing when one with that name already exists", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === "/drive/v3/files/parent1", respond: () => PARENT_FOLDER },
      { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: [EXISTING_FOLDER] }) },
    ]);

    const result = await callTool(handlers, "drive_create_folder", {
      account: ACCOUNT,
      name: "Invoices",
      parentId: "parent1",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal(result.created, false);
    assert.equal((result.folder as { id: string }).id, "existing1");
    assert.ok(
      !calls.some((call) => call.method === "POST"),
      `expected no POST; calls were: ${JSON.stringify(calls)}`,
    );
  } finally {
    teardownAccountFixture();
  }
});

test("drive_create_folder creates the folder when none with that name exists yet", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === "/drive/v3/files/parent1", respond: () => PARENT_FOLDER },
      { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: [] }) },
      { method: "POST", test: (p) => p === "/drive/v3/files", respond: () => CREATED_FOLDER },
    ]);

    const result = await callTool(handlers, "drive_create_folder", {
      account: ACCOUNT,
      name: "Invoices",
      parentId: "parent1",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal(result.created, true);
    assert.equal((result.folder as { id: string }).id, "new1");
    assert.ok(
      calls.some((call) => call.method === "POST" && call.pathname === "/drive/v3/files"),
      `expected a POST to /drive/v3/files; calls were: ${JSON.stringify(calls)}`,
    );
  } finally {
    teardownAccountFixture();
  }
});

test("drive_create_folder with an invalid name refuses before any network call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([]);

    const result = await callTool(handlers, "drive_create_folder", {
      account: ACCOUNT,
      name: "bad/name",
    });

    assert.match(result.error as string, /Nothing was changed\./);
    assert.deepEqual(calls, []);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_list_files with a token lacking the Drive scope refuses before any network call", async () => {
  setupAccountFixture(false);
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([]);

    const result = await callTool(handlers, "drive_list_files", {
      account: ACCOUNT,
      folderId: "root",
    });

    assert.match(result.error as string, /npm run auth -- --account work/);
    assert.ok(
      (result.error as string).endsWith("Nothing was changed."),
      `expected error to end with "Nothing was changed.", got: ${result.error}`,
    );
    assert.deepEqual(calls, []);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_create_folder with a token lacking the Drive scope refuses before any network call", async () => {
  setupAccountFixture(false);
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([]);

    const result = await callTool(handlers, "drive_create_folder", {
      account: ACCOUNT,
      name: "Invoices",
    });

    assert.match(result.error as string, /npm run auth -- --account work/);
    assert.ok(
      (result.error as string).endsWith("Nothing was changed."),
      `expected error to end with "Nothing was changed.", got: ${result.error}`,
    );
    assert.deepEqual(calls, []);
  } finally {
    teardownAccountFixture();
  }
});

// --- end-to-end: drive_save_attachment ---
//
// Fake Gmail routes mirror the real googleapis URL templates so the same
// installFakeNetwork harness (and its recorded `calls`) proves the order of
// operations: a bad or trashed folder must never cost a Gmail round trip,
// and a name collision must never reach the upload.

const SAVE_MESSAGE_ID = "msg1";
const SAVE_ATTACHMENT_ID = "att1";
const SAVE_ATTACHMENT_CONTENT = "%PDF-fake";
const SAVE_FOLDER = { id: "folder1", name: "Reports", mimeType: FOLDER_MIME };
const SAVE_TRASHED_FOLDER = { id: "trashed1", name: "Old", mimeType: FOLDER_MIME, trashed: true };
const SAVE_NON_FOLDER = { id: "file1", name: "notes.txt", mimeType: "text/plain" };
const SAVE_EXISTING_FILE = {
  id: "existing-id",
  name: "faktura.pdf",
  mimeType: "application/pdf",
  webViewLink: "https://drive.google.com/file/d/existing-id/view",
};
const SAVE_UPLOADED_FILE = {
  id: "uploaded1",
  name: "faktura.pdf",
  mimeType: "application/pdf",
  size: String(Buffer.byteLength(SAVE_ATTACHMENT_CONTENT)),
};

function saveMessageRoute(): FakeRoute {
  return {
    method: "GET",
    test: (p) => p === `/gmail/v1/users/me/messages/${SAVE_MESSAGE_ID}`,
    respond: () => ({
      id: SAVE_MESSAGE_ID,
      payload: {
        headers: [
          { name: "Subject", value: "Faktura wrzesien" },
          { name: "From", value: "ksiegowa@example.com" },
          { name: "Date", value: "Mon, 1 Sep 2025 10:00:00 +0000" },
        ],
        parts: [
          {
            filename: "faktura.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: SAVE_ATTACHMENT_ID, size: Buffer.byteLength(SAVE_ATTACHMENT_CONTENT) },
          },
        ],
      },
    }),
  };
}

function saveAttachmentRoute(): FakeRoute {
  return {
    method: "GET",
    test: (p) => p === `/gmail/v1/users/me/messages/${SAVE_MESSAGE_ID}/attachments/${SAVE_ATTACHMENT_ID}`,
    respond: () => ({
      size: Buffer.byteLength(SAVE_ATTACHMENT_CONTENT),
      data: Buffer.from(SAVE_ATTACHMENT_CONTENT).toString("base64url"),
    }),
  };
}

test("drive_save_attachment with a token lacking the Drive scope refuses before any network call", async () => {
  setupAccountFixture(false);
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([]);

    const result = await callTool(handlers, "drive_save_attachment", {
      account: ACCOUNT,
      messageId: SAVE_MESSAGE_ID,
      attachmentId: SAVE_ATTACHMENT_ID,
      folderId: "folder1",
    });

    assert.match(result.error as string, /npm run auth -- --account work/);
    assert.ok(
      (result.error as string).endsWith("Nothing was uploaded."),
      `expected error to end with "Nothing was uploaded.", got: ${result.error}`,
    );
    assert.deepEqual(calls, []);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_save_attachment with an invalid explicit name refuses with no network calls", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([]);

    const result = await callTool(handlers, "drive_save_attachment", {
      account: ACCOUNT,
      messageId: SAVE_MESSAGE_ID,
      attachmentId: SAVE_ATTACHMENT_ID,
      folderId: "folder1",
      name: "a/b",
    });

    assert.match(result.error as string, /Nothing was uploaded\./);
    assert.deepEqual(calls, []);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_save_attachment refuses a non-folder target before any Gmail call or upload", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === "/drive/v3/files/file1", respond: () => SAVE_NON_FOLDER },
    ]);

    const result = await callTool(handlers, "drive_save_attachment", {
      account: ACCOUNT,
      messageId: SAVE_MESSAGE_ID,
      attachmentId: SAVE_ATTACHMENT_ID,
      folderId: "file1",
    });

    assert.match(result.error as string, /is not a folder/);
    assert.ok(
      !calls.some((call) => call.pathname.startsWith("/gmail/")),
      `expected no Gmail calls; calls were: ${JSON.stringify(calls)}`,
    );
    assert.ok(
      !calls.some((call) => call.pathname === "/upload/drive/v3/files"),
      `expected no upload call; calls were: ${JSON.stringify(calls)}`,
    );
  } finally {
    teardownAccountFixture();
  }
});

test("drive_save_attachment refuses a trashed folder without uploading", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === "/drive/v3/files/trashed1", respond: () => SAVE_TRASHED_FOLDER },
    ]);

    const result = await callTool(handlers, "drive_save_attachment", {
      account: ACCOUNT,
      messageId: SAVE_MESSAGE_ID,
      attachmentId: SAVE_ATTACHMENT_ID,
      folderId: "trashed1",
    });

    assert.match(result.error as string, /in the trash/);
    assert.ok(
      !calls.some((call) => call.pathname === "/upload/drive/v3/files"),
      `expected no upload call; calls were: ${JSON.stringify(calls)}`,
    );
  } finally {
    teardownAccountFixture();
  }
});

test("drive_save_attachment refuses on a name collision, naming the existing file, without uploading", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === "/drive/v3/files/folder1", respond: () => SAVE_FOLDER },
      { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: [SAVE_EXISTING_FILE] }) },
      saveMessageRoute(),
      saveAttachmentRoute(),
    ]);

    const result = await callTool(handlers, "drive_save_attachment", {
      account: ACCOUNT,
      messageId: SAVE_MESSAGE_ID,
      attachmentId: SAVE_ATTACHMENT_ID,
      folderId: "folder1",
    });

    assert.match(result.error as string, /existing-id/);
    assert.match(result.error as string, /Nothing was uploaded\./);
    assert.ok(
      !calls.some((call) => call.method === "POST" && call.pathname === "/upload/drive/v3/files"),
      `expected no upload call; calls were: ${JSON.stringify(calls)}`,
    );
  } finally {
    teardownAccountFixture();
  }
});

test("drive_save_attachment uploads the attachment into the folder with no base64 in the result", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === "/drive/v3/files/folder1", respond: () => SAVE_FOLDER },
      { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: [] }) },
      saveMessageRoute(),
      saveAttachmentRoute(),
      { method: "POST", test: (p) => p === "/upload/drive/v3/files", respond: () => SAVE_UPLOADED_FILE },
    ]);

    const result = await callTool(handlers, "drive_save_attachment", {
      account: ACCOUNT,
      messageId: SAVE_MESSAGE_ID,
      attachmentId: SAVE_ATTACHMENT_ID,
      folderId: "folder1",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal((result.file as { id: string }).id, "uploaded1");
    assert.equal(
      (result.sourceAttachment as { sizeBytes: number }).sizeBytes,
      Buffer.byteLength(SAVE_ATTACHMENT_CONTENT),
    );

    const uploadCall = calls.find((call) => call.method === "POST" && call.pathname === "/upload/drive/v3/files");
    assert.ok(uploadCall?.body, `expected an upload call carrying a body; calls were: ${JSON.stringify(calls)}`);
    assert.match(uploadCall!.body!, /"parents":\["folder1"\]/);
    assert.match(uploadCall!.body!, /faktura\.pdf/);
    assert.match(uploadCall!.body!, new RegExp(`message ${SAVE_MESSAGE_ID}`));
    assert.match(uploadCall!.body!, /%PDF-fake/);

    const resultText = JSON.stringify(result);
    assert.ok(
      !resultText.includes(Buffer.from(SAVE_ATTACHMENT_CONTENT).toString("base64")),
      "result JSON must not contain the attachment's base64 content",
    );
  } finally {
    teardownAccountFixture();
  }
});

// --- end-to-end: drive_move_file ---
//
// Same fake-fetch harness. These prove the order of operations (scope ->
// assertMoveInput -> assertDriveName -> getFile -> getFolder -> collision
// check -> files.update) via the recorded `calls` array, not just that the
// pure helpers return the right verdict in isolation.

const MOVE_FILE_ID = "f1";
const MOVE_OLD_PARENT = "old1";
const MOVE_NEW_FOLDER = { id: "new1", name: "Target", mimeType: FOLDER_MIME };
const MOVE_FILE = { id: MOVE_FILE_ID, name: "notes.txt", mimeType: "text/plain", parents: [MOVE_OLD_PARENT] };
const MOVE_FILE_NO_PARENTS = { id: MOVE_FILE_ID, name: "notes.txt", mimeType: "text/plain" };
const MOVE_TRASHED_FILE = { id: MOVE_FILE_ID, name: "notes.txt", mimeType: "text/plain", trashed: true };
const MOVE_UPDATED_FILE = { id: MOVE_FILE_ID, name: "notes.txt", mimeType: "text/plain", parents: [MOVE_NEW_FOLDER.id] };
const MOVE_RENAMED_FILE = { id: MOVE_FILE_ID, name: "renamed.txt", mimeType: "text/plain", parents: [MOVE_OLD_PARENT] };
const MOVE_COLLISION_FILE = {
  id: "collision-id",
  name: "notes.txt",
  mimeType: "text/plain",
  webViewLink: "https://drive.google.com/file/d/collision-id/view",
};

test("drive_move_file with neither folderId nor name refuses before any network call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([]);

    const result = await callTool(handlers, "drive_move_file", {
      account: ACCOUNT,
      fileId: MOVE_FILE_ID,
    });

    assert.match(result.error as string, /Pass folderId to move, name to rename, or both\. Nothing was changed\./);
    assert.deepEqual(calls, []);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_move_file moves a file into a new folder", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === `/drive/v3/files/${MOVE_FILE_ID}`, respond: () => MOVE_FILE },
      { method: "GET", test: (p) => p === `/drive/v3/files/${MOVE_NEW_FOLDER.id}`, respond: () => MOVE_NEW_FOLDER },
      { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: [] }) },
      { method: "PATCH", test: (p) => p === `/drive/v3/files/${MOVE_FILE_ID}`, respond: () => MOVE_UPDATED_FILE },
    ]);

    const result = await callTool(handlers, "drive_move_file", {
      account: ACCOUNT,
      fileId: MOVE_FILE_ID,
      folderId: MOVE_NEW_FOLDER.id,
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.deepEqual(result.previousParents, [MOVE_OLD_PARENT]);
    assert.equal((result.file as { id: string }).id, MOVE_FILE_ID);

    const patchCall = calls.find(
      (call) => call.method === "PATCH" && call.pathname === `/drive/v3/files/${MOVE_FILE_ID}`,
    );
    assert.ok(patchCall, `expected a PATCH to /drive/v3/files/${MOVE_FILE_ID}; calls were: ${JSON.stringify(calls)}`);
    assert.equal(patchCall!.url.searchParams.get("addParents"), MOVE_NEW_FOLDER.id);
    assert.equal(patchCall!.url.searchParams.get("removeParents"), MOVE_OLD_PARENT);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_move_file moving a parentless file omits removeParents entirely", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === `/drive/v3/files/${MOVE_FILE_ID}`, respond: () => MOVE_FILE_NO_PARENTS },
      { method: "GET", test: (p) => p === `/drive/v3/files/${MOVE_NEW_FOLDER.id}`, respond: () => MOVE_NEW_FOLDER },
      { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: [] }) },
      { method: "PATCH", test: (p) => p === `/drive/v3/files/${MOVE_FILE_ID}`, respond: () => MOVE_UPDATED_FILE },
    ]);

    const result = await callTool(handlers, "drive_move_file", {
      account: ACCOUNT,
      fileId: MOVE_FILE_ID,
      folderId: MOVE_NEW_FOLDER.id,
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.deepEqual(result.previousParents, []);

    const patchCall = calls.find(
      (call) => call.method === "PATCH" && call.pathname === `/drive/v3/files/${MOVE_FILE_ID}`,
    );
    assert.ok(patchCall, `expected a PATCH to /drive/v3/files/${MOVE_FILE_ID}; calls were: ${JSON.stringify(calls)}`);
    assert.equal(patchCall!.url.searchParams.get("addParents"), MOVE_NEW_FOLDER.id);
    assert.equal(patchCall!.url.searchParams.get("removeParents"), null);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_move_file renames a file without moving it", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === `/drive/v3/files/${MOVE_FILE_ID}`, respond: () => MOVE_FILE },
      { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: [] }) },
      { method: "PATCH", test: (p) => p === `/drive/v3/files/${MOVE_FILE_ID}`, respond: () => MOVE_RENAMED_FILE },
    ]);

    const result = await callTool(handlers, "drive_move_file", {
      account: ACCOUNT,
      fileId: MOVE_FILE_ID,
      name: "renamed.txt",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal(result.previousName, "notes.txt");

    const patchCall = calls.find(
      (call) => call.method === "PATCH" && call.pathname === `/drive/v3/files/${MOVE_FILE_ID}`,
    );
    assert.ok(patchCall, `expected a PATCH to /drive/v3/files/${MOVE_FILE_ID}; calls were: ${JSON.stringify(calls)}`);
    assert.equal(patchCall!.url.searchParams.get("addParents"), null);
    assert.match(patchCall!.body ?? "", /"name":\s*"renamed\.txt"/);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_move_file renames a parentless file without a collision check", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === `/drive/v3/files/${MOVE_FILE_ID}`, respond: () => MOVE_FILE_NO_PARENTS },
      { method: "PATCH", test: (p) => p === `/drive/v3/files/${MOVE_FILE_ID}`, respond: () => MOVE_RENAMED_FILE },
    ]);

    const result = await callTool(handlers, "drive_move_file", {
      account: ACCOUNT,
      fileId: MOVE_FILE_ID,
      name: "renamed.txt",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.ok(
      !calls.some((call) => call.method === "GET" && call.pathname === "/drive/v3/files"),
      `expected no list call; calls were: ${JSON.stringify(calls)}`,
    );
    assert.ok(
      calls.some((call) => call.method === "PATCH" && call.pathname === `/drive/v3/files/${MOVE_FILE_ID}`),
      `expected a PATCH; calls were: ${JSON.stringify(calls)}`,
    );
  } finally {
    teardownAccountFixture();
  }
});

test("drive_move_file refuses on a name collision in the target folder, naming the existing file, without a PATCH", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === `/drive/v3/files/${MOVE_FILE_ID}`, respond: () => MOVE_FILE },
      { method: "GET", test: (p) => p === `/drive/v3/files/${MOVE_NEW_FOLDER.id}`, respond: () => MOVE_NEW_FOLDER },
      { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: [MOVE_COLLISION_FILE] }) },
    ]);

    const result = await callTool(handlers, "drive_move_file", {
      account: ACCOUNT,
      fileId: MOVE_FILE_ID,
      folderId: MOVE_NEW_FOLDER.id,
    });

    assert.match(result.error as string, /collision-id/);
    assert.match(result.error as string, /Nothing was changed\./);
    assert.ok(
      !calls.some((call) => call.method === "PATCH"),
      `expected no PATCH; calls were: ${JSON.stringify(calls)}`,
    );
  } finally {
    teardownAccountFixture();
  }
});

test("drive_move_file refuses a trashed file without a PATCH", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === `/drive/v3/files/${MOVE_FILE_ID}`, respond: () => MOVE_TRASHED_FILE },
    ]);

    const result = await callTool(handlers, "drive_move_file", {
      account: ACCOUNT,
      fileId: MOVE_FILE_ID,
      name: "renamed.txt",
    });

    assert.match(result.error as string, /in the trash/);
    assert.ok(
      !calls.some((call) => call.method === "PATCH"),
      `expected no PATCH; calls were: ${JSON.stringify(calls)}`,
    );
  } finally {
    teardownAccountFixture();
  }
});

// --- end-to-end: drive_export_file ---
//
// Same fake-fetch harness. Sheets traffic goes to sheets.googleapis.com, so
// routes for it name the host; a Drive files.get and a Sheets
// spreadsheets.get therefore never collide even though both are GETs.

const SHEETS_HOST = "sheets.googleapis.com";
const SHEET_FILE = { id: "sheet1", name: "Budżet roczny", mimeType: SHEET_MIME };
const SHEET_TRASHED = { ...SHEET_FILE, trashed: true };
const PDF_FILE = { id: "pdf1", name: "faktura.pdf", mimeType: "application/pdf" };
const SHEET_META = {
  sheets: [
    { properties: { title: "stare wpisy", index: 1, sheetId: 22, gridProperties: { rowCount: 3, columnCount: 2 } } },
    { properties: { title: "Arkusz1", index: 0, sheetId: 0, gridProperties: { rowCount: 2, columnCount: 3 } } },
  ],
};
const SHEET_VALUES = { values: [["Nazwisko", "Imię", "Od"], ["Kowalska", "Anna"]] };

function sheetRoutes(fileResponse: unknown = SHEET_FILE): FakeRoute[] {
  return [
    { method: "GET", test: (p) => p === "/drive/v3/files/sheet1", respond: () => fileResponse },
    { method: "GET", host: SHEETS_HOST, test: (p) => p === "/v4/spreadsheets/sheet1", respond: () => SHEET_META },
    {
      method: "GET",
      host: SHEETS_HOST,
      test: (p) => decodeURIComponent(p).startsWith("/v4/spreadsheets/sheet1/values/"),
      respond: () => SHEET_VALUES,
    },
  ];
}

function sheetsCalls(calls: FakeCall[]): FakeCall[] {
  return calls.filter((call) => call.url.hostname === SHEETS_HOST);
}

test("drive_export_file with a token lacking the Drive scope refuses before any network call", async () => {
  setupAccountFixture(false);
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(sheetRoutes());

    const result = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "sheet1" });

    assert.match(result.error as string, /authorized before Octomail requested Drive access/);
    assert.equal(calls.length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_export_file refuses a PDF before any content request", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork([
      { method: "GET", test: (p) => p === "/drive/v3/files/pdf1", respond: () => PDF_FILE },
    ]);

    const result = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "pdf1" });

    assert.match(result.error as string, /application\/pdf, not a Google Sheet or Google Doc/);
    assert.match(result.error as string, /Nothing was changed\.$/);
    assert.equal(sheetsCalls(calls).length, 0);
    assert.ok(calls.every((call) => !call.pathname.endsWith("/export")));
  } finally {
    teardownAccountFixture();
  }
});

test("drive_export_file refuses a trashed Sheet without a Sheets call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(sheetRoutes(SHEET_TRASHED));

    const result = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "sheet1" });

    assert.match(result.error as string, /is in the trash/);
    assert.equal(sheetsCalls(calls).length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_export_file reads the index-0 tab as padded CSV when no sheet is named", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(sheetRoutes());

    const result = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "sheet1" });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.deepEqual(
      calls.map((call) => decodeURIComponent(call.pathname)),
      ["/drive/v3/files/sheet1", "/v4/spreadsheets/sheet1", "/v4/spreadsheets/sheet1/values/'Arkusz1'"],
    );
    const valuesCall = calls[2];
    assert.equal(valuesCall.url.searchParams.get("valueRenderOption"), "FORMATTED_VALUE");
    assert.equal((result.sheet as { title: string }).title, "Arkusz1");
    assert.deepEqual(result.sheets, ["Arkusz1", "stare wpisy"]);
    assert.equal(result.text, "Nazwisko,Imię,Od\nKowalska,Anna,");
    assert.equal(result.kind, "sheet");
    assert.equal(result.format, "csv");
    assert.equal(result.truncated, false);
    assert.equal("savedTo" in result, false);
    assert.equal((result.file as { id: string }).id, "sheet1");
  } finally {
    teardownAccountFixture();
  }
});

test("drive_export_file reads the tab named by sheet", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(sheetRoutes());

    const result = await callTool(handlers, "drive_export_file", {
      account: ACCOUNT,
      fileId: "sheet1",
      sheet: "stare wpisy",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal(decodeURIComponent(calls[2].pathname), "/v4/spreadsheets/sheet1/values/'stare wpisy'");
    assert.equal((result.sheet as { sheetId: number }).sheetId, 22);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_export_file refuses an unknown tab, listing the titles, without a values call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(sheetRoutes());

    const result = await callTool(handlers, "drive_export_file", {
      account: ACCOUNT,
      fileId: "sheet1",
      sheet: "Nieistniejący",
    });

    assert.match(
      result.error as string,
      /Sheet "Nieistniejący" not found in Budżet roczny\. Tabs: "Arkusz1", "stare wpisy"\./,
    );
    assert.ok(calls.every((call) => !call.pathname.includes("/values/")));
  } finally {
    teardownAccountFixture();
  }
});

test("drive_export_file rewrites a Sheets API not-enabled 403 into the setup message", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    installFakeNetwork([
      { method: "GET", test: (p) => p === "/drive/v3/files/sheet1", respond: () => SHEET_FILE },
      {
        method: "GET",
        host: SHEETS_HOST,
        test: (p) => p === "/v4/spreadsheets/sheet1",
        respond: () =>
          fakeReply(403, {
            error: {
              code: 403,
              message: "Google Sheets API has not been used in project 123 before or it is disabled.",
              errors: [{ reason: "accessNotConfigured" }],
            },
          }),
      },
    ]);

    const result = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "sheet1" });

    assert.equal(result.error, describeSheetsApiDisabled());
  } finally {
    teardownAccountFixture();
  }
});

// --- end-to-end: drive_export_file on a Google Doc, the cap and the spill file ---

const DOC_FILE = { id: "doc1", name: "Umowa", mimeType: DOC_MIME };
const DOC_TEXT = "Umowa o dzieło\nParagraf 1\n";
const BIG_DOC_TEXT = Array.from({ length: 3000 }, (_, n) => `Linia ${n}: `.padEnd(99, "x")).join("\n");

function docRoutes(text: string): FakeRoute[] {
  return [
    { method: "GET", test: (p) => p === "/drive/v3/files/doc1", respond: () => DOC_FILE },
    { method: "GET", test: (p) => p === "/drive/v3/files/doc1/export", respond: () => fakeReply(200, text) },
  ];
}

test("drive_export_file reads a Google Doc as plain text through files.export", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(docRoutes(DOC_TEXT));

    const result = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "doc1" });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.deepEqual(
      calls.map((call) => call.pathname),
      ["/drive/v3/files/doc1", "/drive/v3/files/doc1/export"],
    );
    assert.equal(calls[1].url.searchParams.get("mimeType"), "text/plain");
    assert.equal(result.text, DOC_TEXT);
    assert.equal(result.kind, "doc");
    assert.equal(result.format, "text");
    assert.equal("sheets" in result, false);
    assert.equal(result.sizeBytes, Buffer.byteLength(DOC_TEXT));
    assert.equal(result.truncated, false);
    assert.equal(sheetsCalls(calls).length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_export_file refuses sheet on a Google Doc without an export call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(docRoutes(DOC_TEXT));

    const result = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "doc1", sheet: "x" });

    assert.match(result.error as string, /sheet applies only to a Google Sheet/);
    assert.ok(calls.every((call) => !call.pathname.endsWith("/export")));
  } finally {
    teardownAccountFixture();
  }
});

test("drive_export_file truncates a Doc over the cap on a line and writes the full text to the download dir", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    installFakeNetwork(docRoutes(BIG_DOC_TEXT));

    const result = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "doc1" });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal(result.truncated, true);
    const text = result.text as string;
    assert.ok(Buffer.byteLength(text) <= 204800);
    assert.ok(BIG_DOC_TEXT.startsWith(text));
    assert.equal(BIG_DOC_TEXT[text.length], "\n", "the cut must fall right before a newline");
    assert.equal(result.sizeBytes, Buffer.byteLength(BIG_DOC_TEXT));

    const savedTo = result.savedTo as string;
    assert.ok(savedTo.startsWith(path.join(fixtureDir, "downloads", ACCOUNT)), `unexpected savedTo: ${savedTo}`);
    assert.equal(fs.readFileSync(savedTo, "utf8"), BIG_DOC_TEXT);
    assert.equal(fs.statSync(savedTo).mode & 0o777, 0o600);
    assert.ok((result.notice as string).includes(savedTo));
  } finally {
    teardownAccountFixture();
  }
});

test("drive_export_file spills a second export under a fresh name rather than overwriting", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    installFakeNetwork(docRoutes(BIG_DOC_TEXT));

    const first = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "doc1" });
    const firstStat = fs.statSync(first.savedTo as string);
    const second = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "doc1" });

    assert.ok((second.savedTo as string).endsWith("Umowa (2).txt"), `unexpected savedTo: ${second.savedTo}`);
    assert.notEqual(second.savedTo, first.savedTo);
    assert.deepEqual(fs.statSync(first.savedTo as string).mtimeMs, firstStat.mtimeMs);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_export_file still returns the truncated text when the spill file cannot be written", async () => {
  setupAccountFixture();
  try {
    // A regular file where the download root should be: mkdirSync fails.
    fs.writeFileSync(process.env.OCTOMAIL_DOWNLOAD_DIR!, "not a directory");
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    installFakeNetwork(docRoutes(BIG_DOC_TEXT));

    const result = await callTool(handlers, "drive_export_file", { account: ACCOUNT, fileId: "doc1" });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal(result.truncated, true);
    assert.equal("savedTo" in result, false);
    assert.match(result.notice as string, /failed/);
  } finally {
    teardownAccountFixture();
  }
});

// --- end-to-end: drive_copy_file ---
//
// Same fake-fetch harness. These prove the order of operations (scope ->
// assertDriveName -> source files.get -> target files.get -> collision check
// -> files.copy) via the recorded `calls` array, and that no request other
// than the one POST to /copy ever writes anything.

const COPY_SOURCE_ID = "src1";
const COPY_TARGET = { id: "target1", name: "Faktury 2026", mimeType: FOLDER_MIME };
const COPY_SOURCE_PDF = { id: COPY_SOURCE_ID, name: "faktura.pdf", mimeType: "application/pdf", parents: ["mydrive1"] };
const COPY_SOURCE_DOC = { id: COPY_SOURCE_ID, name: "Umowa", mimeType: DOC_MIME, parents: ["mydrive1"] };
const COPY_SOURCE_WITH_DESCRIPTION = { ...COPY_SOURCE_PDF, description: "Saved by Octomail from Gmail account work, message msg1." };
const COPY_SOURCE_FOLDER = { id: COPY_SOURCE_ID, name: "Stare", mimeType: FOLDER_MIME, parents: ["mydrive1"] };
const COPY_SOURCE_TRASHED = { ...COPY_SOURCE_PDF, trashed: true };
const COPY_TARGET_NOT_FOLDER = { id: COPY_TARGET.id, name: "notes.txt", mimeType: "text/plain" };
const COPY_RESULT_PDF = {
  id: "copy1",
  name: "faktura.pdf",
  mimeType: "application/pdf",
  parents: [COPY_TARGET.id],
  webViewLink: "https://drive.google.com/file/d/copy1/view",
};
const COPY_RESULT_DOC = { ...COPY_RESULT_PDF, name: "Umowa", mimeType: DOC_MIME };
const COPY_COLLISION_FILE = {
  id: "collision-copy",
  name: "faktura.pdf",
  mimeType: "application/pdf",
  webViewLink: "https://drive.google.com/file/d/collision-copy/view",
};

const COPY_PATH = `/drive/v3/files/${COPY_SOURCE_ID}/copy`;

function copyRoutes(source: unknown, target: unknown = COPY_TARGET, existing: unknown[] = [], copy: unknown = COPY_RESULT_PDF): FakeRoute[] {
  return [
    { method: "GET", test: (p) => p === `/drive/v3/files/${COPY_SOURCE_ID}`, respond: () => source },
    { method: "GET", test: (p) => p === `/drive/v3/files/${COPY_TARGET.id}`, respond: () => target },
    { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: existing }) },
    { method: "POST", test: (p) => p === COPY_PATH, respond: () => copy },
  ];
}

function copyCall(calls: FakeCall[]): FakeCall | undefined {
  return calls.find((call) => call.method === "POST" && call.pathname === COPY_PATH);
}

function assertNoWrite(calls: FakeCall[]): void {
  assert.ok(
    !calls.some((call) => call.method !== "GET"),
    `expected only GET requests; calls were: ${JSON.stringify(calls)}`,
  );
}

test("drive_copy_file with a token lacking the Drive scope refuses before any network call", async () => {
  setupAccountFixture(false);
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(copyRoutes(COPY_SOURCE_PDF));

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
    });

    assert.match(result.error as string, /npm run auth -- --account work/);
    assert.match(result.error as string, /Nothing was copied\.$/);
    assert.deepEqual(calls, []);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_copy_file with an invalid newName refuses before any network call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(copyRoutes(COPY_SOURCE_PDF));

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
      newName: "a/b.pdf",
    });

    assert.match(result.error as string, /cannot contain "\/"/);
    assert.match(result.error as string, /Nothing was copied\.$/);
    assert.deepEqual(calls, []);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_copy_file refuses a folder as the source before looking at the target", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(copyRoutes(COPY_SOURCE_FOLDER));

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
    });

    assert.match(result.error as string, new RegExp(`File ${COPY_SOURCE_ID} is a folder`));
    assert.match(result.error as string, /Nothing was copied\.$/);
    assert.ok(
      !calls.some((call) => call.pathname === `/drive/v3/files/${COPY_TARGET.id}`),
      `expected no target lookup; calls were: ${JSON.stringify(calls)}`,
    );
    assertNoWrite(calls);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_copy_file refuses a trashed source without a copy call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(copyRoutes(COPY_SOURCE_TRASHED));

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
    });

    assert.match(result.error as string, /in the trash/);
    assert.match(result.error as string, /Nothing was copied\.$/);
    assertNoWrite(calls);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_copy_file refuses a target that is not a folder without a copy call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(copyRoutes(COPY_SOURCE_PDF, COPY_TARGET_NOT_FOLDER));

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
    });

    assert.match(result.error as string, /is not a folder \(mimeType text\/plain\)/);
    assert.match(result.error as string, /Nothing was copied\.$/);
    assertNoWrite(calls);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_copy_file refuses on a name collision in the target folder, naming the existing file, without a copy call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(copyRoutes(COPY_SOURCE_PDF, COPY_TARGET, [COPY_COLLISION_FILE]));

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
    });

    assert.match(result.error as string, /A file named "faktura\.pdf" already exists in that folder \(id collision-copy/);
    assert.match(result.error as string, /Pass a different newName\. Nothing was copied\.$/);
    assertNoWrite(calls);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_copy_file copies a binary file into the target folder under the source name with a provenance description", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(copyRoutes(COPY_SOURCE_PDF));

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    const file = result.file as { id: string; name: string; mimeType: string; parents: string[]; webViewLink: string };
    assert.equal(file.id, "copy1");
    assert.equal(file.name, "faktura.pdf");
    assert.equal(file.mimeType, "application/pdf");
    assert.deepEqual(file.parents, [COPY_TARGET.id]);
    assert.equal(file.webViewLink, COPY_RESULT_PDF.webViewLink);
    assert.equal(result.sourceFileId, COPY_SOURCE_ID);

    const call = copyCall(calls);
    assert.ok(call?.body, `expected a POST to ${COPY_PATH} with a body; calls were: ${JSON.stringify(calls)}`);
    const body = JSON.parse(call!.body!) as { name: string; parents: string[]; description: string; mimeType?: string };
    assert.equal(body.name, "faktura.pdf");
    assert.deepEqual(body.parents, [COPY_TARGET.id]);
    assert.match(body.description, /^Copied by Octomail from faktura\.pdf \(src1\) on \d{4}-\d{2}-\d{2}T[\d:.]+Z\.$/);
    assert.equal(body.mimeType, undefined);

    // The source is never touched: no PATCH, no DELETE, and the only POST is the copy.
    assert.deepEqual(
      calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.pathname}`),
      [`POST ${COPY_PATH}`],
    );
  } finally {
    teardownAccountFixture();
  }
});

test("drive_copy_file copies a Google Doc as a Google Doc", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(copyRoutes(COPY_SOURCE_DOC, COPY_TARGET, [], COPY_RESULT_DOC));

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    const file = result.file as { name: string; mimeType: string; isFolder: boolean };
    assert.equal(file.name, "Umowa");
    assert.equal(file.mimeType, DOC_MIME);
    assert.equal(file.isFolder, false);

    const body = JSON.parse(copyCall(calls)!.body!) as { name: string; mimeType?: string };
    assert.equal(body.name, "Umowa");
    assert.equal(body.mimeType, undefined);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_copy_file applies newName to the collision check and the copy", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(
      copyRoutes(COPY_SOURCE_PDF, COPY_TARGET, [], { ...COPY_RESULT_PDF, name: "2026-09 faktura.pdf" }),
    );

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
      newName: "2026-09 faktura.pdf",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal((result.file as { name: string }).name, "2026-09 faktura.pdf");

    const listCall = calls.find((call) => call.method === "GET" && call.pathname === "/drive/v3/files");
    assert.ok(listCall, `expected a collision check; calls were: ${JSON.stringify(calls)}`);
    assert.equal(
      listCall!.url.searchParams.get("q"),
      `name = '2026-09 faktura.pdf' and '${COPY_TARGET.id}' in parents and trashed = false`,
    );

    const body = JSON.parse(copyCall(calls)!.body!) as { name: string; description: string };
    assert.equal(body.name, "2026-09 faktura.pdf");
    // Provenance names the source as it was, not the new name.
    assert.match(body.description, /from faktura\.pdf \(src1\)/);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_copy_file keeps the source's existing description and appends the provenance line", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(copyRoutes(COPY_SOURCE_WITH_DESCRIPTION));

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    const body = JSON.parse(copyCall(calls)!.body!) as { description: string };
    assert.ok(body.description.startsWith("Saved by Octomail from Gmail account work, message msg1.\n"));
    assert.match(body.description, /\nCopied by Octomail from faktura\.pdf \(src1\) on .+Z\.$/);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_copy_file passes supportsAllDrives=true on every request it makes", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTools(server);
    const { calls } = installFakeNetwork(copyRoutes(COPY_SOURCE_PDF));

    const result = await callTool(handlers, "drive_copy_file", {
      account: ACCOUNT,
      fileId: COPY_SOURCE_ID,
      targetFolderId: COPY_TARGET.id,
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.pathname}`),
      [
        `GET /drive/v3/files/${COPY_SOURCE_ID}`,
        `GET /drive/v3/files/${COPY_TARGET.id}`,
        "GET /drive/v3/files",
        `POST ${COPY_PATH}`,
      ],
    );
    for (const call of calls) {
      assert.equal(
        call.url.searchParams.get("supportsAllDrives"),
        "true",
        `expected supportsAllDrives=true on ${call.method} ${call.pathname}`,
      );
    }
    // The source lookup asks for its description, so the copy can carry it forward.
    assert.match(calls[0].url.searchParams.get("fields") ?? "", /description/);
  } finally {
    teardownAccountFixture();
  }
});
