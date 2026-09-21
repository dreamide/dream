import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/dream-test-user-data" },
}));

const { commitTaskStepWork } = await import("./task-commit.js");
const {
  TASK_WORKTREE_MISSING,
  getTaskWorktreeStatus,
  isGitCheckout,
  recreateTaskWorktree,
} = await import("./task-worktree.js");

// Every test drives real git in a temporary repository, which is slow on
// Windows when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

const BRANCH = "task/add-a-select-640f88";
const roots = [];

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repository with a task worktree holding one commit of task work. */
const createRepoWithTaskWorktree = () => {
  const root = mkdtempSync(path.join(tmpdir(), "dream-task-worktree-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktreePath = path.join(root, "worktrees", "select");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "app.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial");
  git(repo, "worktree", "add", "-q", "-b", BRANCH, worktreePath);
  writeFileSync(path.join(worktreePath, "select.txt"), "select\n");
  git(worktreePath, "add", "-A");
  git(worktreePath, "commit", "-q", "-m", "Add select");
  return { repo, root, worktreePath };
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("reports a healthy worktree, then one whose folder was deleted", async () => {
  const { repo, worktreePath } = createRepoWithTaskWorktree();
  const worktree = { branch: BRANCH, worktreePath };

  assert.deepEqual(await getTaskWorktreeStatus(repo, worktree), {
    branchExists: true,
    isCheckout: true,
  });

  rmSync(worktreePath, { force: true, recursive: true });
  assert.deepEqual(await getTaskWorktreeStatus(repo, worktree), {
    branchExists: true,
    isCheckout: false,
  });

  assert.deepEqual(
    await getTaskWorktreeStatus(repo, { ...worktree, branch: "task/gone" }),
    { branchExists: false, isCheckout: false },
  );
});

test("a plain folder inside another repository is not a checkout", async () => {
  const { repo } = createRepoWithTaskWorktree();
  const nested = path.join(repo, "nested");
  mkdirSync(nested);

  assert.equal(await isGitCheckout(repo), true);
  assert.equal(await isGitCheckout(nested), false);
});

test("committing in a missing worktree is flagged as such, briefly", async () => {
  const { worktreePath } = createRepoWithTaskWorktree();
  rmSync(worktreePath, { force: true, recursive: true });
  mkdirSync(worktreePath);

  await assert.rejects(
    commitTaskStepWork(worktreePath, { fallbackMessage: "Add select" }),
    (error) =>
      error.code === TASK_WORKTREE_MISSING &&
      /no longer a git checkout/.test(error.message) &&
      error.message.length < 300,
  );
});

test("recreates a deleted worktree from the task's branch, work included", async () => {
  const { repo, worktreePath } = createRepoWithTaskWorktree();
  rmSync(worktreePath, { force: true, recursive: true });

  const result = await recreateTaskWorktree(repo, {
    branch: BRANCH,
    worktreePath,
  });

  assert.equal(result.branch, BRANCH);
  assert.equal(await isGitCheckout(worktreePath), true);
  assert.equal(git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD"), BRANCH);
  assert.equal(
    readFileSync(path.join(worktreePath, "select.txt"), "utf8"),
    "select\n",
  );

  // Doing it again, with the worktree healthy, changes nothing.
  const head = git(worktreePath, "rev-parse", "HEAD");
  await recreateTaskWorktree(repo, { branch: BRANCH, worktreePath });
  assert.equal(git(worktreePath, "rev-parse", "HEAD"), head);
});

test("never overwrites a folder that still holds files", async () => {
  const { repo, worktreePath } = createRepoWithTaskWorktree();
  rmSync(worktreePath, { force: true, recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(worktreePath, "notes.txt"), "mine\n");

  await assert.rejects(
    recreateTaskWorktree(repo, { branch: BRANCH, worktreePath }),
    /still contains files but is not a git checkout/,
  );
  assert.equal(existsSync(path.join(worktreePath, "notes.txt")), true);
});

test("cannot recreate a worktree whose branch is gone", async () => {
  const { repo, worktreePath } = createRepoWithTaskWorktree();
  rmSync(worktreePath, { force: true, recursive: true });
  git(repo, "worktree", "prune");
  git(repo, "branch", "-D", BRANCH);

  await assert.rejects(
    recreateTaskWorktree(repo, { branch: BRANCH, worktreePath }),
    /no longer exists, so the worktree cannot be recreated/,
  );
});
