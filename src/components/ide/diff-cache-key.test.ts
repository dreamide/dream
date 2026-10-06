import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { withDiffCacheKey } from "./diff-cache-key";

const parse = (added: string) => {
  const file = parsePatchFiles(
    [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-const value = 1;",
      `+${added}`,
      "",
    ].join("\n"),
  )[0]?.files[0];
  if (!file) throw new Error("patch did not parse");
  return file;
};

describe("withDiffCacheKey", () => {
  it("gives identical diffs the same key", () => {
    expect(withDiffCacheKey(parse("const value = 2;")).cacheKey).toBe(
      withDiffCacheKey(parse("const value = 2;")).cacheKey,
    );
  });

  it("gives different diffs different keys", () => {
    expect(withDiffCacheKey(parse("const value = 2;")).cacheKey).not.toBe(
      withDiffCacheKey(parse("const value = 3;")).cacheKey,
    );
  });

  it("keeps a key the diff already has", () => {
    const keyed = { ...parse("const value = 2;"), cacheKey: "existing" };
    expect(withDiffCacheKey(keyed)).toBe(keyed);
  });
});
