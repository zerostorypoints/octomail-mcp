import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDraftTools } from "./drafts.js";
import { registerFilterTools } from "./filters.js";
import { registerLabelTools } from "./labels.js";

// src/tools.test.ts only exercises assertDestructiveLabelsConfirmed as a pure
// function. It says nothing about whether the guard is actually wired into
// the tool handlers — a refactor that moved the call below batchModify, or
// dropped it from one call site, would still pass that suite. These tests
// call the real registered handlers end to end and check the guard's
// observable effect: the destructive call is refused and the mutating Gmail
// API method is never reached.
//
// registerFilterTools/registerLabelTools have no dependency-injection seam
// for the Gmail client — they call gmailForAccount directly, imported from
// "./gmail.js" — unlike doctor.ts's checkAccounts(getGmailClient = ...).
// Rather than add one (a production change made purely to ease testing),
// this file fakes the network boundary that the "googleapis" package itself
// exposes for exactly this purpose: google.options({ fetchImplementation })
// is merged by googleapis-common into every request made through the shared
// `google` singleton (gaxios reads `opts.fetchImplementation || fetch`), so
// a fake fetch here intercepts calls made by production code without
// changing it. A stubbed account token with a far-future expiry_date means
// OAuth2Client never needs to refresh, so no real network call happens
// anywhere in the chain. No mocking library involved — this is a hand-rolled
// fake, same as the rest of the suite.

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

type FakeCall = { method: string; pathname: string };
type FakeRoute = { method: string; test: (pathname: string) => boolean; respond: (url: URL) => unknown };

function installFakeGmailNetwork(routes: FakeRoute[]): { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  google.options({
    fetchImplementation: async (url: unknown, opts?: { method?: string }) => {
      const parsed = new URL(String(url));
      const method = (opts?.method ?? "GET").toUpperCase();
      calls.push({ method, pathname: parsed.pathname });

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

function setupAccountFixture(allowedRecipients?: string[]): void {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "octomail-gate-test-"));
  process.env.OCTOMAIL_ACCOUNTS_FILE = path.join(fixtureDir, "accounts.json");
  process.env.OCTOMAIL_TOKEN_DIR = path.join(fixtureDir, "tokens");
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

  fs.mkdirSync(process.env.OCTOMAIL_TOKEN_DIR, { recursive: true });
  fs.writeFileSync(
    process.env.OCTOMAIL_ACCOUNTS_FILE,
    JSON.stringify({ accounts: { [ACCOUNT]: allowedRecipients ? { allowedRecipients } : {} } }),
  );
  fs.writeFileSync(
    path.join(process.env.OCTOMAIL_TOKEN_DIR, `${ACCOUNT}.json`),
    JSON.stringify({
      access_token: "fake-access-token",
      refresh_token: "fake-refresh-token",
      // All four scopes, so gmailWithFilterScope's pre-flight check passes.
      scope: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.settings.basic",
      ].join(" "),
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

const TRASH_FILTER_ID = "filter1";
const TRASH_FILTER = {
  id: TRASH_FILTER_ID,
  criteria: { from: "spam@example.com" },
  action: { addLabelIds: ["TRASH"] },
};

const LABELS = [
  { id: "TRASH", name: "TRASH", type: "system" },
  { id: "INBOX", name: "INBOX", type: "system" },
];

test("gmail_backfill_filter with apply: true and no confirm refuses a filter that adds TRASH, and never calls batchModify", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerFilterTools(server);

    const { calls } = installFakeGmailNetwork([
      {
        method: "GET",
        test: (p) => p === `/gmail/v1/users/me/settings/filters/${TRASH_FILTER_ID}`,
        respond: () => TRASH_FILTER,
      },
      { method: "GET", test: (p) => p === "/gmail/v1/users/me/labels", respond: () => ({ labels: LABELS }) },
    ]);

    const result = await callTool(handlers, "gmail_backfill_filter", {
      account: ACCOUNT,
      filterId: TRASH_FILTER_ID,
      apply: true,
    });

    assert.match(result.error as string, /TRASH/);
    assert.match(result.error as string, /confirm: true/);
    assert.ok(
      !calls.some((call) => call.pathname.includes("batchModify")),
      `batchModify must not have been called; calls were: ${JSON.stringify(calls)}`,
    );
  } finally {
    teardownAccountFixture();
  }
});

test("gmail_backfill_filter dry run (apply: false) with no confirm does not refuse", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerFilterTools(server);

    installFakeGmailNetwork([
      {
        method: "GET",
        test: (p) => p === `/gmail/v1/users/me/settings/filters/${TRASH_FILTER_ID}`,
        respond: () => TRASH_FILTER,
      },
      { method: "GET", test: (p) => p === "/gmail/v1/users/me/labels", respond: () => ({ labels: LABELS }) },
      {
        method: "GET",
        test: (p) => p === "/gmail/v1/users/me/messages",
        respond: () => ({ messages: [], resultSizeEstimate: 0 }),
      },
    ]);

    const result = await callTool(handlers, "gmail_backfill_filter", {
      account: ACCOUNT,
      filterId: TRASH_FILTER_ID,
      apply: false,
    });

    assert.equal(result.error, undefined, `expected no refusal, got: ${JSON.stringify(result)}`);
    assert.equal(result.dryRun, true);
  } finally {
    teardownAccountFixture();
  }
});

test("gmail_apply_labels removing TRASH with no confirm does not refuse — removal is a recovery action", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerLabelTools(server);

    installFakeGmailNetwork([
      { method: "GET", test: (p) => p === "/gmail/v1/users/me/labels", respond: () => ({ labels: LABELS }) },
      {
        method: "POST",
        test: (p) => p === "/gmail/v1/users/me/messages/m1/modify",
        respond: () => ({ id: "m1", labelIds: ["INBOX"] }),
      },
    ]);

    const result = await callTool(handlers, "gmail_apply_labels", {
      account: ACCOUNT,
      messageIds: ["m1"],
      removeLabelNames: ["TRASH"],
    });

    assert.equal(result.error, undefined, `expected no refusal, got: ${JSON.stringify(result)}`);
    assert.deepEqual(result.modified, ["m1"]);
  } finally {
    teardownAccountFixture();
  }
});

