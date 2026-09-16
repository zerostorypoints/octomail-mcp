import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DRIVE_SCOPE } from "./gmail.js";
import { DOC_MIME, FOLDER_MIME, SHEET_MIME } from "./drive.js";
import {
  DOWNLOAD_DEFAULT_MAX_BYTES,
  UPLOAD_MAX_BYTES,
  assertLocalFilename,
  conversionTargetFor,
  registerDriveTransferTools,
  resolveOutDir,
  uploadMimeType,
  verifyDownloadedBytes,
} from "./drive-transfer.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function md5(content: Buffer | string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

// --- uploadMimeType ---

test("uploadMimeType maps a .docx by extension, case-insensitively", () => {
  assert.equal(uploadMimeType("contract-template.DOCX"), DOCX_MIME);
});

test("uploadMimeType maps a .pdf and a .csv", () => {
  assert.equal(uploadMimeType("report.pdf"), "application/pdf");
  assert.equal(uploadMimeType("rows.csv"), "text/csv");
});

test("uploadMimeType falls back to application/octet-stream for an unknown or missing extension", () => {
  assert.equal(uploadMimeType("archive.xyz"), "application/octet-stream");
  assert.equal(uploadMimeType("README"), "application/octet-stream");
});

// --- conversionTargetFor ---

test("conversionTargetFor sends word-processing formats to a Google Doc", () => {
  for (const name of ["a.docx", "a.doc", "a.odt", "a.rtf", "a.txt"]) {
    assert.equal(conversionTargetFor(name), DOC_MIME, name);
  }
});

test("conversionTargetFor sends spreadsheet formats to a Google Sheet", () => {
  for (const name of ["a.xlsx", "a.xls", "a.ods", "a.CSV"]) {
    assert.equal(conversionTargetFor(name), SHEET_MIME, name);
  }
});

test("conversionTargetFor returns undefined for a format Drive is not asked to convert", () => {
  assert.equal(conversionTargetFor("a.pdf"), undefined);
  assert.equal(conversionTargetFor("a.png"), undefined);
});

// --- assertLocalFilename ---

test("assertLocalFilename accepts a plain name with spaces and non-ASCII letters", () => {
  assert.doesNotThrow(() => assertLocalFilename("Zażółć notatki.docx", "Nothing was downloaded."));
});

test("assertLocalFilename refuses a traversal, a separator and a leading dot, suggesting a plain name", () => {
  assert.throws(() => assertLocalFilename("../escape.docx", "Nothing was downloaded."), /plain file name.*"escape\.docx".*Nothing was downloaded\.$/);
  assert.throws(() => assertLocalFilename("sub/file.docx", "Nothing was downloaded."), /plain file name/);
  assert.throws(() => assertLocalFilename("..", "Nothing was downloaded."), /plain file name/);
});

// --- resolveOutDir ---

