import { performance } from "node:perf_hooks";
import { FileTree } from "@pierre/trees";
import { ProjectFileTree } from "../src/components/ide/project-file-tree";

const entries = Array.from({ length: 10_000 }, (_, index) => ({
  kind: "file" as const,
  path: `file-${String(index).padStart(5, "0")}.txt`,
}));
const model = new FileTree({
  flattenEmptyDirectories: false,
  initialExpansion: "closed",
  paths: [],
});
const tree = new ProjectFileTree({
  fetchDirectory: async (directory) => ({ directory, entries }),
  fetchFiles: async () => entries.map(({ path }) => path),
  model,
});

tree.attach();
try {
  const startedAt = performance.now();
  await new Promise<void>((resolve, reject) => {
    const unsubscribe = tree.subscribe(() => {
      const snapshot = tree.getSnapshot();
      if (snapshot.rootStatus === "ready") {
        unsubscribe();
        resolve();
      } else if (snapshot.rootStatus === "error") {
        unsubscribe();
        reject(new Error(snapshot.directoryErrors["."]));
      }
    });
    tree.load(0);
  });
  console.log(
    JSON.stringify(
      {
        node: process.version,
        entries: entries.length,
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      },
      null,
      2,
    ),
  );
} finally {
  tree.detach();
  model.cleanUp();
}
