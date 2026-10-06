import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import {
  buildPlaceholderRows,
  type PlaceholderRow,
} from "./diff-placeholder-rows";

const PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -10,4 +10,5 @@ function outer() {",
  " const a = 1;",
  "-const b = 2;",
  "-const c = 3;",
  "+const b = 20;",
  "+const c = 30;",
  "+const d = 40;",
  " const e = 5;",
  "@@ -30,2 +31,2 @@",
  "-old();",
  "+renamed();",
  " done();",
  "",
].join("\n");

const fileDiff = () => {
  const file = parsePatchFiles(PATCH)[0]?.files[0];
  if (!file) throw new Error("patch did not parse");
  return file;
};

const describeRow = (row: PlaceholderRow) => {
  if (row.type === "separator") return "---";
  const cell = (line: { kind: string; number: number; text: string } | null) =>
    line ? `${line.kind[0]}${line.number} ${line.text}` : "(empty)";
  return row.type === "line"
    ? cell(row.line)
    : `${cell(row.left)} | ${cell(row.right)}`;
};

describe("buildPlaceholderRows", () => {
  it("lays out a unified diff with old numbers on deletions and new numbers elsewhere", () => {
    expect(
      buildPlaceholderRows(fileDiff(), "unified").map(describeRow),
    ).toEqual([
      "---",
      "c10 const a = 1;",
      "d11 const b = 2;",
      "d12 const c = 3;",
      "a11 const b = 20;",
      "a12 const c = 30;",
      "a13 const d = 40;",
      "c14 const e = 5;",
      "---",
      "d30 old();",
      "a31 renamed();",
      "c32 done();",
    ]);
  });

  it("pairs deletions beside additions in a split diff", () => {
    expect(buildPlaceholderRows(fileDiff(), "split").map(describeRow)).toEqual([
      "---",
      "c10 const a = 1; | c10 const a = 1;",
      "d11 const b = 2; | a11 const b = 20;",
      "d12 const c = 3; | a12 const c = 30;",
      "(empty) | a13 const d = 40;",
      "c13 const e = 5; | c14 const e = 5;",
      "---",
      "d30 old(); | a31 renamed();",
      "c31 done(); | c32 done();",
    ]);
  });

  it("gives every row a unique key", () => {
    const keys = buildPlaceholderRows(fileDiff(), "split").map(
      (row) => row.key,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
