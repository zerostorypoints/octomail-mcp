import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILTER_SCOPE,
  collectAttachments,
  describeAccountError,
  describeMissingFilterScope,
  isInvalidGrantError,
  isScopeInsufficientError,
  summarizeMessage,
  tokenHasScope,
} from "./gmail.js";

test("isInvalidGrantError detects a Gaxios response body", () => {
  assert.equal(isInvalidGrantError({ response: { data: { error: "invalid_grant" } } }), true);
});

test("isInvalidGrantError detects it in the message", () => {
  assert.equal(isInvalidGrantError(new Error("invalid_grant: Token has been expired or revoked.")), true);
});

test("isInvalidGrantError ignores unrelated errors", () => {
  assert.equal(isInvalidGrantError(new Error("Rate limit exceeded")), false);
});

test("isInvalidGrantError tolerates null and primitives", () => {
  assert.equal(isInvalidGrantError(null), false);
  assert.equal(isInvalidGrantError("invalid_grant"), false);
});

test("describeAccountError names the account and the fix command", () => {
  const message = describeAccountError("work", new Error("invalid_grant"));
  assert.match(message, /Gmail account "work"/);
  assert.match(message, /npm run auth -- --account work/);
  assert.match(message, /7 days/);
});

test("describeAccountError passes other errors through unchanged", () => {
  assert.equal(describeAccountError("work", new Error("Rate limit exceeded")), "Rate limit exceeded");
});

test("describeAccountError stringifies non-Error values", () => {
  assert.equal(describeAccountError("work", "boom"), "boom");
});

test("tokenHasScope finds a granted scope", () => {
  assert.equal(tokenHasScope({ scope: `https://a/x ${FILTER_SCOPE}` }, FILTER_SCOPE), true);
});

test("tokenHasScope reports a missing scope", () => {
  assert.equal(tokenHasScope({ scope: "https://a/x https://a/y" }, FILTER_SCOPE), false);
});

test("tokenHasScope does not match on a prefix", () => {
  assert.equal(tokenHasScope({ scope: `${FILTER_SCOPE}.extra` }, FILTER_SCOPE), false);
});

test("tokenHasScope returns undefined when the token records no scope", () => {
  assert.equal(tokenHasScope({}, FILTER_SCOPE), undefined);
  assert.equal(tokenHasScope({ scope: "" }, FILTER_SCOPE), undefined);
});

test("isScopeInsufficientError detects Google's response body", () => {
  assert.equal(
    isScopeInsufficientError({ response: { data: { error_description: "Request had insufficient authentication scopes." } } }),
    true,
  );
});

test("isScopeInsufficientError detects the status string in the message", () => {
  assert.equal(isScopeInsufficientError(new Error("ACCESS_TOKEN_SCOPE_INSUFFICIENT")), true);
});

test("isScopeInsufficientError ignores unrelated errors", () => {
  assert.equal(isScopeInsufficientError(new Error("Rate limit exceeded")), false);
  assert.equal(isScopeInsufficientError(null), false);
});

test("isScopeInsufficientError detects a real Gmail 403 body via status + message", () => {
  assert.equal(
    isScopeInsufficientError({
      message: "Request failed with status code 403",
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: "Request had insufficient authentication scopes.",
            errors: [{ reason: "somethingElse" }],
          },
        },
      },
    }),
    true,
  );
});

test("isScopeInsufficientError detects ACCESS_TOKEN_SCOPE_INSUFFICIENT in error.details", () => {
  assert.equal(
    isScopeInsufficientError({
      message: "Request failed with status code 403",
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: "Request had insufficient authentication scopes.",
            details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
          },
        },
      },
    }),
    true,
  );
});

test("isScopeInsufficientError detects insufficientPermissions in error.errors", () => {
  assert.equal(
    isScopeInsufficientError({
      message: "Request failed with status code 403",
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: "Request had insufficient authentication scopes.",
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
      },
    }),
    true,
  );
});

test("isScopeInsufficientError does not match a non-403 insufficientPermissions — a genuine resource-permission denial, not a scope problem", () => {
  assert.equal(
    isScopeInsufficientError({
      message: "Request failed with status code 404",
      response: {
        status: 404,
        data: {
          error: {
            code: 404,
            message: "Requested entity was not found.",
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
      },
    }),
    false,
  );
});

test("isScopeInsufficientError does not match an unrelated plain 403", () => {
  assert.equal(
    isScopeInsufficientError({
      message: "Request failed with status code 403",
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: "The user does not have sufficient permissions for this resource.",
            errors: [{ reason: "forbidden" }],
          },
        },
      },
    }),
    false,
  );
});

test("describeMissingFilterScope names the account and the re-auth command", () => {
  const message = describeMissingFilterScope("work");
  assert.match(message, /Gmail account "work"/);
  assert.match(message, /npm run auth -- --account work/);
});

const messageWithAttachments = {
  id: "m1",
  threadId: "t1",
  payload: {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from("Treść wiadomości").toString("base64url") } },
      {
        mimeType: "multipart/related",
        parts: [
          {
            mimeType: "image/png",
            filename: "logo.png",
            headers: [{ name: "Content-Disposition", value: "inline; filename=\"logo.png\"" }],
            body: { size: 1024, attachmentId: "att-logo" },
          },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "faktura_wrzesień.pdf",
        headers: [{ name: "Content-Disposition", value: "attachment; filename=\"faktura.pdf\"" }],
        body: { size: 20480, attachmentId: "att-pdf" },
      },
    ],
  },
};

test("collectAttachments finds attachments nested at any depth", () => {
  const found = collectAttachments(messageWithAttachments.payload);
  assert.deepEqual(
    found.map((a) => a.attachmentId),
    ["att-logo", "att-pdf"],
  );
});

test("collectAttachments reports filename, mime type and size", () => {
  const [, pdf] = collectAttachments(messageWithAttachments.payload);
  assert.equal(pdf.filename, "faktura_wrzesień.pdf");
  assert.equal(pdf.mimeType, "application/pdf");
  assert.equal(pdf.sizeBytes, 20480);
});

test("collectAttachments marks inline parts rather than hiding them", () => {
  const [logo, pdf] = collectAttachments(messageWithAttachments.payload);
  assert.equal(logo.inline, true);
  assert.equal(pdf.inline, false);
});

test("collectAttachments ignores body parts, which carry data rather than an attachmentId", () => {
  const bodyOnly = { mimeType: "text/plain", body: { data: Buffer.from("hi").toString("base64url") } };
  assert.deepEqual(collectAttachments(bodyOnly), []);
});

test("collectAttachments returns an empty array for a message with no payload", () => {
  assert.deepEqual(collectAttachments(undefined), []);
});

test("summarizeMessage omits attachments entirely when there are none", () => {
  const summary = summarizeMessage({ id: "m2", payload: { mimeType: "text/plain", body: {} } });
  assert.equal(summary.attachments, undefined);
});

test("summarizeMessage exposes attachments alongside the body", () => {
  const summary = summarizeMessage(messageWithAttachments);
  assert.equal(summary.bodyText, "Treść wiadomości");
  assert.equal(summary.attachments?.length, 2);
});
