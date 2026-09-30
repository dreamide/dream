import assert from "node:assert/strict";
import { test } from "vitest";
import { formatProjectReferencesForPrompt } from "./schema.js";

test("returns null for empty or non-array project references", () => {
  assert.equal(formatProjectReferencesForPrompt([]), null);
  assert.equal(formatProjectReferencesForPrompt(null), null);
  assert.equal(formatProjectReferencesForPrompt("src/a.js"), null);
});

test("formats file and folder references with optional names", () => {
  const prompt = formatProjectReferencesForPrompt([
    { kind: "file", name: "a.js", path: "src/a.js" },
    { kind: "folder", path: "src" },
  ]);
  assert.ok(prompt.startsWith("Current turn project references:"));
  assert.ok(prompt.includes("- file (a.js): src/a.js"));
  assert.ok(prompt.includes("- folder: src"));
});

test("treats unknown reference kinds as files", () => {
  const prompt = formatProjectReferencesForPrompt([
    { kind: "symlink", path: "src/link" },
  ]);
  assert.ok(prompt.includes("- file: src/link"));
});
