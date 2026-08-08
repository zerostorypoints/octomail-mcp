import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSingleUserLabel, criteriaToQuery } from "./filters.js";

test("criteriaToQuery translates each address field", () => {
  assert.equal(criteriaToQuery({ from: "a@example.com" }), "from:(a@example.com)");
  assert.equal(criteriaToQuery({ to: "b@example.com" }), "to:(b@example.com)");
  assert.equal(criteriaToQuery({ subject: "Invoice" }), "subject:(Invoice)");
});

test("criteriaToQuery parenthesises values containing spaces", () => {
  assert.equal(criteriaToQuery({ from: "Alice Smith" }), "from:(Alice Smith)");
  assert.equal(criteriaToQuery({ subject: 'Re: "urgent" thing' }), 'subject:(Re: "urgent" thing)');
});

test("criteriaToQuery translates the boolean flags", () => {
  assert.equal(criteriaToQuery({ hasAttachment: true }), "has:attachment");
  assert.equal(criteriaToQuery({ excludeChats: true }), "-in:chats");
});

test("criteriaToQuery ignores false booleans", () => {
  assert.equal(criteriaToQuery({ hasAttachment: false, excludeChats: false }), "");
});

test("criteriaToQuery translates size comparisons in bytes", () => {
  assert.equal(criteriaToQuery({ size: 1048576, sizeComparison: "larger" }), "larger:1048576b");
  assert.equal(criteriaToQuery({ size: 500, sizeComparison: "smaller" }), "smaller:500b");
});

test("criteriaToQuery ignores size when the comparison is unspecified", () => {
  assert.equal(criteriaToQuery({ size: 500, sizeComparison: "unspecified" }), "");
  assert.equal(criteriaToQuery({ size: 500 }), "");
});

test("criteriaToQuery keeps a zero size, which truthiness would drop", () => {
  assert.equal(criteriaToQuery({ size: 0, sizeComparison: "smaller" }), "smaller:0b");
  assert.equal(criteriaToQuery({ size: 0, sizeComparison: "larger" }), "larger:0b");
});

test("criteriaToQuery passes query through and negates negatedQuery", () => {
  assert.equal(criteriaToQuery({ query: "is:unread" }), "is:unread");
  assert.equal(criteriaToQuery({ negatedQuery: "from:boss@example.com" }), "-(from:boss@example.com)");
});

test("criteriaToQuery combines fields in a stable order", () => {
  assert.equal(
    criteriaToQuery({ from: "a@example.com", subject: "Receipt", hasAttachment: true, negatedQuery: "is:starred" }),
    "from:(a@example.com) subject:(Receipt) has:attachment -(is:starred)",
  );
});

test("criteriaToQuery returns empty string for empty criteria", () => {
  assert.equal(criteriaToQuery({}), "");
});

test("assertSingleUserLabel allows many system labels", () => {
  assert.doesNotThrow(() =>
    assertSingleUserLabel([
      { name: "INBOX", type: "system" },
      { name: "UNREAD", type: "system" },
      { name: "STARRED", type: "system" },
    ]),
  );
});

test("assertSingleUserLabel allows exactly one user label", () => {
  assert.doesNotThrow(() =>
    assertSingleUserLabel([
      { name: "INBOX", type: "system" },
      { name: "Receipts", type: "user" },
    ]),
  );
});

test("assertSingleUserLabel rejects two user labels and names them", () => {
  assert.throws(
    () =>
      assertSingleUserLabel([
        { name: "Receipts", type: "user" },
        { name: "Clients/Acme", type: "user" },
      ]),
    /Receipts.*Clients\/Acme|Clients\/Acme.*Receipts/,
  );
});
