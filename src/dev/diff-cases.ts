import { parsePatchFiles } from "@pierre/diffs";

const longLine = `const description = "${"a long line that wraps or scrolls ".repeat(8)}";`;
const patches = {
  modified: [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1,3 +1,4 @@",
    " export function example() {",
    "-  return 1;",
    "+  const value = 2;",
    "+  return value;",
    " }",
    "@@ -20,2 +21,2 @@",
    "-old();",
    "+renamed();",
    " done();",
    "",
  ],
  added: [
    "diff --git a/example.ts b/example.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/example.ts",
    "@@ -0,0 +1,3 @@",
    "+export const value = 1;",
    "+console.log(value);",
    `+${longLine}`,
    "",
  ],
  deleted: [
    "diff --git a/example.ts b/example.ts",
    "deleted file mode 100644",
    "--- a/example.ts",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-export const value = 1;",
    "-console.log(value);",
    `-${longLine}`,
    "",
  ],
  eof: [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1 +1 @@",
    "-export const value = 1;",
    "\\ No newline at end of file",
    "+export const value = 2;",
    "\\ No newline at end of file",
    "",
  ],
  wrapped: [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1 +1,2 @@",
    "-const description = 'short';",
    `+${longLine}`,
    "+console.log(description);",
    "",
  ],
};

export const DIFF_CASES = Object.fromEntries(
  Object.entries(patches).map(([name, lines]) => {
    const diff = parsePatchFiles(lines.join("\n"))[0]?.files[0];
    if (!diff) throw new Error(`Cannot parse fixture ${name}`);
    return [name, diff];
  }),
);
