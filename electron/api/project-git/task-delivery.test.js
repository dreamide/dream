import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/dream-test-user-data" },
}));

const { getTaskDeliveryStatus } = await import("./task-delivery.js");

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
  const root = mkdtempSync(path.join(tmpdir(), "dream-task-delivery-"));
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

test("a merged commit is not pushed until someone pushes it", async () => {
  const { origin, repo } = createClones();
  const merged = commitFile(repo, "select.txt", "Add select");

  assert.deepEqual(
    await getTaskDeliveryStatus(repo, { branch: "main", commit: merged }),
    {
      aheadCount: 1,
      behindCount: 0,
      branch: "main",
      branchExists: true,
      pushed: false,
      upstream: "origin/main",
    },
  );

  // The user pushes with their own tools; the status follows the refs.
  git(repo, "push", "-q", "origin", "main");
  assert.equal(git(origin, "rev-parse", "main"), merged);
  assert.equal(
    (await getTaskDeliveryStatus(repo, { branch: "main", commit: merged }))
      .pushed,
    true,
  );
});

test("an earlier task's commit counts as pushed even with newer work unpushed", async () => {
  const { repo } = createClones();
  const first = commitFile(repo, "select.txt", "Add select");
  git(repo, "push", "-q", "origin", "main");
  const second = commitFile(repo, "slider.txt", "Add slider");

  const status = (commit) =>
    getTaskDeliveryStatus(repo, { branch: "main", commit });
  assert.equal((await status(first)).pushed, true);
  assert.equal((await status(second)).pushed, false);
  // A commit git has never heard of cannot be judged either way.
  assert.equal((await status("0".repeat(40))).pushed, null);
});

test("reports being behind when the remote has newer commits", async () => {
  const { other, repo } = createClones();
  commitFile(other, "theirs.txt", "Someone else's work");
  git(other, "push", "-q", "origin", "main");
  const mine = commitFile(repo, "select.txt", "Add select");
  git(repo, "fetch", "-q", "origin");

  const status = await getTaskDeliveryStatus(repo, {
    branch: "main",
    commit: mine,
  });
  assert.equal(status.aheadCount, 1);
  assert.equal(status.behindCount, 1);
  assert.equal(status.pushed, false);
});

test("a repository without a remote cannot say whether work was pushed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dream-task-delivery-"));
  roots.push(root);
  const repo = path.join(root, "local");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  configure(repo);
  const commit = commitFile(repo, "app.txt", "Initial");

  const status = await getTaskDeliveryStatus(repo, { branch: "main", commit });
  assert.equal(status.pushed, null);
  assert.equal(status.upstream, null);
});
