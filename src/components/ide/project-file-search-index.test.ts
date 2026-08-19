import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  normalizeProjectSearchQuery,
  ProjectFileSearchIndex,
} from "./project-file-search-index";

const files = [
  "README.md",
  "src/components/button.tsx",
  "src/components/index.ts",
  "src/index.ts",
  "docs/Index.md",
  "lib\\nested\\win-path.ts",
];

test("normalizes queries like the tree search box", () => {
  assert.equal(normalizeProjectSearchQuery("  Foo\\Bar  "), "foo/bar");
  assert.equal(normalizeProjectSearchQuery("   "), "");
});

test("fetches the index once across concurrent and repeated calls", async () => {
  const fetchFiles = vi.fn(async () => files);
  const index = new ProjectFileSearchIndex({ fetchFiles });

  const [first, second] = await Promise.all([
    index.ensureLoaded(),
    index.ensureLoaded(),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(await index.ensureLoaded(), true);
  assert.equal(fetchFiles.mock.calls.length, 1);
});

test("ranks basename matches before path matches and honors the limit", async () => {
  const index = new ProjectFileSearchIndex({ fetchFiles: async () => files });
  await index.ensureLoaded();

  assert.deepEqual(index.search("index", 10), [
    "docs/Index.md",
    "src/components/index.ts",
    "src/index.ts",
  ]);
  assert.deepEqual(index.search("index.ts", 10), [
    "src/components/index.ts",
    "src/index.ts",
  ]);
  assert.deepEqual(index.search("src/comp", 10), [
    "src/components/button.tsx",
    "src/components/index.ts",
  ]);
  assert.deepEqual(index.search("index", 1), ["docs/Index.md"]);
  assert.deepEqual(index.search("nested\\win", 10), ["lib/nested/win-path.ts"]);
  assert.deepEqual(index.search("   ", 10), []);
});

test("invalidate drops the cache and forces a refetch", async () => {
  const fetchFiles = vi.fn(async () => files);
  const index = new ProjectFileSearchIndex({ fetchFiles });
  await index.ensureLoaded();

  index.invalidate();
  assert.equal(index.isLoaded, false);
  assert.deepEqual(index.search("readme", 10), []);

  await index.ensureLoaded();
  assert.equal(fetchFiles.mock.calls.length, 2);
  assert.deepEqual(index.search("readme", 10), ["README.md"]);
});

test("a response that arrives after invalidate is discarded", async () => {
  const pendingResolvers: Array<(value: string[]) => void> = [];
  const index = new ProjectFileSearchIndex({
    fetchFiles: () =>
      new Promise<string[]>((resolve) => {
        pendingResolvers.push(resolve);
      }),
  });

  const pending = index.ensureLoaded();
  index.invalidate();
  pendingResolvers[0](files);
  assert.equal(await pending, false);
  assert.equal(index.isLoaded, false);
});

test("a failed fetch resolves false and search returns nothing", async () => {
  const index = new ProjectFileSearchIndex({
    fetchFiles: async () => {
      throw new Error("boom");
    },
  });

  assert.equal(await index.ensureLoaded(), false);
  assert.deepEqual(index.search("readme", 10), []);
});
