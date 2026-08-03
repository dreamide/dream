import assert from "node:assert/strict";
import { test } from "vitest";
import { sanitizeGeneratedChatTitle } from "./title.js";

test("strips wrapping quotes and trailing punctuation", () => {
  assert.equal(sanitizeGeneratedChatTitle('"Fix login bug."'), "Fix login bug");
  assert.equal(sanitizeGeneratedChatTitle("`Refactor auth`"), "Refactor auth");
  assert.equal(sanitizeGeneratedChatTitle("'Add tests!'"), "Add tests");
});

test("collapses whitespace and newlines into single spaces", () => {
  assert.equal(
    sanitizeGeneratedChatTitle("  Multiple   spaces\nand\tnewlines  "),
    "Multiple spaces and newlines",
  );
});

test("truncates titles to sixty characters without trailing whitespace", () => {
  const long = "word ".repeat(20);
  const title = sanitizeGeneratedChatTitle(long);
  assert.ok(title.length <= 60);
  assert.equal(title, title.trim());
  assert.equal(sanitizeGeneratedChatTitle("a".repeat(70)), "a".repeat(60));
});

test("returns an empty string for empty or punctuation-only values", () => {
  assert.equal(sanitizeGeneratedChatTitle(null), "");
  assert.equal(sanitizeGeneratedChatTitle(undefined), "");
  assert.equal(sanitizeGeneratedChatTitle("   "), "");
  assert.equal(sanitizeGeneratedChatTitle("!?."), "");
});

test("keeps interior punctuation and quotes intact", () => {
  assert.equal(
    sanitizeGeneratedChatTitle('Fix user\'s "profile" page'),
    'Fix user\'s "profile" page',
  );
});
