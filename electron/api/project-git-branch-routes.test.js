import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { afterEach, test, vi } from "vitest";

const { registerProjectGitRoutes } = await import("./project-git-routes.js");

const execFileAsync = promisify(execFile);
const hasGit = await execFileAsync("git", ["--version"]).then(
  () => true,
  () => false,
);
const gitTest = hasGit ? test : test.skip;

// Real git in temporary repositories is slow on Windows under a parallel run.
vi.setConfig({ testTimeout: 30_000 });

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        fs.rm(directory, { force: true, maxRetries: 5, recursive: true }),
      ),
  );
});

const git = async (cwd, args) => {
  const result = await execFileAsync(
    "git",
    ["-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true },
  );
  return result.stdout.trim();
};

const createTempDirectory = async (prefix) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  temporaryDirectories.push(directory);
  return directory;
};

const commitFile = async (cwd, filePath, message) => {
  await fs.writeFile(path.join(cwd, filePath), `${message}\n`);
  await git(cwd, ["add", "--", filePath]);
  await git(cwd, ["commit", "-m", message]);
};

const createRepo = async () => {
  const repoPath = await createTempDirectory("dream-branch-repo-");
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "Dream Test"]);
  await commitFile(repoPath, "README.md", "Initial commit");
  return repoPath;
};

/** `name`, branched from main, with `count` commits main does not have. */
const createBranch = async (repoPath, name, count = 0) => {
  await git(repoPath, ["checkout", "-b", name]);
  for (let index = 0; index < count; index += 1) {
    await commitFile(repoPath, `${name}-${index}.txt`, `${name} ${index}`);
  }
  await git(repoPath, ["checkout", "main"]);
};

/** A clone whose `origin` is a bare copy of `repoPath`. */
const createClone = async (repoPath) => {
  const parent = await createTempDirectory("dream-branch-remote-");
  const bare = path.join(parent, "origin.git");
  await git(parent, ["clone", "--bare", repoPath, bare]);
  const clonePath = path.join(parent, "clone");
  await git(parent, ["clone", bare, clonePath]);
  await git(clonePath, ["config", "user.email", "test@example.com"]);
  await git(clonePath, ["config", "user.name", "Dream Test"]);
  return clonePath;
};

const createWorktree = async (repoPath, branchName) => {
  const parent = await createTempDirectory("dream-branch-tree-");
  const worktreePath = path.join(parent, "wt");
  await git(repoPath, ["worktree", "add", "-b", branchName, worktreePath]);
  await git(worktreePath, ["config", "user.email", "test@example.com"]);
  await git(worktreePath, ["config", "user.name", "Dream Test"]);
  return worktreePath;
};

const createApp = () => {
  const app = new Hono();
  registerProjectGitRoutes(app);
  return app;
};

