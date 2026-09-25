import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

const { userDataDir } = vi.hoisted(() => ({
  userDataDir: `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/dream-worktree-parent-test-${process.pid}`,
}));

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
}));

const { removeEmptyAppWorktreeParent } = await import("./core.js");

// The legacy root: `<userData>/worktrees`.
const worktreesRoot = path.join(userDataDir, "worktrees");
const repoFolder = path.join(worktreesRoot, "umami-e8f0685632");
const exists = async (target) =>
  fs.access(target).then(
    () => true,
    () => false,
  );

afterEach(async () => {
  await fs.rm(userDataDir, { force: true, recursive: true });
});

test("removes the per-repo folder once its last worktree is gone", async () => {
  await fs.mkdir(repoFolder, { recursive: true });

  const removed = await removeEmptyAppWorktreeParent(
    path.join(repoFolder, "umami-umami-test"),
  );

  assert.equal(removed, true);
  assert.equal(await exists(repoFolder), false);
  assert.equal(await exists(worktreesRoot), true);
});

test("keeps the per-repo folder while it still holds anything", async () => {
  await fs.mkdir(path.join(repoFolder, "umami-other-branch"), {
    recursive: true,
  });

  const removed = await removeEmptyAppWorktreeParent(
    path.join(repoFolder, "umami-umami-test"),
  );

  assert.equal(removed, false);
  assert.equal(await exists(path.join(repoFolder, "umami-other-branch")), true);
});

test("never touches folders outside the app worktree roots", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dream-outside-"));
  const emptyParent = path.join(outside, "repo");
  await fs.mkdir(emptyParent);

  try {
    const removed = await removeEmptyAppWorktreeParent(
      path.join(emptyParent, "worktree"),
    );
    assert.equal(removed, false);
    assert.equal(await exists(emptyParent), true);
  } finally {
    await fs.rm(outside, { force: true, recursive: true });
  }
});

test("does not remove the worktrees root itself", async () => {
  await fs.mkdir(worktreesRoot, { recursive: true });

  const removed = await removeEmptyAppWorktreeParent(
    path.join(worktreesRoot, "stray-folder"),
  );

  assert.equal(removed, false);
  assert.equal(await exists(worktreesRoot), true);
});
