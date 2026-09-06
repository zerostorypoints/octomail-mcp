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
  FOLDER_MIME,
  assertDriveName,
  assertDriveScope,
  assertListInput,
  assertMoveInput,
  childrenQuery,
  escapeDriveQueryValue,
  exactNameInFolderQuery,
  fileProjection,
  missingDriveScope,
  nameContainsQuery,
  provenanceDescription,
  registerDriveTools,
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

// --- assertDriveScope ---

test("assertDriveScope is exported as a function", () => {
  assert.equal(typeof assertDriveScope, "function");
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
type FakeRoute = { method: string; test: (pathname: string) => boolean; respond: (url: URL) => unknown };

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

      const route = routes.find((candidate) => candidate.method === method && candidate.test(parsed.pathname));
      if (!route) {
        return new Response(
          JSON.stringify({ error: { code: 404, message: `no fake route for ${method} ${parsed.pathname}` } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify(route.respond(parsed)), {
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
