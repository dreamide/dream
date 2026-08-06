import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { FileTree } from "@pierre/trees";
import { test, vi } from "vitest";
import {
  ProjectDirectoryLoader,
  type ProjectDirectoryResponse,
  resolveSelectedProjectFile,
  toProjectTreePath,
} from "./project-directory-loader";

const rootResponse: ProjectDirectoryResponse = {
  directory: ".",
  entries: [
    { kind: "directory", path: "src" },
    { kind: "file", path: "README.md" },
  ],
};

test("expansion loads exactly one immediate directory and never refetches it", async () => {
  const fetchDirectory = vi.fn(async (directory: string) =>
    directory === "."
      ? rootResponse
      : { directory, entries: [{ kind: "file" as const, path: "src/a.ts" }] },
  );
  const loader = new ProjectDirectoryLoader({ fetchDirectory });
  await loader.load(".");

  await loader.syncExpandedDirectories(["src"]);
  await loader.syncExpandedDirectories(["src"]);
  await loader.syncExpandedDirectories([]);
  await loader.syncExpandedDirectories(["src"]);

  assert.deepEqual(
    fetchDirectory.mock.calls.map(([directory]) => directory),
    [".", "src"],
  );
});

test("simultaneous directory loads share one request", async () => {
  let resolveRequest:
    | ((response: ProjectDirectoryResponse) => void)
    | undefined;
  const fetchDirectory = vi.fn(
    () =>
      new Promise<ProjectDirectoryResponse>((resolve) => {
        resolveRequest = resolve;
      }),
  );
  const loader = new ProjectDirectoryLoader({ fetchDirectory });

  const first = loader.load(".");
  const second = loader.load(".");
  assert.equal(first, second);
  resolveRequest?.({ directory: ".", entries: [] });
  await Promise.all([first, second]);
  assert.equal(fetchDirectory.mock.calls.length, 1);
});

test("refresh invalidates loaded state and ignores stale responses", async () => {
  const pending: Array<(response: ProjectDirectoryResponse) => void> = [];
  const loaded = vi.fn();
  const fetchDirectory = vi.fn(
    () =>
      new Promise<ProjectDirectoryResponse>((resolve) => pending.push(resolve)),
  );
  const loader = new ProjectDirectoryLoader({
    fetchDirectory,
    onDirectoryLoaded: loaded,
  });

  const staleRequest = loader.load(".");
  loader.invalidate();
  assert.equal(loader.isLoaded("."), false);
  const currentRequest = loader.load(".");
  pending[0](rootResponse);
  assert.equal(await staleRequest, null);
  assert.equal(loaded.mock.calls.length, 0);
  pending[1](rootResponse);
  await currentRequest;
  assert.equal(loader.isLoaded("."), true);
  assert.equal(loaded.mock.calls.length, 1);
});

test("deep file reveal loads ancestors sequentially before selecting", async () => {
  const events: string[] = [];
  const responses: Record<string, ProjectDirectoryResponse> = {
    ".": {
      directory: ".",
      entries: [{ kind: "directory", path: "src" }],
    },
    src: {
      directory: "src",
      entries: [{ kind: "directory", path: "src/components" }],
    },
    "src/components": {
      directory: "src/components",
      entries: [{ kind: "file", path: "src/components/Button.tsx" }],
    },
  };
  const loader = new ProjectDirectoryLoader({
    fetchDirectory: async (directory) => {
      events.push(`load:${directory}`);
      return responses[directory];
    },
  });

  assert.equal(
    await loader.revealFile("src/components/Button.tsx", {
      expandDirectory: (directory) => events.push(`expand:${directory}`),
      revealFile: (filePath) => events.push(`reveal:${filePath}`),
    }),
    true,
  );
  assert.deepEqual(events, [
    "load:.",
    "load:src",
    "expand:src",
    "load:src/components",
    "expand:src/components",
    "reveal:src/components/Button.tsx",
  ]);
});

test("directory selection keeps the currently open file", () => {
  const files = new Set(["src/index.ts"]);
  assert.equal(
    resolveSelectedProjectFile("src/index.ts", "src/", files),
    "src/index.ts",
  );
  assert.equal(
    resolveSelectedProjectFile("src/index.ts", "README.md", files),
    "src/index.ts",
  );
  assert.equal(
    resolveSelectedProjectFile("src/index.ts", "src/index.ts", files),
    "src/index.ts",
  );
});

test("a failed child load can be retried after collapse and re-expansion", async () => {
  let attempts = 0;
  const fetchDirectory = vi.fn(async (directory: string) => {
    if (directory === ".") {
      return rootResponse;
    }
    attempts += 1;
    if (attempts === 1) {
      throw new Error("temporary failure");
    }
    return { directory, entries: [] };
  });
  const loader = new ProjectDirectoryLoader({ fetchDirectory });
  await loader.load(".");

  await loader.syncExpandedDirectories(["src"]);
  assert.equal(loader.isLoaded("src"), false);
  await loader.syncExpandedDirectories([]);
  await loader.syncExpandedDirectories(["src"]);

  assert.equal(attempts, 2);
  assert.equal(loader.isLoaded("src"), true);
});

test("tree search filters loaded paths without loading directories", async () => {
  const model = new FileTree({
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: false,
    paths: [],
    search: true,
  });
  const fetchDirectory = vi.fn(async (directory: string) =>
    directory === "."
      ? rootResponse
      : { directory, entries: [{ kind: "file" as const, path: "src/a.ts" }] },
  );
  const loader = new ProjectDirectoryLoader({
    fetchDirectory,
    onDirectoryLoaded: (response) => {
      model.batch(
        response.entries.map((entry) => ({
          path: toProjectTreePath(entry),
          type: "add" as const,
        })),
      );
    },
  });
  const syncExpansion = () => {
    if (model.isSearchOpen()) {
      return;
    }
    const expanded = [...loader.knownDirectories].filter((directory) => {
      const item = model.getItem(`${directory}/`);
      return item?.isDirectory() && "isExpanded" in item && item.isExpanded();
    });
    void loader.syncExpandedDirectories(expanded);
  };
  const unsubscribe = model.subscribe(syncExpansion);
  await loader.load(".");

  model.openSearch("src");
  model.setSearch("src");
  await Promise.resolve();

  assert.deepEqual(
    fetchDirectory.mock.calls.map(([directory]) => directory),
    ["."],
  );
  unsubscribe();
  model.cleanUp();
});

test("one batch inserts 10,000 immediate entries into the tree model", async () => {
  const entryCount = 10_000;
  const entries = Array.from({ length: entryCount }, (_, index) => ({
    kind: "file" as const,
    path: `large/file-${String(index).padStart(5, "0")}.txt`,
  }));
  const model = new FileTree({ flattenEmptyDirectories: false, paths: [] });
  const startedAt = performance.now();
  const loader = new ProjectDirectoryLoader({
    fetchDirectory: async (directory) => ({ directory, entries }),
    onDirectoryLoaded: (response) => {
      model.batch(
        response.entries.map((entry) => ({
          path: toProjectTreePath(entry),
          type: "add" as const,
        })),
      );
    },
  });

  await loader.load("large");
  const durationMs = performance.now() - startedAt;
  assert.equal(model.getItem("large/file-00000.txt")?.isDirectory(), false);
  assert.equal(
    model.getItem("large/file-09999.txt")?.getPath(),
    "large/file-09999.txt",
  );
  assert.ok(durationMs < 5_000, `10,000 entries took ${durationMs}ms`);
  model.cleanUp();
});
