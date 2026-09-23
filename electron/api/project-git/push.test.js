import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/dream-test-user-data" },
}));

const { getProjectGitPushPreview, pushProjectGitChanges } = await import(
  "./actions.js"
);

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

const commitFile = (cwd, name, message) => {
  writeFileSync(path.join(cwd, name), `${message}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

/** A clone tracking a local bare "origin", plus a second clone of it. */
const createClones = () => {
  const root = mkdtempSync(path.join(tmpdir(), "dream-git-push-"));
  roots.push(root);
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
  return { origin, other, repo };
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a named branch is previewed and pushed without checking it out", async () => {
  const { origin, repo } = createClones();
  const merged = commitFile(repo, "select.txt", "Add select");
  // The user has moved on to another branch, e.g. a finished task's base
  // branch is pushed from its card.
  git(repo, "checkout", "-q", "-b", "feature");
  commitFile(repo, "feature.txt", "Feature work");

  const preview = await getProjectGitPushPreview(repo, { branch: "main" });
  assert.equal(preview.branch, "main");
  assert.equal(preview.target, "origin/main");
  assert.equal(preview.totalCommits, 1);
  assert.deepEqual(
    preview.commits.map((commit) => commit.subject),
    ["Add select"],
  );

  const result = await pushProjectGitChanges(repo, { branch: "main" });
  assert.equal(result.branch, "main");
  assert.equal(result.upstreamBranch, "origin/main");
  assert.equal(git(origin, "rev-parse", "main"), merged);
  // Only the named branch went out, and the checkout is untouched.
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
  assert.equal(
    git(origin, "branch", "--list", "feature"),
    "",
    "the checked-out branch was not pushed",
  );
});

test("pushing a named branch never overwrites newer remote work", async () => {
  const { origin, other, repo } = createClones();
  const remoteOnly = commitFile(other, "remote.txt", "Remote change");
  git(other, "push", "-q", "origin", "main");
  commitFile(repo, "select.txt", "Add select");
  git(repo, "fetch", "-q", "origin");
  git(repo, "checkout", "-q", "-b", "feature");

  await assert.rejects(pushProjectGitChanges(repo, { branch: "main" }));
  assert.equal(git(origin, "rev-parse", "main"), remoteOnly);
});

test("a named branch without an upstream is published and tracked", async () => {
  const { origin, repo } = createClones();
  git(repo, "branch", "release");
  const released = git(repo, "rev-parse", "release");

  await pushProjectGitChanges(repo, { branch: "release" });

  assert.equal(git(origin, "rev-parse", "release"), released);
  assert.equal(
    git(repo, "rev-parse", "--abbrev-ref", "release@{u}"),
    "origin/release",
  );
});

test("only the checked-out branch can be committed and pushed", async () => {
  const { repo } = createClones();
  git(repo, "branch", "release");

  await assert.rejects(
    pushProjectGitChanges(repo, { branch: "release", nextStep: "commit-push" }),
    /checked-out branch/,
  );
});

test("without a branch the checked-out branch is pushed as before", async () => {
  const { origin, repo } = createClones();
  const head = commitFile(repo, "select.txt", "Add select");

  const result = await pushProjectGitChanges(repo);

  assert.equal(result.branch, "main");
  assert.equal(git(origin, "rev-parse", "main"), head);
});
