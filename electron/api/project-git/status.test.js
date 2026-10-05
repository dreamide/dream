// Reading a project's Git status, against real repositories: what is
// changed, the branch, its upstream and how far apart they are, at both
// levels of detail, in the states a repository can be in, and at what cost
// in git processes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

// Every git process the status read starts, by its arguments.
const spawned = vi.hoisted(() => []);
vi.mock("../shared/cli.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileAsync: (command, args, options) => {
      if (command === "git") spawned.push(args);
      return actual.execFileAsync(command, args, options);
    },
  };
});

const { listProjectGitChanges, parseGitStatusBranchHeaders, runGitCommand } =
  await import("./core.js");

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

const write = (cwd, name, text) => {
  mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  writeFileSync(path.join(cwd, name), text);
};

const commit = (cwd, message) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
};

const tempRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "dream-git-status-"));
  roots.push(root);
  return root;
};

/** A clone of a local bare "origin" on main, one commit pushed. */
const createClone = () => {
  const root = tempRoot();
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  configure(repo);
  git(repo, "checkout", "-q", "-b", "main");
  write(repo, "app.txt", "one\ntwo\n");
  write(repo, "old.txt", "keep\nthese\nlines\n");
  commit(repo, "Initial");
  git(repo, "push", "-q", "-u", "origin", "main");
  return { origin, repo, root };
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const byPath = (status) =>
  Object.fromEntries(status.changes.map((change) => [change.path, change]));

test("a full read lists changes with line counts, branch and upstream", async () => {
  const { repo } = createClone();
  write(repo, "ahead.txt", "a\n");
  commit(repo, "Ahead");
  write(repo, "app.txt", "one\ntwo\nthree\n");
  git(repo, "mv", "old.txt", "new.txt");
  write(repo, "fresh/untracked.txt", "x\ny\n");

  const status = await listProjectGitChanges(repo);
  const changes = byPath(status);

  assert.equal(status.isRepo, true);
  assert.equal(status.branch, "main");
  assert.equal(status.upstreamBranch, "origin/main");
  assert.equal(status.remoteName, "origin");
  assert.equal(status.baseBranch, "main");
  assert.equal(status.aheadCount, 1);
  assert.equal(status.behindCount, 0);
  assert.deepEqual(Object.keys(changes).sort(), [
    "app.txt",
    "fresh/untracked.txt",
    "new.txt",
  ]);
  assert.equal(changes["app.txt"].status, "modified");
  assert.equal(changes["app.txt"].addedLines, 1);
  assert.equal(changes["app.txt"].unstaged, true);
  assert.equal(changes["new.txt"].status, "renamed");
  assert.equal(changes["new.txt"].previousPath, "old.txt");
  assert.equal(changes["new.txt"].staged, true);
  assert.equal(changes["fresh/untracked.txt"].status, "untracked");
  assert.equal(changes["fresh/untracked.txt"].addedLines, 2);
  assert.equal(status.fileCount, 3);
  assert.equal(
    status.addedLines,
    status.changes.reduce((total, change) => total + change.addedLines, 0),
  );
});

test("a branch behind its upstream says so", async () => {
  const { origin, repo, root } = createClone();
  const other = path.join(root, "other");
  git(root, "clone", "-q", origin, other);
  configure(other);
  write(other, "theirs.txt", "t\n");
  commit(other, "Theirs");
  git(other, "push", "-q");
  git(repo, "fetch", "-q");

  const status = await listProjectGitChanges(repo);

  assert.equal(status.aheadCount, 0);
  assert.equal(status.behindCount, 1);
});

test("a branch with no upstream has no counts", async () => {
  const { repo } = createClone();
  git(repo, "checkout", "-q", "-b", "feature");

  const status = await listProjectGitChanges(repo);

  assert.equal(status.branch, "feature");
  assert.equal(status.upstreamBranch, null);
  assert.equal(status.aheadCount, 0);
  assert.equal(status.behindCount, 0);
  assert.equal(status.baseBranch, "main");
});

test("a summary read skips untracked files, line counts and the remote", async () => {
  const { repo } = createClone();
  write(repo, "app.txt", "changed\n");
  write(repo, "untracked.txt", "u\n");

  const status = await listProjectGitChanges(repo, {
    includeMetadata: false,
    includeStats: false,
    includeUntracked: false,
  });

  assert.equal(status.branch, "main");
  assert.deepEqual(
    status.changes.map((change) => change.path),
    ["app.txt"],
  );
  assert.equal(status.changes[0].addedLines, 0);
  assert.equal(status.upstreamBranch, null);
  assert.equal(status.aheadCount, 0);
});

test("a detached HEAD is named by its short revision", async () => {
  const { repo } = createClone();
  const revision = git(repo, "rev-parse", "--short", "HEAD");
  git(repo, "checkout", "-q", "--detach");

  const status = await listProjectGitChanges(repo);

  assert.equal(status.branch, `HEAD ${revision}`);
  assert.equal(status.upstreamBranch, null);
});

test("a repository with no commits yet counts its files as new", async () => {
  const repo = tempRoot();
  git(repo, "init", "-q", "-b", "trunk");
  write(repo, "staged.txt", "s\nt\n");
  git(repo, "add", "staged.txt");
  write(repo, "loose.txt", "l\n");

  const status = await listProjectGitChanges(repo);
  const changes = byPath(status);

  assert.equal(status.branch, "trunk");
  assert.equal(changes["staged.txt"].status, "added");
  assert.equal(changes["staged.txt"].addedLines, 2);
  assert.equal(changes["loose.txt"].status, "untracked");
});

test("a project in a subfolder sees only its own changes", async () => {
  const { repo } = createClone();
  write(repo, "pkg/inside.txt", "i\n");
  write(repo, "outside.txt", "o\n");

  const status = await listProjectGitChanges(path.join(repo, "pkg"));

  assert.deepEqual(
    status.changes.map((change) => change.path),
    ["inside.txt"],
  );
  assert.equal(status.repoRoot, path.resolve(repo).replaceAll("\\", "/"));
});

test("a folder outside any repository is not one", async () => {
  const folder = tempRoot();

  const status = await listProjectGitChanges(folder);

  assert.equal(status.isRepo, false);
  assert.deepEqual(status.changes, []);
});

test("a read takes the branch, HEAD and upstream from its one status call", async () => {
  const { repo } = createClone();
  write(repo, "app.txt", "changed\n");

  spawned.length = 0;
  await listProjectGitChanges(repo, {
    includeMetadata: false,
    includeStats: false,
    includeUntracked: false,
  });
  const summary = spawned.map((args) => args[0]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  spawned.length = 0;
  await listProjectGitChanges(repo);
  const full = spawned.map((args) => args[0]);

  assert.deepEqual(summary, ["rev-parse", "status"]);
  // The repository root is remembered; HEAD and the upstream come with
  // the one status call.
  assert.equal(full.includes("rev-parse"), false);
  assert.equal(full.filter((command) => command === "status").length, 1);
  for (const command of ["branch", "rev-list"]) {
    assert.equal(full.includes(command), false, `${command} was spawned`);
  }
});

test("reads asked for together share one, the summary taken from the full", async () => {
  const { repo } = createClone();
  write(repo, "app.txt", "changed\n");
  write(repo, "untracked.txt", "u\n");
  await listProjectGitChanges(repo);
  await new Promise((resolve) => setTimeout(resolve, 150));

  spawned.length = 0;
  const [full, again, summary] = await Promise.all([
    listProjectGitChanges(repo),
    listProjectGitChanges(repo),
    listProjectGitChanges(repo, {
      includeMetadata: false,
      includeStats: false,
      includeUntracked: false,
    }),
  ]);

  assert.equal(
    spawned.filter((args) => args[0] === "status").length,
    1,
    "one status call for all three",
  );
  assert.equal(again, full);
  assert.deepEqual(
    summary.changes.map((change) => [change.path, change.addedLines]),
    [["app.txt", 0]],
  );
  assert.equal(summary.upstreamBranch, null);
  assert.equal(full.upstreamBranch, "origin/main");
});

test("a git write in between makes the next read start afresh", async () => {
  const { repo } = createClone();
  write(repo, "app.txt", "changed\n");

  const before = listProjectGitChanges(repo);
  await runGitCommand(repo, ["add", "-A"]);
  const after = await listProjectGitChanges(repo);

  assert.notEqual(after, await before);
  assert.equal(after.changes[0].staged, true);
});

test("branch headers give the branch, HEAD and the upstream counts", () => {
  const oid = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(
    parseGitStatusBranchHeaders([
      `# branch.oid ${oid}`,
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 a b app.txt",
    ]),
    {
      branch: "main",
      detached: false,
      oid,
      tracking: {
        aheadCount: 2,
        behindCount: 3,
        upstreamBranch: "origin/main",
      },
    },
  );
  // Before the first commit there is no HEAD commit.
  assert.deepEqual(
    parseGitStatusBranchHeaders([
      "# branch.oid (initial)",
      "# branch.head trunk",
    ]),
    { branch: "trunk", detached: false, oid: null, tracking: null },
  );
  assert.equal(
    parseGitStatusBranchHeaders([
      `# branch.oid ${oid}`,
      "# branch.head (detached)",
    ]).detached,
    true,
  );
  // An upstream git could not count against (its ref is gone).
  assert.equal(
    parseGitStatusBranchHeaders([
      "# branch.head main",
      "# branch.upstream origin/gone",
    ]).tracking,
    null,
  );
});