function withRoot(fn: (root: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-outdir-"));
  try {
    fn(path.join(base, "work"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test("resolveOutDir defaults to the account directory itself, creating it", () => {
  withRoot((root) => {
    assert.equal(resolveOutDir(undefined, root, "Nothing was downloaded."), fs.realpathSync(root));
  });
});

test("resolveOutDir accepts a relative subdirectory and an absolute path inside the root without creating the subdirectory yet", () => {
  withRoot((root) => {
    const relative = resolveOutDir("contracts/2026", root, "Nothing was downloaded.");
    assert.equal(relative, path.join(fs.realpathSync(root), "contracts", "2026"));
    assert.equal(fs.existsSync(relative), false);
    assert.equal(resolveOutDir(path.join(root, "contracts"), root, "Nothing was downloaded."), path.join(fs.realpathSync(root), "contracts"));
  });
});

test("resolveOutDir refuses ../ and an absolute path outside the root", () => {
  withRoot((root) => {
    assert.throws(() => resolveOutDir("../personal", root, "Nothing was downloaded."), /outside the account's download directory.*Nothing was downloaded\.$/);
    assert.throws(() => resolveOutDir(os.tmpdir(), root, "Nothing was downloaded."), /outside the account's download directory/);
  });
});

test("resolveOutDir refuses a symlinked subdirectory pointing outside the root", () => {
  withRoot((root) => {
    fs.mkdirSync(root, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-outside-"));
    try {
      fs.symlinkSync(outside, path.join(root, "link"));
      assert.throws(() => resolveOutDir("link/new", root, "Nothing was downloaded."), /outside the account's download directory/);
      assert.equal(fs.existsSync(path.join(outside, "new")), false, "nothing was created outside the root");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// --- verifyDownloadedBytes ---

const BINARY_FILE = { id: "bin1", name: "report.pdf", mimeType: "application/pdf", isFolder: false };

test("verifyDownloadedBytes reports a matching size and md5", () => {
  const bytes = Buffer.from("fake pdf bytes");
  const verdict = verifyDownloadedBytes(bytes, { ...BINARY_FILE, sizeBytes: bytes.length, md5Checksum: md5(bytes) }, "Nothing was downloaded.");
  assert.deepEqual(verdict, { sizeBytes: bytes.length, md5Checksum: md5(bytes), verified: { size: true, md5: true } });
});

test("verifyDownloadedBytes marks a check unavailable when Drive reports no size or md5", () => {
  const bytes = Buffer.from("fake pdf bytes");
  const verdict = verifyDownloadedBytes(bytes, BINARY_FILE, "Nothing was downloaded.");
  assert.deepEqual(verdict.verified, { size: "unavailable", md5: "unavailable" });
});

test("verifyDownloadedBytes throws on a size mismatch, naming both sizes", () => {
  const bytes = Buffer.from("short");
  assert.throws(
    () => verifyDownloadedBytes(bytes, { ...BINARY_FILE, sizeBytes: 999 }, "Nothing was downloaded."),
    /5 bytes, but Drive reports 999.*Nothing was downloaded\.$/,
  );
});

test("verifyDownloadedBytes throws on an md5 mismatch, naming both checksums", () => {
  const bytes = Buffer.from("fake pdf bytes");
  assert.throws(
    () => verifyDownloadedBytes(bytes, { ...BINARY_FILE, sizeBytes: bytes.length, md5Checksum: "0".repeat(32) }, "Nothing was downloaded."),
    new RegExp(`md5 ${md5(bytes)}, but Drive reports ${"0".repeat(32)}`),
  );
});

// --- end-to-end: registerDriveTransferTools against a fake Drive network ---
//
// Same fake-fetch harness as src/drive.test.ts (test files in this repo do not
// import each other, so it is copied rather than shared), with one addition:
// a FakeReply whose body is a Buffer goes out as application/octet-stream,
// which is what files.get with alt=media returns.

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
type FakeRoute = {
  method: string;
  test: (pathname: string) => boolean;
  respond: (url: URL) => unknown;
};

class FakeReply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

function fakeReply(status: number, body: unknown): FakeReply {
  return new FakeReply(status, body);
}

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

      const reply = route.respond(parsed);
      if (reply instanceof FakeReply) {
        if (Buffer.isBuffer(reply.body)) {
          return new Response(reply.body, { status: reply.status, headers: { "content-type": "application/octet-stream" } });
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
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-drive-transfer-test-"));
  process.env.OCTOMAIL_ACCOUNTS_FILE = path.join(fixtureDir, "accounts.json");
  process.env.OCTOMAIL_TOKEN_DIR = path.join(fixtureDir, "tokens");
  process.env.OCTOMAIL_DOWNLOAD_DIR = path.join(fixtureDir, "downloads");
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

  fs.mkdirSync(process.env.OCTOMAIL_TOKEN_DIR, { recursive: true });
  fs.mkdirSync(accountDir(), { recursive: true });
  fs.writeFileSync(process.env.OCTOMAIL_ACCOUNTS_FILE, JSON.stringify({ accounts: { [ACCOUNT]: {}, personal: {} } }));

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

function accountDir(account = ACCOUNT): string {
  return path.join(fixtureDir, "downloads", account);
}

// --- end-to-end: drive_upload_file ---

const SHARED_FOLDER = { id: "sharedFolder", name: "Templates", mimeType: FOLDER_MIME, parents: ["sharedDrive1"] };
const DOCX_BYTES = Buffer.from("PK fake docx bytes for an upload test");

function uploadRoutes(options: { existing?: unknown[]; created?: Record<string, unknown> } = {}): FakeRoute[] {
  return [
    { method: "GET", test: (p) => p === "/drive/v3/files/sharedFolder", respond: () => SHARED_FOLDER },
    { method: "GET", test: (p) => p === "/drive/v3/files", respond: () => ({ files: options.existing ?? [] }) },
    {
      method: "POST",
      test: (p) => p === "/upload/drive/v3/files",
      respond: () =>
        options.created ?? {
          id: "up1",
          name: "contract-template.docx",
          mimeType: DOCX_MIME,
          size: String(DOCX_BYTES.length),
          parents: ["sharedFolder"],
          webViewLink: "https://x/up1",
          md5Checksum: md5(DOCX_BYTES),
        },
    },
  ];
}

function writeLocal(name: string, content: Buffer | string, account = ACCOUNT): string {
  const target = path.join(accountDir(account), name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test("drive_upload_file with a token lacking the Drive scope refuses before any network call", async () => {
  setupAccountFixture(false);
  try {
    writeLocal("contract-template.docx", DOCX_BYTES);
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(uploadRoutes());

    const result = await callTool(handlers, "drive_upload_file", {
      account: ACCOUNT,
      filePath: "contract-template.docx",
      folderId: "sharedFolder",
    });

    assert.match(result.error as string, /authorized before Octomail requested Drive access/);
    assert.match(result.error as string, /Nothing was uploaded\./);
    assert.equal(calls.length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_upload_file refuses an absolute path outside the account directory, another account's file and ../, with no network call", async () => {
  setupAccountFixture();
  try {
    const otherAccountFile = writeLocal("private.docx", DOCX_BYTES, "personal");
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(uploadRoutes());

    const outside = await callTool(handlers, "drive_upload_file", { account: ACCOUNT, filePath: "/etc/hosts", folderId: "sharedFolder" });
    assert.match(outside.error as string, /resolves outside .*download directory.*Nothing was uploaded\./);

    const otherAccount = await callTool(handlers, "drive_upload_file", { account: ACCOUNT, filePath: otherAccountFile, folderId: "sharedFolder" });
    assert.match(otherAccount.error as string, /resolves outside/);

    const traversal = await callTool(handlers, "drive_upload_file", {
      account: ACCOUNT,
      filePath: "../personal/private.docx",
      folderId: "sharedFolder",
    });
    assert.match(traversal.error as string, /resolves outside/);

    assert.equal(calls.length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_upload_file refuses a missing local file and a directory with no network call", async () => {
  setupAccountFixture();
  try {
    fs.mkdirSync(path.join(accountDir(), "subdir"));
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(uploadRoutes());

    const missing = await callTool(handlers, "drive_upload_file", { account: ACCOUNT, filePath: "absent.docx", folderId: "sharedFolder" });
    assert.match(missing.error as string, /does not exist inside/);

    const directory = await callTool(handlers, "drive_upload_file", { account: ACCOUNT, filePath: "subdir", folderId: "sharedFolder" });
    assert.match(directory.error as string, /is not a regular file.*Nothing was uploaded\./);

    assert.equal(calls.length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_upload_file refuses a file over the 5 MB multipart limit with no network call", async () => {
  setupAccountFixture();
  try {
    writeLocal("big.pdf", Buffer.alloc(UPLOAD_MAX_BYTES + 1));
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(uploadRoutes());

    const result = await callTool(handlers, "drive_upload_file", { account: ACCOUNT, filePath: "big.pdf", folderId: "sharedFolder" });

    assert.match(result.error as string, new RegExp(`${UPLOAD_MAX_BYTES + 1} bytes, over the ${UPLOAD_MAX_BYTES}-byte`));
    assert.match(result.error as string, /resumable/);
    assert.equal(calls.length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_upload_file refuses when a same-named file exists in the folder, naming it, and uploads nothing", async () => {
  setupAccountFixture();
  try {
    writeLocal("contract-template.docx", DOCX_BYTES);
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(
      uploadRoutes({ existing: [{ id: "old1", name: "contract-template.docx", mimeType: DOCX_MIME, webViewLink: "https://x/old1" }] }),
    );

    const result = await callTool(handlers, "drive_upload_file", {
      account: ACCOUNT,
      filePath: "contract-template.docx",
      folderId: "sharedFolder",
    });

    assert.match(result.error as string, /A file named "contract-template\.docx" already exists in that folder \(id old1, https:\/\/x\/old1\)/);
    assert.match(result.error as string, /Nothing was uploaded\.$/);
    assert.ok(!calls.some((call) => call.method === "POST"));
  } finally {
    teardownAccountFixture();
  }
});

test("drive_upload_file uploads into a shared-drive folder with all-drives params and returns the Drive file shape", async () => {
  setupAccountFixture();
  try {
    const local = writeLocal("contract-template.docx", DOCX_BYTES);
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(uploadRoutes());

    const result = await callTool(handlers, "drive_upload_file", {
      account: ACCOUNT,
      filePath: local,
      folderId: "sharedFolder",
      description: "Template for review",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.deepEqual(result.file, {
      id: "up1",
      name: "contract-template.docx",
      mimeType: DOCX_MIME,
      isFolder: false,
      sizeBytes: DOCX_BYTES.length,
      parents: ["sharedFolder"],
      webViewLink: "https://x/up1",
      md5Checksum: md5(DOCX_BYTES),
    });
    assert.equal(result.converted, false);
    assert.deepEqual(result.source, { path: fs.realpathSync(local), sizeBytes: DOCX_BYTES.length, mimeType: DOCX_MIME });

    const lookup = calls.find((call) => call.method === "GET" && call.pathname === "/drive/v3/files");
    assert.match(lookup?.url.searchParams.get("q") ?? "", /name = 'contract-template\.docx' and 'sharedFolder' in parents/);

    const upload = calls.find((call) => call.method === "POST" && call.pathname === "/upload/drive/v3/files");
    assert.ok(upload, "an upload request was sent");
    assert.equal(upload.url.searchParams.get("supportsAllDrives"), "true");
    assert.equal(upload.url.searchParams.get("uploadType"), "multipart");
    assert.ok(upload.body?.includes('"parents":["sharedFolder"]'), upload.body);
    assert.ok(upload.body?.includes('"name":"contract-template.docx"'), upload.body);
    assert.ok(upload.body?.includes('"description":"Template for review"'), upload.body);
    assert.ok(!upload.body?.includes('"mimeType"'), "no conversion target in the metadata");
    assert.ok(upload.body?.includes(`content-type: ${DOCX_MIME}`), upload.body);
    assert.ok(upload.body?.includes(DOCX_BYTES.toString("utf8")), "the file bytes are in the upload body");
    assert.equal(calls.filter((call) => call.method !== "GET").length, 1, "one write, nothing else");
  } finally {
    teardownAccountFixture();
  }
});

test("drive_upload_file with convertToGoogleDoc asks Drive for a Google Doc and drops the extension from the default name", async () => {
  setupAccountFixture();
  try {
    writeLocal("contract-template.docx", DOCX_BYTES);
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(
      uploadRoutes({
        created: { id: "doc1", name: "contract-template", mimeType: DOC_MIME, parents: ["sharedFolder"], webViewLink: "https://x/doc1" },
      }),
    );

    const result = await callTool(handlers, "drive_upload_file", {
      account: ACCOUNT,
      filePath: "contract-template.docx",
      folderId: "sharedFolder",
      convertToGoogleDoc: true,
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal(result.converted, true);
    assert.equal((result.file as { mimeType: string }).mimeType, DOC_MIME);

    const lookup = calls.find((call) => call.method === "GET" && call.pathname === "/drive/v3/files");
    assert.match(lookup?.url.searchParams.get("q") ?? "", /name = 'contract-template' and/);

    const upload = calls.find((call) => call.method === "POST");
    assert.ok(upload?.body?.includes(`"mimeType":"${DOC_MIME}"`), upload?.body);
    assert.ok(upload?.body?.includes('"name":"contract-template"'), upload?.body);
    assert.ok(upload?.body?.includes(`content-type: ${DOCX_MIME}`), "the source part keeps the .docx type");
  } finally {
    teardownAccountFixture();
  }
});

test("drive_upload_file with convertToGoogleDoc keeps an explicit name as given", async () => {
  setupAccountFixture();
  try {
    writeLocal("rows.csv", "a,b\n1,2\n");
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(
      uploadRoutes({ created: { id: "sh1", name: "Imported rows.csv", mimeType: SHEET_MIME, parents: ["sharedFolder"] } }),
    );

    const result = await callTool(handlers, "drive_upload_file", {
      account: ACCOUNT,
      filePath: "rows.csv",
      folderId: "sharedFolder",
      name: "Imported rows.csv",
      convertToGoogleDoc: true,
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    const upload = calls.find((call) => call.method === "POST");
    assert.ok(upload?.body?.includes(`"mimeType":"${SHEET_MIME}"`), upload?.body);
    assert.ok(upload?.body?.includes('"name":"Imported rows.csv"'), upload?.body);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_upload_file with convertToGoogleDoc refuses a format that does not convert, with no network call", async () => {
  setupAccountFixture();
  try {
    writeLocal("report.pdf", "fake pdf");
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(uploadRoutes());

    const result = await callTool(handlers, "drive_upload_file", {
      account: ACCOUNT,
      filePath: "report.pdf",
      folderId: "sharedFolder",
      convertToGoogleDoc: true,
    });

    assert.match(result.error as string, /report\.pdf cannot be converted.*\.docx.*\.csv.*Nothing was uploaded\.$/);
    assert.equal(calls.length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_upload_file refuses a name with a slash before any network call", async () => {
  setupAccountFixture();
  try {
    writeLocal("contract-template.docx", DOCX_BYTES);
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(uploadRoutes());

    const result = await callTool(handlers, "drive_upload_file", {
      account: ACCOUNT,
      filePath: "contract-template.docx",
      folderId: "sharedFolder",
      name: "a/b.docx",
    });

    assert.match(result.error as string, /cannot contain "\/".*Nothing was uploaded\./);
    assert.equal(calls.length, 0);
  } finally {
    teardownAccountFixture();
  }
});

// --- end-to-end: drive_download_file ---

const PDF_BYTES = Buffer.from("%PDF-1.7 fake binary content   end");

function binaryMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bin1",
    name: "Signed contract.pdf",
    mimeType: "application/pdf",
    size: String(PDF_BYTES.length),
    md5Checksum: md5(PDF_BYTES),
    parents: ["sharedFolder"],
    webViewLink: "https://x/bin1",
    ...overrides,
  };
}

function downloadRoutes(meta: Record<string, unknown>, content: Buffer = PDF_BYTES): FakeRoute[] {
  return [
    {
      method: "GET",
      test: (p) => p === `/drive/v3/files/${String(meta.id)}`,
      respond: (url) => (url.searchParams.get("alt") === "media" ? fakeReply(200, content) : meta),
    },
  ];
}

function mediaCalls(calls: FakeCall[]): FakeCall[] {
  return calls.filter((call) => call.url.searchParams.get("alt") === "media");
}

test("drive_download_file with a token lacking the Drive scope refuses before any network call", async () => {
  setupAccountFixture(false);
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(downloadRoutes(binaryMeta()));

    const result = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "bin1" });

    assert.match(result.error as string, /authorized before Octomail requested Drive access/);
    assert.match(result.error as string, /Nothing was downloaded\./);
    assert.equal(calls.length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_download_file writes the file under the account directory, verifies size and md5, and returns the path, not the bytes", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(downloadRoutes(binaryMeta()));

    const result = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "bin1" });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    const expectedPath = path.join(fs.realpathSync(accountDir()), "Signed contract.pdf");
    assert.equal(result.savedTo, expectedPath);
    assert.deepEqual(fs.readFileSync(expectedPath), PDF_BYTES);
    assert.equal(fs.statSync(expectedPath).mode & 0o777, 0o600);
    assert.equal(result.sizeBytes, PDF_BYTES.length);
    assert.equal(result.md5Checksum, md5(PDF_BYTES));
    assert.deepEqual(result.verified, { size: true, md5: true });
    assert.equal((result.file as { id: string }).id, "bin1");
    assert.deepEqual(Object.keys(result).sort(), ["file", "md5Checksum", "savedTo", "sizeBytes", "verified"]);
    assert.ok(!JSON.stringify(result).includes("fake binary content"), "the content is not in the tool result");

    const media = mediaCalls(calls);
    assert.equal(media.length, 1);
    assert.equal(media[0].url.searchParams.get("supportsAllDrives"), "true");
    assert.ok(calls.every((call) => call.method === "GET"), "a download never writes to Drive");
  } finally {
    teardownAccountFixture();
  }
});

test("drive_download_file writes into an outDir subdirectory under a given name, creating the directory", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    installFakeNetwork(downloadRoutes(binaryMeta()));

    const result = await callTool(handlers, "drive_download_file", {
      account: ACCOUNT,
      fileId: "bin1",
      outDir: "contracts/2026",
      name: "copy.pdf",
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    const expectedPath = path.join(fs.realpathSync(accountDir()), "contracts", "2026", "copy.pdf");
    assert.equal(result.savedTo, expectedPath);
    assert.deepEqual(fs.readFileSync(expectedPath), PDF_BYTES);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_download_file refuses a Google Doc, pointing at drive_export_file, without fetching content", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const meta = { id: "gdoc1", name: "Meeting notes", mimeType: DOC_MIME, parents: ["sharedFolder"] };
    const { calls } = installFakeNetwork(downloadRoutes(meta));

    const result = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "gdoc1" });

    assert.match(result.error as string, /File gdoc1 \("Meeting notes"\) is application\/vnd\.google-apps\.document/);
    assert.match(result.error as string, /drive_export_file/);
    assert.match(result.error as string, /Nothing was downloaded\.$/);
    assert.equal(mediaCalls(calls).length, 0);
    assert.deepEqual(fs.readdirSync(accountDir()), []);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_download_file refuses a folder without fetching content", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(downloadRoutes(SHARED_FOLDER));

    const result = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "sharedFolder" });

    assert.match(result.error as string, /is a folder.*Nothing was downloaded\.$/);
    assert.equal(mediaCalls(calls).length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_download_file refuses a file larger than maxBytes before fetching content", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(downloadRoutes(binaryMeta()));

    const result = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "bin1", maxBytes: 10 });

    assert.match(result.error as string, new RegExp(`is ${PDF_BYTES.length} bytes, over maxBytes 10`));
    assert.equal(mediaCalls(calls).length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_download_file's default cap is 100 MB", async () => {
  setupAccountFixture();
  try {
    assert.equal(DOWNLOAD_DEFAULT_MAX_BYTES, 100 * 1024 * 1024);
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(downloadRoutes(binaryMeta({ size: String(DOWNLOAD_DEFAULT_MAX_BYTES + 1) })));

    const result = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "bin1" });

    assert.match(result.error as string, new RegExp(`over maxBytes ${DOWNLOAD_DEFAULT_MAX_BYTES}`));
    assert.equal(mediaCalls(calls).length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_download_file refuses when the local file already exists, leaving it untouched and fetching no content", async () => {
  setupAccountFixture();
  try {
    const existing = writeLocal("Signed contract.pdf", "earlier local copy");
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(downloadRoutes(binaryMeta()));

    const result = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "bin1" });

    assert.match(result.error as string, /already exists.*Pass a different name.*Nothing was downloaded\.$/);
    assert.equal(fs.readFileSync(existing, "utf8"), "earlier local copy");
    assert.equal(mediaCalls(calls).length, 0);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_download_file writes nothing when the md5 does not match Drive's", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    installFakeNetwork(downloadRoutes(binaryMeta({ md5Checksum: "f".repeat(32) })));

    const result = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "bin1" });

    assert.match(result.error as string, /but Drive reports f{32}/);
    assert.deepEqual(fs.readdirSync(accountDir()), []);
  } finally {
    teardownAccountFixture();
  }
});

test("drive_download_file refuses an outDir outside the account directory and a name with a path, with no network call", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    const { calls } = installFakeNetwork(downloadRoutes(binaryMeta()));

    const traversal = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "bin1", outDir: "../personal" });
    assert.match(traversal.error as string, /outside the account's download directory/);

    const absolute = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "bin1", outDir: os.tmpdir() });
    assert.match(absolute.error as string, /outside the account's download directory/);

    const badName = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "bin1", name: "../../escape.pdf" });
    assert.match(badName.error as string, /plain file name/);

    assert.equal(calls.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(fixtureDir, "downloads")), [ACCOUNT], "no directory was created outside the account's own");
  } finally {
    teardownAccountFixture();
  }
});

test("drive_download_file sanitises a Drive name that is not a safe local file name", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDriveTransferTools(server);
    installFakeNetwork(downloadRoutes(binaryMeta({ name: "Q1: summary?.pdf" })));

    const result = await callTool(handlers, "drive_download_file", { account: ACCOUNT, fileId: "bin1" });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal(path.basename(result.savedTo as string), "Q1_ summary_.pdf");
  } finally {
    teardownAccountFixture();
  }
});