const post = (route, body) =>
  createApp().request(route, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

const expectJson = async (response) => {
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
};

const preview = async (projectPath, branchName, options = {}) =>
  expectJson(
    await post("/api/project-git-branch-delete-preview", {
      branchName,
      projectPath,
      ...options,
    }),
  );

const remove = (projectPath, branchName, options = {}) =>
  post("/api/project-git-branch-delete", {
    branchName,
    projectPath,
    ...options,
  });

const cleanup = async (projectPath, worktreePath, options) =>
  expectJson(
    await post("/api/project-git-worktree-cleanup", {
      projectPath,
      worktreePath,
      ...options,
    }),
  );

const branchExists = (repoPath, name) =>
  git(repoPath, ["show-ref", "--verify", `refs/heads/${name}`]).then(
    () => true,
    () => false,
  );

const listBranches = async (projectPath) =>
  expectJson(await post("/api/project-git-branches", { projectPath }));

const findBranch = (list, name) =>
  list.branches.find((branch) => branch.name === name);

gitTest("the branch list says which branches cannot be deleted", async () => {
  const repoPath = await createRepo();
  await createBranch(repoPath, "topic");
  const worktreePath = await createWorktree(repoPath, "in-worktree");

  const fromMain = await listBranches(repoPath);
  assert.equal(findBranch(fromMain, "main").deleteBlockedReason, "current");
  assert.equal(findBranch(fromMain, "topic").deleteBlockedReason, null);
  assert.equal(findBranch(fromMain, "topic").checkedOutAt, null);
  assert.equal(findBranch(fromMain, "in-worktree").deleteBlockedReason, null);
  assert.ok(findBranch(fromMain, "in-worktree").checkedOutAt);

  // From the worktree, its own branch is current and main is the base.
  const fromWorktree = await listBranches(worktreePath);
  assert.equal(
    findBranch(fromWorktree, "in-worktree").deleteBlockedReason,
    "current",
  );
  assert.equal(findBranch(fromWorktree, "main").deleteBlockedReason, "base");
});

gitTest("the main checkout's branch is blocked from a worktree", async () => {
  const repoPath = await createRepo();
  await createBranch(repoPath, "other");
  await git(repoPath, ["checkout", "other"]);
  const worktreePath = await createWorktree(repoPath, "in-worktree");

  const list = await listBranches(worktreePath);
  assert.equal(findBranch(list, "other").deleteBlockedReason, "main-checkout");
});

gitTest("a merged branch is deleted without a confirmed head", async () => {
  const repoPath = await createRepo();
  await createBranch(repoPath, "topic", 1);
  await git(repoPath, ["merge", "--no-edit", "topic"]);

  const state = await preview(repoPath, "topic");
  assert.equal(state.blockedReason, null);
  assert.equal(state.baseBranch, "main");
  assert.equal(state.unmergedCount, 0);
  assert.equal(state.localOnlyCount, 0);

  const payload = await expectJson(await remove(repoPath, "topic"));
  assert.equal(payload.deleted, "topic");
  assert.deepEqual(
    payload.branches.map((branch) => branch.name),
    ["main"],
  );
  assert.equal(await branchExists(repoPath, "topic"), false);
});

gitTest(
  "a branch merged into the base goes even when git's own check refuses",
  async () => {
    const repoPath = await createRepo();
    await createBranch(repoPath, "topic", 1);
    await git(repoPath, ["merge", "--no-edit", "topic"]);
    // `git branch -d` compares with HEAD, which does not have topic's commit.
    await git(repoPath, ["checkout", "-b", "elsewhere", "HEAD~1"]);

    await expectJson(await remove(repoPath, "topic"));
    assert.equal(await branchExists(repoPath, "topic"), false);
  },
);

gitTest("an unmerged branch needs its head confirmed", async () => {
  const repoPath = await createRepo();
  await createBranch(repoPath, "topic", 3);

  const state = await preview(repoPath, "topic");
  assert.equal(state.unmergedCount, 3);
  assert.equal(state.localOnlyCount, 3);
  assert.equal(state.head, await git(repoPath, ["rev-parse", "topic"]));

  const refused = await remove(repoPath, "topic");
  assert.equal(refused.status, 409);
  assert.equal(await branchExists(repoPath, "topic"), true);

  await expectJson(
    await remove(repoPath, "topic", { confirmedHead: state.head }),
  );
  assert.equal(await branchExists(repoPath, "topic"), false);
});

gitTest("a branch that moved after it was reviewed is kept", async () => {
  const repoPath = await createRepo();
  await createBranch(repoPath, "topic", 1);
  const { head } = await preview(repoPath, "topic");

  await git(repoPath, ["checkout", "topic"]);
  await commitFile(repoPath, "later.txt", "Later work");
  await git(repoPath, ["checkout", "main"]);

  const refused = await remove(repoPath, "topic", { confirmedHead: head });
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /changed after it was reviewed/);
  assert.equal(await branchExists(repoPath, "topic"), true);
});

gitTest(
  "a squash-merged branch counts as unmerged but on the remote",
  async () => {
    const origin = await createRepo();
    const repoPath = await createClone(origin);
    await createBranch(repoPath, "topic", 2);
    await git(repoPath, ["push", "-u", "origin", "topic"]);
    await git(repoPath, ["merge", "--squash", "topic"]);
    await git(repoPath, ["commit", "-m", "Squashed topic"]);

    const state = await preview(repoPath, "topic");
    assert.equal(state.unmergedCount, 2);
    assert.equal(state.localOnlyCount, 0);
  },
);

