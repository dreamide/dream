import assert from "node:assert/strict";
import { test } from "vitest";
import {
  inferLanguage,
  normalizeEmbeddedLineNumbers,
} from "@/components/ide/assistant-message/language-utils";

test("infers languages from file extensions case-insensitively", () => {
  assert.equal(inferLanguage("src/app/main.ts"), "typescript");
  assert.equal(inferLanguage("component.TSX"), "tsx");
  assert.equal(inferLanguage("scripts/deploy.zsh"), "bash");
  assert.equal(inferLanguage("Dockerfile"), "dockerfile");
});

test("falls back to log for unknown extensions", () => {
  assert.equal(inferLanguage("archive.tar.unknownext"), "log");
  assert.equal(inferLanguage(""), "log");
});

test("returns short content unchanged without detecting line numbers", () => {
  const result = normalizeEmbeddedLineNumbers("const x = 1;", 12);

  assert.deepEqual(result, {
    code: "const x = 1;",
    hadEmbeddedLineNumbers: false,
    startingLineNumber: 12,
  });
});

test("leaves multi-line content without embedded line numbers alone", () => {
  const content = "function add(a, b) {\n  return a + b;\n}";
  const result = normalizeEmbeddedLineNumbers(content);

  assert.equal(result.code, content);
  assert.equal(result.hadEmbeddedLineNumbers, false);
  assert.equal(result.startingLineNumber, 1);
});

test("strips a contiguous run of tab-separated line numbers", () => {
  const content = "5\tconst a = 1;\n6\tconst b = 2;\n7\treturn a + b;";
  const result = normalizeEmbeddedLineNumbers(content);

  assert.equal(result.code, "const a = 1;\nconst b = 2;\nreturn a + b;");
  assert.equal(result.hadEmbeddedLineNumbers, true);
  assert.equal(result.startingLineNumber, 5);
});

test("supports explicit separator styles like pipes, colons, and arrows", () => {
  const piped = normalizeEmbeddedLineNumbers("1 | alpha\n2 | beta");
  assert.equal(piped.code, "alpha\nbeta");
  assert.equal(piped.startingLineNumber, 1);

  const arrows = normalizeEmbeddedLineNumbers("10->first\n11->second");
  assert.equal(arrows.code, "first\nsecond");
  assert.equal(arrows.startingLineNumber, 10);
});

test("normalizes space-separated line numbers while preserving indentation", () => {
  const content = "3  if (ready) {\n4    start();\n5  }";
  const result = normalizeEmbeddedLineNumbers(content);

  assert.equal(result.code, "if (ready) {\n  start();\n}");
  assert.equal(result.hadEmbeddedLineNumbers, true);
  assert.equal(result.startingLineNumber, 3);
});

test("keeps only the best numbered run when surrounded by mixed content", () => {
  const content = [
    "Here is the relevant snippet:",
    "12\tconst total = sum(items);",
    "13\treturn total;",
    "Some trailing commentary.",
  ].join("\n");
  const result = normalizeEmbeddedLineNumbers(content);

  assert.equal(result.code, "const total = sum(items);\nreturn total;");
  assert.equal(result.startingLineNumber, 12);
});

test("prefers the run starting at the requested line over a longer run", () => {
  const content = [
    "5\talpha",
    "6\tbeta",
    "7\tgamma",
    "not numbered",
    "20\tdelta",
    "21\tepsilon",
  ].join("\n");

  const preferred = normalizeEmbeddedLineNumbers(content, 20);
  assert.equal(preferred.code, "delta\nepsilon");
  assert.equal(preferred.startingLineNumber, 20);

  const longest = normalizeEmbeddedLineNumbers(content);
  assert.equal(longest.code, "alpha\nbeta\ngamma");
  assert.equal(longest.startingLineNumber, 5);
});

test("ignores runs of bare numbers without separators or code", () => {
  const content = "1\n2\n3\n4";
  const result = normalizeEmbeddedLineNumbers(content);

  assert.equal(result.code, content);
  assert.equal(result.hadEmbeddedLineNumbers, false);
});

test("removes a trailing system-reminder block before analyzing content", () => {
  const content =
    "1\tfirst\n2\tsecond\n<system-reminder>internal note</system-reminder>";
  const result = normalizeEmbeddedLineNumbers(content);

  assert.equal(result.code, "first\nsecond");
  assert.equal(result.hadEmbeddedLineNumbers, true);
});
