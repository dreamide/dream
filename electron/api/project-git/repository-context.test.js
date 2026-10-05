// The repository context over a recorded runner: which facts it remembers
// and for how long, which reads it shares, and what makes it forget.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createGitRepositoryContext,
  isReadOnlyGitCommand,
} from "./repository-context.js";

/**
 * A runner that answers from `answers` (by the command's arguments) and
 * records every command, and a clock the test moves.
 */
const setup = (answers = {}, options = {}) => {
  const calls = [];
  let time = 0;
  const pending = [];
  const run = (_cwd, args) => {
    calls.push(args.join(" "));
    const answer = answers[args.join(" ")] ?? { ok: true, stdout: "" };
    const result = { stderr: "", stdout: "", ...answer };
    if (!options.hold) return Promise.resolve(result);
    return new Promise((resolve) => pending.push(() => resolve(result)));
  };
  const context = createGitRepositoryContext({
    joinWindowMs: 100,
    now: () => time,
    run,
    stableTtlMs: 1000,
  });
  return {
    calls,
    context,
    release: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
    tick: (ms) => {
      time += ms;
    },
  };
};

const ROOT_ANSWERS = {
  "rev-parse --show-toplevel": { ok: true, stdout: "/repo\n" },
  remote: { ok: true, stdout: "upstream\norigin\n" },
  "symbolic-ref --quiet --short refs/remotes/origin/HEAD": {
    ok: true,
    stdout: "origin/trunk\n",
  },
};

test("stable facts are read once until they expire", async () => {
  const { calls, context, tick } = setup(ROOT_ANSWERS);

  assert.equal(await context.repositoryRoot("/repo/app"), "/repo");
  assert.equal(await context.repositoryRoot("/repo/app"), "/repo");
  assert.equal(await context.remoteName("/repo"), "origin");
  assert.equal(await context.remoteName("/repo"), "origin");
  assert.equal(await context.defaultBranch("/repo", "origin"), "trunk");
  assert.equal(await context.defaultBranch("/repo", "origin"), "trunk");
  assert.equal(calls.length, 3);

  tick(1000);
  await context.repositoryRoot("/repo/app");
  assert.equal(calls.length, 4);
});

test("a folder in no repository is asked again every time", async () => {
  const { calls, context } = setup({
    "rev-parse --show-toplevel": {
      ok: false,
      stderr: "fatal: not a git repository",
    },
  });

  assert.equal(await context.repositoryRoot("/plain"), null);
  assert.equal(await context.repositoryRoot("/plain"), null);
  assert.equal(calls.length, 2);
});

test("a default branch falls back to main or master", async () => {
  const { context } = setup({
    "show-ref --verify --quiet refs/heads/main": { ok: false },
    "show-ref --verify --quiet refs/heads/master": { ok: true },
  });

  assert.equal(await context.defaultBranch("/repo", null), "master");
});

test("reads asked together share one; a later one starts its own", async () => {
  const { calls, context, release, tick } = setup({}, { hold: true });
  const read = () => context.run("/repo", ["status"]);

  const first = context.share("status", read);
  tick(60);
  const joined = context.share("status", read);
  tick(60);
  const later = context.share("status", read);
  release();

  assert.equal(joined, first);
  assert.notEqual(later, first);
  assert.equal(calls.length, 2);
  await Promise.all([first, later]);
});

test("a write forgets every fact and shared read", async () => {
  const { calls, context } = setup(ROOT_ANSWERS);
  await context.repositoryRoot("/repo");
  const read = context.share("status", () => context.run("/repo", ["status"]));

  await context.run("/repo", ["commit", "-m", "x"]);

  assert.equal(context.joinable("status"), null);
  assert.notEqual(
    context.share("status", () => context.run("/repo", ["status"])),
    read,
  );
  await context.repositoryRoot("/repo");
  assert.equal(
    calls.filter((call) => call === "rev-parse --show-toplevel").length,
    2,
  );
});

test("a read that started during a write is not handed out after it", async () => {
  const { context, release } = setup({}, { hold: true });

  const write = context.run("/repo", ["checkout", "feature"]);
  const during = context.share("status", () =>
    context.run("/repo", ["status"]),
  );
  release();
  await write;

  assert.notEqual(context.joinable("status"), during);
  assert.equal(context.joinable("status"), null);
});

test("only commands known to read count as reads", () => {
  for (const args of [
    ["status", "--porcelain=v2"],
    ["rev-parse", "--show-toplevel"],
    ["branch", "--show-current"],
    ["remote"],
    ["remote", "get-url", "origin"],
    ["config", "--get", "branch.main.remote"],
    ["worktree", "list", "--porcelain"],
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
  ]) {
    assert.equal(isReadOnlyGitCommand(args), true, args.join(" "));
  }
  for (const args of [
    ["commit", "-m", "x"],
    ["checkout", "-b", "x"],
    ["branch", "-d", "x"],
    ["remote", "add", "origin", "url"],
    ["config", "user.name", "x"],
    ["worktree", "add", "../x"],
    ["symbolic-ref", "HEAD", "refs/heads/x"],
    ["push"],
    ["some-new-command"],
  ]) {
    assert.equal(isReadOnlyGitCommand(args), false, args.join(" "));
  }
});