// gmail_send_draft is the one irreversible action this server has: it is the
// only tool that puts mail on the wire to a real recipient. The tests below
// prove — against the real registered handler, through the same fake Gmail
// network boundary as the rest of this file — that the confirm gate and the
// allowedRecipients gate both actually stop the network call that matters
// (POST .../drafts/send), not merely that their pure helpers return the
// right verdict in isolation.

const DRAFT_ID = "draft1";

function draftGetRoute(to: string): FakeRoute {
  return {
    method: "GET",
    test: (p) => p === `/gmail/v1/users/me/drafts/${DRAFT_ID}`,
    respond: () => ({
      id: DRAFT_ID,
      message: {
        id: "msg1",
        threadId: "thread1",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "To", value: to },
            { name: "Subject", value: "Hello" },
          ],
          body: { data: Buffer.from("Body text").toString("base64url") },
        },
      },
    }),
  };
}

function isSendCall(call: FakeCall): boolean {
  return call.method === "POST" && call.pathname.endsWith("/drafts/send");
}

test("gmail_send_draft without confirm issues no POST to drafts/send", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDraftTools(server);

    const { calls } = installFakeGmailNetwork([draftGetRoute("someone@example.com")]);

    const result = await callTool(handlers, "gmail_send_draft", {
      account: ACCOUNT,
      draftId: DRAFT_ID,
    });

    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    // sent: false is the structural marker (finding 6) that distinguishes an
    // unconfirmed dry-run report from a real send, which returns { sent: <object> }.
    assert.equal(result.sent, false);
    assert.ok(!calls.some(isSendCall), `drafts/send must not have been called; calls were: ${JSON.stringify(calls)}`);
  } finally {
    teardownAccountFixture();
  }
});

test("gmail_send_draft with confirm: true, where the draft's To is not on allowedRecipients, issues no send", async () => {
  setupAccountFixture(["@other.example"]);
  try {
    const { server, handlers } = createFakeServer();
    registerDraftTools(server);

    const { calls } = installFakeGmailNetwork([draftGetRoute("someone@example.com")]);

    const result = await callTool(handlers, "gmail_send_draft", {
      account: ACCOUNT,
      draftId: DRAFT_ID,
      confirm: true,
    });

    assert.match(result.error as string, /allowedRecipients/);
    assert.ok(!calls.some(isSendCall), `drafts/send must not have been called; calls were: ${JSON.stringify(calls)}`);
  } finally {
    teardownAccountFixture();
  }
});

test("gmail_send_draft with confirm: true for an account with no allowedRecipients configured issues no send", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDraftTools(server);

    const { calls } = installFakeGmailNetwork([draftGetRoute("someone@example.com")]);

    const result = await callTool(handlers, "gmail_send_draft", {
      account: ACCOUNT,
      draftId: DRAFT_ID,
      confirm: true,
    });

    assert.match(result.error as string, /allowedRecipients/);
    assert.ok(!calls.some(isSendCall), `drafts/send must not have been called; calls were: ${JSON.stringify(calls)}`);
  } finally {
    teardownAccountFixture();
  }
});

test("gmail_update_draft still completes a normal update under the new per-draft lock", async () => {
  setupAccountFixture();
  try {
    const { server, handlers } = createFakeServer();
    registerDraftTools(server);

    const { calls } = installFakeGmailNetwork([
      draftGetRoute("someone@example.com"),
      {
        method: "PUT",
        test: (p) => p === `/gmail/v1/users/me/drafts/${DRAFT_ID}`,
        respond: () => ({ id: DRAFT_ID, message: { id: "msg2", threadId: "thread1" } }),
      },
    ]);

    const result = await callTool(handlers, "gmail_update_draft", {
      account: ACCOUNT,
      draftId: DRAFT_ID,
      to: "someone@example.com",
      subject: "Updated subject",
      body: "Updated body",
    });

    // The lock (finding 1) chains this operation onto any prior one for the
    // same "account:draftId" key and must still let a normal, uncontended
    // update finish rather than hang — this is the no-deadlock proof.
    assert.equal(result.error, undefined, `expected no error, got: ${JSON.stringify(result)}`);
    assert.equal(result.id, DRAFT_ID);
    assert.ok(
      calls.some((call) => call.method === "PUT" && call.pathname === `/gmail/v1/users/me/drafts/${DRAFT_ID}`),
      `expected a PUT to drafts/${DRAFT_ID}; calls were: ${JSON.stringify(calls)}`,
    );
  } finally {
    teardownAccountFixture();
  }
});
