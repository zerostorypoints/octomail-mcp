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

type FakeCall = { method: string; pathname: string; url: URL };
type FakeRoute = { method: string; test: (pathname: string) => boolean; respond: (url: URL) => unknown };

function installFakeNetwork(routes: FakeRoute[]): { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  google.options({
    fetchImplementation: async (url: unknown, opts?: { method?: string }) => {
      const parsed = new URL(String(url));
      const method = (opts?.method ?? "GET").toUpperCase();
      calls.push({ method, pathname: parsed.pathname, url: parsed });

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
