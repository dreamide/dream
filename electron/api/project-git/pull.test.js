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
