import { FileTree } from "@pierre/trees";
import { afterEach, expect, test, vi } from "vitest";
import type { ProjectDirectoryResponse } from "./project-directory-loader";
import { ProjectFileTree } from "./project-file-tree";

const listings: Record<string, ProjectDirectoryResponse> = {
  ".": {
    directory: ".",
    entries: [
      { kind: "directory", path: "src" },
      { kind: "file", path: "README.md" },
    ],
  },
  src: {
    directory: "src",
    entries: [
      { kind: "directory", path: "src/components" },
      { kind: "file", path: "src/404.astro" },
      { kind: "file", path: "src/index.astro" },
    ],
  },
  "src/components": {
    directory: "src/components",
    entries: [
      { kind: "file", path: "src/components/Button.tsx" },
      { kind: "file", path: "src/components/Input.tsx" },
    ],
  },
};

const allFiles = [
  "README.md",
  "src/404.astro",
  "src/index.astro",
  "src/components/Button.tsx",
  "src/components/Input.tsx",
];

const models: FileTree[] = [];
afterEach(() => {
  for (const model of models.splice(0)) model.cleanUp();
  vi.restoreAllMocks();
});

/** Lets fetches, timers at 0 ms and the loads they start settle. */
const settle = async () => {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const createTree = ({
  fetchDirectory = async (directory: string) => {
    const listing = listings[directory];
    if (!listing) throw new Error(`ENOENT: ${directory}`);
    return listing;
  },
  fetchFiles = async () => allFiles,
}: {
  fetchDirectory?: (directory: string) => Promise<ProjectDirectoryResponse>;
  fetchFiles?: () => Promise<string[]>;
} = {}) => {
  const model = new FileTree({
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    paths: [],
    search: true,
  });
  models.push(model);
  const directoryFetch = vi.fn(fetchDirectory);
  const filesFetch = vi.fn(fetchFiles);
  const tree = new ProjectFileTree({
    fetchDirectory: directoryFetch,
    fetchFiles: filesFetch,
    model,
    searchDebounceMs: 0,
  });
  tree.attach();
  const fetched = () =>
    directoryFetch.mock.calls.map(([directory]) => directory);
  /** Types a filter into the tree's search, as its input would. */
  const search = (query: string) => {
    model.openSearch(query);
    model.setSearch(query);
    tree.searchChanged(query);
  };
  return { fetched, filesFetch, model, search, tree };
};

const expand = (model: FileTree, directory: string) => {
  const item = model.getItem(`${directory}/`);
  if (item?.isDirectory() && "expand" in item) item.expand();
};

test("loading the root shows its entries and reports it ready", async () => {
  const { model, tree } = createTree();

  tree.load(0);
  expect(tree.getSnapshot().rootStatus).toBe("loading");
  await settle();

  expect(tree.getSnapshot()).toEqual({
    directoryErrors: {},
    rootStatus: "ready",
  });
  expect(model.getItem("README.md")).not.toBeNull();
  expect(model.getItem("src/")?.isDirectory()).toBe(true);
});

test("an empty project is empty, and a missing one is an error on the root", async () => {
  const empty = createTree({
    fetchDirectory: async (directory) => ({ directory, entries: [] }),
  });
  empty.tree.load(0);
  await settle();
  expect(empty.tree.getSnapshot().rootStatus).toBe("empty");

  const missing = createTree({
    fetchDirectory: async () => {
      throw new Error("ENOENT: no such file or directory");
    },
  });
  missing.tree.load(0);
  await settle();
  expect(missing.tree.getSnapshot()).toEqual({
    directoryErrors: { ".": "ENOENT: no such file or directory" },
    rootStatus: "error",
  });
});

test("a directory that fails to list can be retried, which clears its error", async () => {
  let failures = 1;
  const { model, tree } = createTree({
    fetchDirectory: async (directory) => {
      if (directory === "src" && failures-- > 0) {
        throw new Error("temporary failure");
      }
      return listings[directory] as ProjectDirectoryResponse;
    },
  });
  tree.load(0);
  await settle();

  expand(model, "src");
  await settle();
  expect(tree.getSnapshot().directoryErrors).toEqual({
    src: "temporary failure",
  });
  expect(tree.getSnapshot().rootStatus).toBe("ready");

  tree.retry("src");
  await settle();
  expect(tree.getSnapshot().directoryErrors).toEqual({});
  expect(model.getItem("src/index.astro")).not.toBeNull();
});

test("expanding a directory lists it once", async () => {
  const { fetched, model, tree } = createTree();
  tree.load(0);
  await settle();

  expand(model, "src");
  await settle();
  const item = model.getItem("src/");
  if (item?.isDirectory() && "collapse" in item) item.collapse();
  expand(model, "src");
  await settle();

  expect(fetched()).toEqual([".", "src"]);
});

test("a search filters what is loaded and never lists a directory", async () => {
  const { fetched, search, tree } = createTree();
  tree.load(0);
  await settle();

  search("src");
  await settle();

  expect(fetched()).toEqual(["."]);
});

test("typing a filter injects the matching paths, without listing their directories", async () => {
  const { fetched, model, search, tree } = createTree();
  tree.load(0);
  await settle();

  search("button");
  await settle();

  expect(model.getSearchMatchingPaths()).toEqual(["src/components/Button.tsx"]);
  expect(fetched()).toEqual(["."]);
  // An injected match is a file the tree can select.
  model.getItem("src/components/Button.tsx")?.select();
  expect(tree.selectedFile(null)).toBe("src/components/Button.tsx");
});

test("matches for a filter the user has already changed are not injected", async () => {
  const { model, search, tree } = createTree();
  tree.load(0);
  await settle();

  search("button");
  // Before the injection runs, the filter changes to something else.
  model.setSearch("input");
  await settle();

  expect(model.getItem("src/components/Button.tsx")).toBeNull();
});

test("revealing an injected file lists its directory without a duplicate-path error", async () => {
  const { model, search, tree } = createTree();
  tree.load(0);
  await settle();
  search("404");
  await settle();
  model.closeSearch();

  await expect(tree.reveal("src/404.astro")).resolves.toBe("revealed");

  expect(model.getItem("src/index.astro")).not.toBeNull();
  expect(model.getSelectedPaths()).toEqual(["src/404.astro"]);
});

test("a deep reveal expands every ancestor and selects only the file", async () => {
  const { model, tree } = createTree();
  tree.load(0);
  await settle();
  model.getItem("README.md")?.select();

  await expect(tree.reveal("src/components/Input.tsx")).resolves.toBe(
    "revealed",
  );

  expect(model.getSelectedPaths()).toEqual(["src/components/Input.tsx"]);
});

test("a file not in the loaded project is missing; one overtaken by a refresh is not", async () => {
  const { tree } = createTree();
  tree.load(0);
  await settle();

  await expect(tree.reveal("src/gone.ts")).resolves.toBe("missing");

  const reveal = tree.reveal("src/components/Button.tsx");
  tree.load(1);
  await expect(reveal).resolves.toBe("superseded");
});

test("selecting a directory keeps the open file", async () => {
  const { model, tree } = createTree();
  tree.load(0);
  await settle();

  model.getItem("src/")?.select();
  expect(tree.selectedFile("README.md")).toBe("README.md");

  model.getItem("src/")?.deselect();
  model.getItem("README.md")?.select();
  expect(tree.selectedFile(null)).toBe("README.md");
});

test("a version loads once; a new version or a detach loads again", async () => {
  const { fetched, tree } = createTree();
  tree.load(0);
  tree.load(0);
  await settle();
  expect(fetched()).toEqual(["."]);

  tree.load(1);
  await settle();
  expect(fetched()).toEqual([".", "."]);

  // StrictMode's simulated unmount: the same version loads again after.
  tree.detach();
  tree.attach();
  tree.load(1);
  await settle();
  expect(fetched()).toEqual([".", ".", "."]);
  expect(tree.getSnapshot().rootStatus).toBe("ready");
});

test("a refresh drops what the path index held", async () => {
  const { filesFetch, search, tree } = createTree();
  tree.load(0);
  await settle();
  search("button");
  await settle();

  tree.load(1);
  await settle();
  search("input");
  await settle();

  expect(filesFetch).toHaveBeenCalledTimes(2);
});

test("one listing of 10,000 entries lands in the model in one batch", async () => {
  const entries = Array.from({ length: 10_000 }, (_, index) => ({
    kind: "file" as const,
    path: `file-${String(index).padStart(5, "0")}.txt`,
  }));
  const { model, tree } = createTree({
    fetchDirectory: async (directory) => ({ directory, entries }),
  });

  const batch = vi.spyOn(model, "batch");
  tree.load(0);
  await settle();

  expect(batch).toHaveBeenCalledExactlyOnceWith(
    entries.map(({ path }) => ({ path, type: "add" })),
  );
  expect(model.getItem("file-09999.txt")?.getPath()).toBe("file-09999.txt");
});
