import assert from "node:assert/strict";
import { test } from "vitest";
import { formatStreamError } from "./errors.js";

test("returns a generic message for nullish and empty errors", () => {
  assert.equal(formatStreamError(null), "An unknown error occurred.");
  assert.equal(formatStreamError(undefined), "An unknown error occurred.");
  assert.equal(formatStreamError(""), "An unknown error occurred.");
});

test("returns strings and primitives as-is", () => {
  assert.equal(formatStreamError("connection reset"), "connection reset");
  assert.equal(formatStreamError(42), "42");
});

test("prefixes the status code and includes the message", () => {
  assert.equal(
    formatStreamError({ message: "Rate limited", status: 429 }),
    "[429] — Rate limited",
  );
  assert.equal(
    formatStreamError({ message: "Server exploded", statusCode: 500 }),
    "[500] — Server exploded",
  );
});

test("falls back to the unexpected error message when only generic details exist", () => {
  assert.equal(
    formatStreamError({ message: "Error" }),
    "An unexpected error occurred. Check the server console for details.",
  );
  assert.equal(
    formatStreamError({}),
    "An unexpected error occurred. Check the server console for details.",
  );
});

test("appends trimmed stderr output", () => {
  assert.equal(
    formatStreamError({ message: "spawn failed", stderr: "  boom  \n" }),
    "spawn failed — boom",
  );
});

test("includes type and message from nested error data", () => {
  assert.equal(
    formatStreamError({
      data: {
        error: { message: "Too many requests", type: "rate_limit_error" },
      },
      message: "Request failed",
    }),
    "Request failed — rate limit error — Too many requests",
  );
});

test("parses JSON response bodies when few details are available", () => {
  assert.equal(
    formatStreamError({
      responseBody: '{"error":{"code":"server_error","message":"oops"}}',
      statusCode: 500,
    }),
    "[500] — server error — oops",
  );
});

test("uses a short non-JSON response body verbatim", () => {
  assert.equal(
    formatStreamError({ message: "Error", responseBody: " Bad gateway " }),
    "Bad gateway",
  );
});

test("walks the cause chain past generic messages", () => {
  const root = new Error("root cause");
  const generic = new Error("Error");
  generic.cause = root;
  assert.equal(
    formatStreamError({ cause: generic, message: "outer" }),
    "outer — root cause",
  );
});

test("skips cause messages that repeat the top-level message", () => {
  assert.equal(
    formatStreamError({ cause: new Error("same"), message: "same" }),
    "same",
  );
});
