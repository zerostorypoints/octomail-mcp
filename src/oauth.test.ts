import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startCallbackServer } from "./oauth.js";

function get(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

test("startCallbackServer resolves with the code from a successful callback", async () => {
  const { redirectUri, waitForCode } = await startCallbackServer();
  const url = new URL(redirectUri);
  url.searchParams.set("code", "abc");

  const response = await get(url.toString());
  assert.equal(response.statusCode, 200);

  const code = await waitForCode;
  assert.equal(code, "abc");
});

test("startCallbackServer rejects when Google reports an error", async () => {
  const { redirectUri, waitForCode } = await startCallbackServer();
  // Attach the rejection assertion before triggering the request, so the
  // rejection is never briefly "unhandled" from Node's point of view.
  const rejection = assert.rejects(waitForCode, /access_denied/);

  const url = new URL(redirectUri);
  url.searchParams.set("error", "access_denied");
  const response = await get(url.toString());
  assert.equal(response.statusCode, 400);

  await rejection;
});

test("startCallbackServer 404s an unrelated path and leaves the promise pending", async () => {
  const { redirectUri, waitForCode } = await startCallbackServer();
  const base = new URL(redirectUri);
  const unrelated = new URL("/favicon.ico", base);

  const response = await get(unrelated.toString());
  assert.equal(response.statusCode, 404);

  let settled = false;
  waitForCode.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);

  // Deliver the real callback so the server closes and the promise settles —
  // otherwise this test would leave an open listener behind.
  const finish = new URL(redirectUri);
  finish.searchParams.set("code", "cleanup");
  await get(finish.toString());
  assert.equal(await waitForCode, "cleanup");
});
