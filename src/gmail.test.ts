import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILTER_SCOPE,
  describeAccountError,
  describeMissingFilterScope,
  isInvalidGrantError,
  isScopeInsufficientError,
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
