// A branch's base (repository-context.js `baseOf`) in real temporary
// repositories, and the callers that read it: the push preview, the worktree
// compare, branch deletion's merge check and pull request details.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

const { getProjectGitPushPreview } = await import("./actions.js");
const { generatedGitText } = await import("./generated-text.js");
const { previewProjectGitBranchDelete } = await import("./branches.js");
const { gitRepositories } = await import("./core.js");
const { compareProjectGitWorktree } = await import("./worktree-lifecycle.js");

// Real git in temporary repositories is slow on Windows under a parallel run.
vi.setConfig({ testTimeout: 30_000 });

const roots = [];

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const configure = (cwd) => {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "commit.gpgsign", "false");
};

const commitFile = (cwd, name, message) => {
  writeFileSync(path.join(cwd, name), `${message}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
};

const createRoot = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dream-base-")));
  roots.push(root);
  return root;
};

/** A repository with no remote, on `branch`. */
const createLocalRepo = (branch = "main") => {
  const repo = path.join(createRoot(), "repo");
  git(path.dirname(repo), "init", "-q", "-b", branch, repo);
  configure(repo);
  commitFile(repo, "app.txt", "Initial");
  return repo;
};

/** A clone tracking a local bare "origin", plus a second clone of it. */
const createClones = () => {
  const root = createRoot();
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const other = path.join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  configure(repo);
  git(repo, "checkout", "-q", "-b", "main");
  commitFile(repo, "app.txt", "Initial");
  git(repo, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", origin, other);
  configure(other);
  return { other, repo, root };
};

/**
 * Local `main` and `origin/main` each have a commit the other lacks:
 * "Local base" only here, "Remote base" only on the remote.
 */
const createDivergedBase = () => {
  const clones = createClones();
  commitFile(clones.other, "remote.txt", "Remote base");
  git(clones.other, "push", "-q", "origin", "main");
  commitFile(clones.repo, "local.txt", "Local base");
  git(clones.repo, "fetch", "-q", "origin");
  return clones;
};

const addWorktree = (repo, root, branch) => {
  const worktree = path.join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", branch, worktree);
  configure(worktree);
  return worktree;
};

afterEach(() => {
  // Each test changes its repositories with git directly, which the host's
  // repository context only learns of when its facts expire.
  gitRepositories.forget();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a base only on this machine is both the compare and the merge ref", async () => {
  const repo = createLocalRepo();

  assert.deepEqual(await gitRepositories.baseOf(repo), {
    baseBranch: "main",
    compareRef: "refs/heads/main",
    localRef: "refs/heads/main",
    mergeRef: "refs/heads/main",
    remoteName: null,
    remoteRef: null,
  });
});

test("a base only on the remote is both the compare and the merge ref", async () => {
  const { repo, root } = createClones();
  git(repo, "checkout", "-q", "-b", "feature");
  git(repo, "branch", "-q", "-D", "main");

  const base = await gitRepositories.baseOf(repo);
  assert.deepEqual(base, {
    baseBranch: "main",
    compareRef: "refs/remotes/origin/main",
    localRef: null,
    mergeRef: "refs/remotes/origin/main",
    remoteName: "origin",
    remoteRef: "refs/remotes/origin/main",
  });

  // A worktree merging into it compares with the remote branch, which the
  // merge's checkout would create the local one from.
  const worktree = addWorktree(repo, root, "task");
  commitFile(worktree, "task.txt", "Task");
  const compare = await compareProjectGitWorktree(worktree);
  assert.equal(compare.baseBranch, "main");
  assert.equal(compare.baseExistsLocally, false);
  assert.equal(compare.compareRef, "refs/remotes/origin/main");
  assert.equal(compare.aheadCount, 1);
});

test("a diverged base compares with the remote and merges into the local branch", async () => {
  const { repo, root } = createDivergedBase();

  const base = await gitRepositories.baseOf(repo);
  assert.equal(base?.compareRef, "refs/remotes/origin/main");
  assert.equal(base?.mergeRef, "refs/heads/main");
  assert.equal(base?.localRef, "refs/heads/main");
  assert.equal(base?.remoteRef, "refs/remotes/origin/main");

  // A branch with no upstream, started from the local base: what pushing it
  // adds to the remote includes the local base's unpushed commit.
  git(repo, "checkout", "-q", "-b", "feature");
  commitFile(repo, "feature.txt", "Feature");
  const preview = await getProjectGitPushPreview(repo);
  assert.equal(preview.baseRef, "refs/remotes/origin/main");
  assert.deepEqual(
    preview.commits.map((commit) => commit.subject),
    ["Feature", "Local base"],
  );
  assert.equal(preview.aheadCount, 2);

  // So does the pull request into it, which GitHub compares with its main.
  const details = await generatedGitText.pullRequestDetails(repo);
  assert.equal(details.baseBranch, "main");
  assert.equal(details.headBranch, "feature");
  assert.equal(details.title, "Feature");
  assert.match(details.description, /- Local base/);

  // The deliberate difference: a worktree is merged into the local base
  // branch, so it is ahead and behind that, not the remote one.
  git(repo, "checkout", "-q", "main");
  const worktree = addWorktree(repo, root, "task");
  commitFile(worktree, "task.txt", "Task");
  const compare = await compareProjectGitWorktree(worktree);
  assert.equal(compare.compareRef, "refs/heads/main");
  assert.equal(compare.baseExistsLocally, true);
  assert.equal(compare.aheadCount, 1);
  assert.equal(compare.behindCount, 0);
  assert.deepEqual(
    compare.commits.map((commit) => commit.subject),
    ["Task"],
  );
});

test("a branch is merged when its commits are in either ref of the base", async () => {
  const { repo } = createDivergedBase();
  git(repo, "branch", "in-local", "main");
  git(repo, "branch", "in-remote", "origin/main");
  git(repo, "checkout", "-q", "-b", "unmerged");
  commitFile(repo, "unmerged.txt", "Unmerged");
  git(repo, "checkout", "-q", "main");

  for (const [branchName, unmergedCount] of [
    ["in-local", 0],
    ["in-remote", 0],
    ["unmerged", 1],
  ]) {
    const preview = await previewProjectGitBranchDelete(repo, { branchName });
    assert.equal(preview.baseBranch, "main", branchName);
    assert.equal(preview.unmergedCount, unmergedCount, branchName);
  }
});

test("a requested base is read the same way as the default one", async () => {
  const { repo } = createClones();
  git(repo, "branch", "release");

  const base = await gitRepositories.baseOf(repo, {
    base: "refs/heads/release",
  });
  assert.equal(base?.baseBranch, "release");
  assert.equal(base?.compareRef, "refs/heads/release");
  assert.equal(await gitRepositories.baseOf(repo, { base: "missing" }), null);
});

test("with no base found, each caller says so in its own words", async () => {
  const repo = createLocalRepo("trunk");
  git(repo, "checkout", "-q", "-b", "feature");
  commitFile(repo, "feature.txt", "Feature");

  assert.equal(await gitRepositories.baseOf(repo), null);

  await assert.rejects(generatedGitText.pullRequestDetails(repo), {
    message: "Unable to determine the base branch for this pull request.",
  });

  const preview = await previewProjectGitBranchDelete(repo, {
    branchName: "feature",
  });
  assert.equal(preview.baseBranch, null);
  assert.equal(preview.unmergedCount, null);

  git(repo, "checkout", "-q", "trunk");
  const worktree = addWorktree(repo, path.dirname(repo), "task");
  await assert.rejects(compareProjectGitWorktree(worktree), {
    message: "Unable to determine the base branch for this worktree.",
  });
  await assert.rejects(
    compareProjectGitWorktree(worktree, { baseRef: "develop" }),
    { message: 'Base branch "develop" was not found.' },
  );
});
