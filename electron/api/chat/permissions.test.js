import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveChatPermissionModes } from "./permissions.js";
import { formatProjectReferencesForPrompt } from "./schema.js";

test("full access permission mode bypasses permissions regardless of agent mode", () => {
  assert.deepEqual(
    resolveChatPermissionModes({
      agentMode: "plan",
      permissionMode: "full-access",
    }),
    {
      claudePermissionMode: "bypass-permissions",
      codexPermissionMode: "full-access",
    },
  );
  assert.deepEqual(
    resolveChatPermissionModes({
      agentMode: "build",
      permissionMode: "full-access",
    }),
    {
      claudePermissionMode: "bypass-permissions",
      codexPermissionMode: "full-access",
    },
  );
});

test("plan agent mode asks for permissions in standard mode", () => {
  assert.deepEqual(
    resolveChatPermissionModes({
      agentMode: "plan",
      permissionMode: "standard",
    }),
    {
      claudePermissionMode: "ask-permissions",
      codexPermissionMode: "default",
    },
  );
});

test("build agent mode auto-accepts edits in standard mode", () => {
  assert.deepEqual(
    resolveChatPermissionModes({
      agentMode: "build",
      permissionMode: "standard",
    }),
    {
      claudePermissionMode: "accept-edits",
      codexPermissionMode: "auto-accept-edits",
    },
  );
});

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
