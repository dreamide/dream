import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/dream-test-user-data" },
}));

const { getGitCommandErrorMessage, getProjectGitChangesFingerprint } =
  await import("./core.js");

const makeChange = (overrides = {}) => ({
  addedLines: 1,
  path: "src/a.js",
  previousPath: null,
  removedLines: 0,
  staged: false,
  status: "modified",
  unstaged: true,
  ...overrides,
});

const fingerprintOptions = {
  customInstructions: "",
  includeUnstaged: true,
  projectPath: "/proj",
  provider: "openai",
};

test("reports a missing git binary for ENOENT errors", () => {
  assert.equal(
    getGitCommandErrorMessage({ code: "ENOENT" }),
    "Git is not available on PATH.",
  );
});

test("prefers trimmed stderr, then stdout, then a generic git failure message", () => {
  assert.equal(
    getGitCommandErrorMessage({
      stderr: "  fatal: bad ref  ",
      stdout: "noise",
    }),
    "fatal: bad ref",
  );
  assert.equal(
    getGitCommandErrorMessage({ stderr: "", stdout: " some output " }),
    "some output",
  );
  assert.equal(getGitCommandErrorMessage({}), "Git command failed.");
  assert.equal(getGitCommandErrorMessage(undefined), "Git command failed.");
});

test("produces a stable sha256 fingerprint for git changes", () => {
  const fingerprint = getProjectGitChangesFingerprint(
    [makeChange()],
    fingerprintOptions,
  );
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    getProjectGitChangesFingerprint([makeChange()], fingerprintOptions),
    fingerprint,
  );
});

test("fingerprints are independent of change ordering", () => {
  const first = makeChange({ path: "a.js" });
  const second = makeChange({ path: "b.js", staged: true });
  assert.equal(
    getProjectGitChangesFingerprint([first, second], fingerprintOptions),
    getProjectGitChangesFingerprint([second, first], fingerprintOptions),
  );
});

test("fingerprints ignore extra change fields outside the tracked set", () => {
  assert.equal(
    getProjectGitChangesFingerprint(
      [makeChange({ irrelevant: "extra" })],
      fingerprintOptions,
    ),
    getProjectGitChangesFingerprint([makeChange()], fingerprintOptions),
  );
});

test("fingerprints change when options or change details differ", () => {
  const base = getProjectGitChangesFingerprint(
    [makeChange()],
    fingerprintOptions,
  );
  assert.notEqual(
    getProjectGitChangesFingerprint([makeChange({ addedLines: 2 })], {
      ...fingerprintOptions,
    }),
    base,
  );
  assert.notEqual(
    getProjectGitChangesFingerprint([makeChange()], {
      ...fingerprintOptions,
      customInstructions: "focus on tests",
    }),
    base,
  );
  assert.notEqual(
    getProjectGitChangesFingerprint([makeChange()], {
      ...fingerprintOptions,
      provider: "anthropic",
    }),
    base,
  );
  assert.notEqual(
    getProjectGitChangesFingerprint([makeChange()], {
      ...fingerprintOptions,
      includeUnstaged: false,
    }),
    base,
  );
});
