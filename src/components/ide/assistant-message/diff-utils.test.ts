import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildLineDiff,
  buildWriteDiff,
  formatWriteOutputMessage,
  getAgentOutputText,
  getDiffStats,
  getFilePathFromOutputText,
  getWriteFileStateLabel,
  parseSingleDiff,
} from "@/components/ide/assistant-message/diff-utils";

test("buildLineDiff marks changed lines and keeps common lines as context", () => {
  assert.equal(buildLineDiff("a\nb\nc", "a\nx\nc"), " a\n-b\n+x\n c");
});

test("buildLineDiff handles pure additions, deletions, and CRLF input", () => {
  assert.equal(buildLineDiff("a", "a\nb"), " a\n+b");
  assert.equal(buildLineDiff("a\nb", "a"), " a\n-b");
  assert.equal(buildLineDiff("a\r\nb", "a\nb"), " a\n b");
});

test("buildWriteDiff produces a unified diff for an overwrite", () => {
  const diff = buildWriteDiff({
    content: "a\nB\nc",
    filePath: "src/app.ts",
    mode: null,
    previousContent: "a\nb\nc",
  });

  assert.equal(
    diff,
    "--- src/app.ts\n+++ src/app.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c",
  );
});

test("buildWriteDiff appends content in append mode", () => {
  const diff = buildWriteDiff({
    content: "\nbeta",
    filePath: "notes.txt",
    mode: "append",
    previousContent: "alpha",
  });

  assert.equal(
    diff,
    "--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,2 @@\n alpha\n+beta",
  );
});

test("parseSingleDiff parses a single-file patch and rejects other inputs", () => {
  const parsed = parseSingleDiff(
    [
      "--- src/a.ts",
      "+++ src/a.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
    ].join("\n"),
  );

  assert.ok(parsed);
  assert.equal(parsed?.name, "src/a.ts");
  assert.equal(parsed?.type, "change");

  assert.equal(parseSingleDiff("not a diff at all"), null);

  const twoFiles = [
    "--- a.ts",
    "+++ a.ts",
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
    "--- b.ts",
    "+++ b.ts",
    "@@ -1,1 +1,1 @@",
    "-p",
    "+q",
  ].join("\n");
  assert.equal(parseSingleDiff(twoFiles), null);
});

test("parseSingleDiff adds file headers to a bare hunk when given a file path", () => {
  const parsed = parseSingleDiff("@@ -1,1 +1,1 @@\n-old\n+new", "src/b.ts");

  assert.ok(parsed);
  assert.equal(parsed?.name, "src/b.ts");
});

test("getDiffStats sums additions and deletions across hunks", () => {
  const parsed = parseSingleDiff(
    [
      "--- a.ts",
      "+++ a.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+extra",
    ].join("\n"),
  );

  assert.deepEqual(getDiffStats(parsed), { additions: 2, deletions: 1 });
});

test("getDiffStats returns null for missing or unchanged diffs", () => {
  assert.equal(getDiffStats(null), null);

  const contextOnly = parseSingleDiff(
    ["--- a.ts", "+++ a.ts", "@@ -1,1 +1,1 @@", " x"].join("\n"),
  );
  assert.equal(getDiffStats(contextOnly), null);
});

test("getWriteFileStateLabel maps diff types and write modes to labels", () => {
  const asDiff = (type: string) =>
    ({ hunks: [], type }) as unknown as ReturnType<typeof parseSingleDiff>;

  assert.equal(getWriteFileStateLabel(asDiff("new"), null, null), "created");
  assert.equal(
    getWriteFileStateLabel(asDiff("deleted"), null, null),
    "deleted",
  );
  assert.equal(
    getWriteFileStateLabel(asDiff("rename-pure"), null, null),
    "renamed",
  );
  assert.equal(
    getWriteFileStateLabel(asDiff("change"), null, null),
    "modified",
  );
  assert.equal(getWriteFileStateLabel(null, "append", null), "modified");
  assert.equal(getWriteFileStateLabel(null, null, "previous text"), "modified");
  assert.equal(getWriteFileStateLabel(null, null, null), null);
});

test("getFilePathFromOutputText extracts file paths from update messages", () => {
  assert.equal(
    getFilePathFromOutputText("The file /repo/src/index.ts has been updated"),
    "/repo/src/index.ts",
  );
  assert.equal(
    getFilePathFromOutputText("file 'notes.md' was created."),
    "notes.md",
  );
  assert.equal(getFilePathFromOutputText("No file changes were made"), null);
  assert.equal(
    getFilePathFromOutputText({ message: "file a.ts was updated" }),
    null,
  );
});

test("formatWriteOutputMessage unwraps message records and normalizes slashes", () => {
  assert.equal(
    formatWriteOutputMessage("'C:\\dev\\project\\file.ts'"),
    "C:/dev/project/file.ts",
  );
  assert.equal(
    formatWriteOutputMessage({ message: "  saved file  " }),
    "saved file",
  );
  assert.equal(formatWriteOutputMessage(42), null);
  assert.equal(formatWriteOutputMessage({ status: "ok" }), null);
});

test("getAgentOutputText strips usage blocks and agentId lines", () => {
  assert.equal(
    getAgentOutputText('Task complete.\n\n<usage>{"tokens": 100}</usage>'),
    "Task complete.",
  );
  assert.equal(
    getAgentOutputText("agentId: abc-123\nHere are the findings."),
    "Here are the findings.",
  );
  assert.equal(getAgentOutputText(""), null);
  assert.equal(getAgentOutputText("<usage>only usage</usage>"), null);
  assert.equal(getAgentOutputText({ text: "not a string" }), null);
});