gitTest("commits on the remote's base branch count as merged", async () => {
  const origin = await createRepo();
  const repoPath = await createClone(origin);
  await createBranch(repoPath, "topic", 1);
  await git(repoPath, ["push", "origin", "topic:main"]);
  await git(repoPath, ["fetch", "origin"]);

  // Local main has not moved; origin/main has the commit.
  const state = await preview(repoPath, "topic");
  assert.equal(state.unmergedCount, 0);
});

gitTest("the current and base branches are never deleted", async () => {
  const repoPath = await createRepo();
  await createBranch(repoPath, "topic");
  const head = await git(repoPath, ["rev-parse", "main"]);

  const current = await remove(repoPath, "main", { confirmedHead: head });
  assert.equal(current.status, 409);
  assert.match(await current.text(), /current branch/);

  await git(repoPath, ["checkout", "topic"]);
  const base = await remove(repoPath, "main", { confirmedHead: head });
  assert.equal(base.status, 409);
  assert.match(await base.text(), /base branch/);
  assert.equal(await branchExists(repoPath, "main"), true);
});

gitTest("a branch checked out in a worktree is not deleted alone", async () => {
  const repoPath = await createRepo();
  const worktreePath = await createWorktree(repoPath, "in-worktree");
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);

  const state = await preview(repoPath, "in-worktree");
  assert.equal(state.blockedReason, null);
  assert.equal(path.relative(state.checkedOutAt, worktreePath), "");

  const refused = await remove(repoPath, "in-worktree", {
    confirmedHead: head,
  });
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /checked out at/);
  assert.equal(await branchExists(repoPath, "in-worktree"), true);
});

gitTest(
  "removing a worktree does not count its own checkout against the delete",
  async () => {
    const repoPath = await createRepo();
    const worktreePath = await createWorktree(repoPath, "in-worktree");

    // Asked from the worktree itself, as its own project's sidebar does.
    const state = await preview(worktreePath, "in-worktree", {
      removingWorktreePath: worktreePath,
    });
    assert.equal(state.blockedReason, null);
    assert.equal(state.checkedOutAt, null);

    const notRemoving = await preview(worktreePath, "in-worktree");
    assert.equal(notRemoving.blockedReason, "current");
  },
);

gitTest(
  "cleanup deletes an unmerged branch against its confirmed head",
  async () => {
    const repoPath = await createRepo();
    const worktreePath = await createWorktree(repoPath, "feature/gone");
    await commitFile(worktreePath, "work.txt", "Unmerged work");
    const { head } = await preview(repoPath, "feature/gone", {
      removingWorktreePath: worktreePath,
    });

    const payload = await cleanup(repoPath, worktreePath, {
      confirmedBranchHead: head,
      deleteBranch: true,
    });
    assert.equal(payload.removed, true);
    assert.equal(payload.branchDeleted, true);
    assert.equal(await branchExists(repoPath, "feature/gone"), false);
  },
);

gitTest(
  "a confirmed head from another commit keeps the branch in cleanup",
  async () => {
    const repoPath = await createRepo();
    const worktreePath = await createWorktree(repoPath, "feature/moved");
    const { head } = await preview(repoPath, "feature/moved", {
      removingWorktreePath: worktreePath,
    });
    await commitFile(worktreePath, "later.txt", "Later work");

    const payload = await cleanup(repoPath, worktreePath, {
      confirmedBranchHead: head,
      deleteBranch: true,
    });
    assert.equal(payload.removed, true);
    assert.equal(payload.branchDeleted, false);
    assert.match(payload.branchDeleteError, /changed after it was reviewed/);
    assert.equal(await branchExists(repoPath, "feature/moved"), true);
  },
);

gitTest("an unknown branch is answered as not found", async () => {
  const repoPath = await createRepo();
  assert.equal((await remove(repoPath, "--force")).status, 404);
  assert.equal(
    (
      await post("/api/project-git-branch-delete-preview", {
        branchName: "nope",
        projectPath: repoPath,
      })
    ).status,
    404,
  );
});

test("a confirmed head has to be a commit id", async () => {
  const response = await post("/api/project-git-branch-delete", {
    branchName: "topic",
    confirmedHead: "HEAD",
    projectPath: os.tmpdir(),
  });
  assert.equal(response.status, 400);
});
