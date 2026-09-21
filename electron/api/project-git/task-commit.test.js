import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/dream-test-user-data" },
}));

const { commitTaskStepWork } = await import("./task-commit.js");

// Every test drives real git in a temporary repository, which is slow on
// Windows when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

const repos = [];

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createRepo = () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "dream-task-commit-"));
  repos.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(cwd, "app.txt"), "one\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "Initial");
  return cwd;
};

afterEach(() => {
  for (const cwd of repos.splice(0)) {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("commits tracked and untracked work with the generated message", async () => {
  const cwd = createRepo();
  writeFileSync(path.join(cwd, "app.txt"), "two\n");
  writeFileSync(path.join(cwd, "new.txt"), "new\n");

  const result = await commitTaskStepWork(cwd, {
    fallbackMessage: "Add a slider",
    generateMessage: async () => "Add reusable slider component\n\nBody",
  });

  assert.equal(result.committed, true);
  assert.equal(result.commitMessage, "Add reusable slider component");
  assert.equal(git(cwd, "log", "-1", "--format=%s"), result.commitMessage);
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.equal(result.commitHash, git(cwd, "rev-parse", "--short", "HEAD"));
});

test("falls back to the task title when no message can be generated", async () => {
  const cwd = createRepo();
  writeFileSync(path.join(cwd, "app.txt"), "two\n");

  const failed = await commitTaskStepWork(cwd, {
    fallbackMessage: "Add a slider",
    generateMessage: async () => {
      throw new Error("model unavailable");
    },
  });
  assert.equal(failed.commitMessage, "Add a slider");

  writeFileSync(path.join(cwd, "app.txt"), "three\n");
  const empty = await commitTaskStepWork(cwd, {
    fallbackMessage: "Add a slider",
    generateMessage: async () => "  ",
  });
  assert.equal(empty.commitMessage, "Add a slider");
});

test("a clean tree is not an error: the agent may have committed itself", async () => {
  const cwd = createRepo();
  const head = git(cwd, "rev-parse", "HEAD");

  const result = await commitTaskStepWork(cwd, {
    generateMessage: async () => {
      throw new Error("must not be called with nothing to commit");
    },
  });

  assert.equal(result.committed, false);
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
});

test("a rejecting pre-commit hook surfaces its output and leaves no commit", async () => {
  const cwd = createRepo();
  const hook = path.join(cwd, ".git", "hooks", "pre-commit");
  writeFileSync(hook, '#!/bin/sh\necho "lint: app.txt is wrong" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  writeFileSync(path.join(cwd, "app.txt"), "two\n");
  const head = git(cwd, "rev-parse", "HEAD");

  await assert.rejects(
    commitTaskStepWork(cwd, { fallbackMessage: "Add a slider" }),
    /lint: app\.txt is wrong/,
  );
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
});

const startConflictingMerge = (cwd) => {
  git(cwd, "checkout", "-q", "-b", "task/slider");
  writeFileSync(path.join(cwd, "app.txt"), "task\n");
  git(cwd, "commit", "-q", "-am", "Task change");
  git(cwd, "checkout", "-q", "main");
  writeFileSync(path.join(cwd, "app.txt"), "main\n");
  git(cwd, "commit", "-q", "-am", "Main change");
  git(cwd, "checkout", "-q", "task/slider");
  try {
    git(cwd, "merge", "--no-commit", "main");
  } catch {
    // The conflict makes `git merge` exit non-zero.
  }
};

test("refuses to record unresolved conflicts as resolved", async () => {
  const cwd = createRepo();
  startConflictingMerge(cwd);

  await assert.rejects(
    commitTaskStepWork(cwd, { fallbackMessage: "Ship" }),
    /Unresolved merge conflicts in: app\.txt/,
  );
  // Still mid-merge, with the conflict intact for the agent to fix.
  assert.match(git(cwd, "status", "--porcelain"), /^UU app\.txt/);
});

test("refuses to commit in the middle of a rebase", async () => {
  const cwd = createRepo();
  git(cwd, "checkout", "-q", "-b", "task/slider");
  writeFileSync(path.join(cwd, "app.txt"), "task\n");
  git(cwd, "commit", "-q", "-am", "Task change");
  git(cwd, "checkout", "-q", "main");
  writeFileSync(path.join(cwd, "app.txt"), "main\n");
  git(cwd, "commit", "-q", "-am", "Main change");
  git(cwd, "checkout", "-q", "task/slider");
  try {
    git(cwd, "rebase", "main");
  } catch {
    // The conflict stops the rebase half-way.
  }
  const head = git(cwd, "rev-parse", "HEAD");

  await assert.rejects(
    commitTaskStepWork(cwd, { fallbackMessage: "Ship" }),
    /rebase is still in progress/,
  );
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
});

test("concludes a merge the agent resolved, with git's merge message", async () => {
  const cwd = createRepo();
  startConflictingMerge(cwd);
  writeFileSync(path.join(cwd, "app.txt"), "main and task\n");
  git(cwd, "add", "app.txt");

  const result = await commitTaskStepWork(cwd, {
    generateMessage: async () => {
      throw new Error("a merge commit keeps git's own message");
    },
  });

  assert.equal(result.committed, true);
  assert.equal(result.merge, true);
  assert.match(git(cwd, "log", "-1", "--format=%s"), /^Merge branch 'main'/);
  assert.equal(git(cwd, "log", "-1", "--format=%P").split(" ").length, 2);
  assert.equal(git(cwd, "status", "--porcelain"), "");
});
