import { expect, test } from "vitest";
import type { ProjectGitStatusEntry } from "@/types/ide";
import { toFileTreeGitStatus } from "./file-tree-git-status";

const change = (
  path: string,
  status: ProjectGitStatusEntry["status"],
): ProjectGitStatusEntry => ({
  addedLines: 0,
  path,
  previousPath: null,
  removedLines: 0,
  staged: false,
  status,
  unstaged: true,
});

test("changed files keep their project path and status", () => {
  expect(
    toFileTreeGitStatus([
      change("src/a.ts", "modified"),
      change("src/new.ts", "untracked"),
      change("old.md", "deleted"),
      change("src/moved.ts", "renamed"),
      change("src/staged.ts", "added"),
    ]),
  ).toEqual([
    { path: "src/a.ts", status: "modified" },
    { path: "src/new.ts", status: "untracked" },
    { path: "old.md", status: "deleted" },
    { path: "src/moved.ts", status: "renamed" },
    { path: "src/staged.ts", status: "added" },
  ]);
});

test("a copied file shows as added", () => {
  expect(toFileTreeGitStatus([change("b.ts", "copied")])).toEqual([
    { path: "b.ts", status: "added" },
  ]);
});
