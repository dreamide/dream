import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

const { pullProjectGitChanges } = await import("./actions.js");

// Every test drives real git in temporary repositories, which is slow on
// Windows when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

const roots = [];

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const configure = (cwd) => {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "commit.gpgsign", "false");
};

const commitFile = (cwd, name, content, message) => {
  writeFileSync(path.join(cwd, name), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
};

/** A clone tracking a local bare "origin", plus a second clone of it. */
const createClones = () => {
  const root = mkdtempSync(path.join(tmpdir(), "dream-git-pull-"));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const other = path.join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  configure(repo);
  git(repo, "checkout", "-q", "-b", "main");
  commitFile(repo, "app.txt", "one\ntwo\n", "Initial");
  git(repo, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", origin, other);
  configure(other);
  return { other, repo };
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a pull reports the commits and files it brought in", async () => {
  const { other, repo } = createClones();
  commitFile(other, "app.txt", "one\nthree\n", "Change app");
  commitFile(other, "notes.txt", "a\nb\nc\n", "Add notes");
  git(other, "push", "-q", "origin", "main");

  const result = await pullProjectGitChanges(repo);

  assert.equal(result.commitCount, 2);
  assert.equal(result.upstreamBranch, "origin/main");
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.commits.map((commit) => commit.subject),
    ["Add notes", "Change app"],
  );
  assert.deepEqual(
    result.files.map(({ addedLines, path, removedLines, status }) => ({
      addedLines,
      path,
      removedLines,
      status,
    })),
    [
      { addedLines: 1, path: "app.txt", removedLines: 1, status: "modified" },
      { addedLines: 3, path: "notes.txt", removedLines: 0, status: "added" },
    ],
  );
});

test("a pull with nothing new reports no changes", async () => {
  const { repo } = createClones();

  const result = await pullProjectGitChanges(repo);

  assert.equal(result.commitCount, 0);
  assert.deepEqual(result.commits, []);
  assert.deepEqual(result.files, []);
});

test("a pull onto a diverged branch merges the remote commits", async () => {
  const { other, repo } = createClones();
  commitFile(other, "notes.txt", "a\nb\n", "Add notes");
  git(other, "push", "-q", "origin", "main");
  commitFile(repo, "local.txt", "local\n", "Local work");

  const result = await pullProjectGitChanges(repo);

  assert.equal(result.status, "pulled");
  assert.equal(result.merged, true);
  assert.equal(result.commitCount, 1);
  assert.deepEqual(
    result.commits.map((commit) => commit.subject),
    ["Add notes"],
  );
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["notes.txt"],
  );
  // A merge commit whose parents are the local work and the remote branch.
  assert.equal(
    git(repo, "rev-parse", "HEAD^2"),
    git(repo, "rev-parse", "origin/main"),
  );
  assert.equal(git(repo, "log", "-1", "--format=%s", "HEAD^1"), "Local work");
});

test("a conflicting pull is aborted and reports the conflicting files", async () => {
  const { other, repo } = createClones();
  commitFile(other, "app.txt", "one\nremote\n", "Remote change");
  git(other, "push", "-q", "origin", "main");
  commitFile(repo, "app.txt", "one\nlocal\n", "Local change");
  const headBefore = git(repo, "rev-parse", "HEAD");

  const result = await pullProjectGitChanges(repo);

  assert.equal(result.status, "conflict");
  assert.equal(result.commitCount, 0);
  assert.deepEqual(result.conflictingFiles, ["app.txt"]);
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("a pull refuses to touch a merge already in progress", async () => {
  const { other, repo } = createClones();
  commitFile(other, "app.txt", "one\nremote\n", "Remote change");
  git(other, "push", "-q", "origin", "main");
  commitFile(repo, "app.txt", "one\nlocal\n", "Local change");
  git(repo, "fetch", "-q", "origin");
  try {
    git(repo, "merge", "--no-edit", "origin/main");
  } catch {
    // The conflict is the point: the user is now mid-merge.
  }

  await assert.rejects(
    pullProjectGitChanges(repo),
    /merge is already in progress/,
  );
  // The user's merge is still there to finish.
  assert.ok(git(repo, "rev-parse", "--verify", "MERGE_HEAD"));
});

/** A repo whose local and remote commits both changed the same line. */
const createConflict = () => {
  const clones = createClones();
  commitFile(clones.other, "app.txt", "one\nremote\n", "Remote change");
  commitFile(clones.other, "notes.txt", "a\n", "Add notes");
  git(clones.other, "push", "-q", "origin", "main");
  commitFile(clones.repo, "app.txt", "one\nlocal\n", "Local change");
  return clones;
};

const readApp = (repo) => git(repo, "show", "HEAD:app.txt");

test("keeping mine merges and settles conflicting lines with the local side", async () => {
  const { repo } = createConflict();

  const result = await pullProjectGitChanges(repo, { strategy: "ours" });

  assert.equal(result.status, "pulled");
  assert.equal(result.merged, true);
  assert.equal(result.commitCount, 2);
  assert.equal(readApp(repo), "one\nlocal");
  // Changes that did not conflict still come in.
  assert.equal(git(repo, "show", "HEAD:notes.txt"), "a");
  assert.equal(
    git(repo, "rev-parse", "HEAD^2"),
    git(repo, "rev-parse", "origin/main"),
  );
});

test("taking theirs merges and settles conflicting lines with the remote side", async () => {
  const { repo } = createConflict();

  const result = await pullProjectGitChanges(repo, { strategy: "theirs" });

  assert.equal(result.status, "pulled");
  assert.equal(result.merged, true);
  assert.equal(readApp(repo), "one\nremote");
  assert.equal(git(repo, "log", "-1", "--format=%s", "HEAD^1"), "Local change");
});

test("a rebase pull replays local commits on the remote branch", async () => {
  const { other, repo } = createClones();
  commitFile(other, "notes.txt", "a\nb\n", "Add notes");
  git(other, "push", "-q", "origin", "main");
  commitFile(repo, "local.txt", "local\n", "Local work");

  const result = await pullProjectGitChanges(repo, { strategy: "rebase" });

  assert.equal(result.status, "pulled");
  assert.equal(result.rebased, true);
  assert.equal(result.merged, false);
  assert.equal(result.commitCount, 1);
  assert.deepEqual(
    result.commits.map((commit) => commit.subject),
    ["Add notes"],
  );
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["notes.txt"],
  );
  // No merge commit: the local commit sits on top of the remote branch.
  assert.equal(git(repo, "log", "-1", "--format=%s", "HEAD"), "Local work");
  assert.equal(
    git(repo, "rev-parse", "HEAD^"),
    git(repo, "rev-parse", "origin/main"),
  );
});

test("a conflicting rebase pull is aborted and reports the conflicting files", async () => {
  const { repo } = createConflict();
  const headBefore = git(repo, "rev-parse", "HEAD");

  const result = await pullProjectGitChanges(repo, { strategy: "rebase" });

  assert.equal(result.status, "conflict");
  assert.equal(result.strategy, "rebase");
  assert.deepEqual(result.conflictingFiles, ["app.txt"]);
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main");
});

test("a pull refuses to touch a rebase already in progress", async () => {
  const { repo } = createConflict();
  git(repo, "fetch", "-q", "origin");
  try {
    git(repo, "rebase", "origin/main");
  } catch {
    // The conflict is the point: the user is now mid-rebase.
  }

  await assert.rejects(
    pullProjectGitChanges(repo, { strategy: "merge" }),
    /rebase is already in progress/,
  );
  assert.ok(git(repo, "rev-parse", "--verify", "REBASE_HEAD"));
});
