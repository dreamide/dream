import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProjectGitStatusResponse } from "@/types/ide";
import type { PullRequestSummary } from "../pull-requests/api";
import { type BranchPullRequest, getBranchActions } from "./branch-actions";

const status = (
  overrides: Partial<ProjectGitStatusResponse> = {},
): ProjectGitStatusResponse => ({
  addedLines: 0,
  aheadCount: 0,
  baseBranch: "main",
  behindCount: 0,
  branch: "feature",
  changes: [],
  fileCount: 0,
  hasStagedChanges: false,
  hasUnstagedChanges: false,
  isRepo: true,
  remoteName: "origin",
  removedLines: 0,
  repoRoot: "/repo",
  stagedCount: 0,
  unstagedCount: 0,
  upstreamBranch: "origin/feature",
  ...overrides,
});

const pr = (state: PullRequestSummary["state"]): PullRequestSummary => ({
  author: "someone",
  draft: false,
  number: 12,
  state,
  title: "Feature",
  updatedAt: "2026-10-01T00:00:00Z",
  url: "https://github.com/acme/app/pull/12",
});

const actions = ({
  pullRequest = null,
  worktree = null,
  writeRunning = false,
  ...overrides
}: Partial<ProjectGitStatusResponse> & {
  pullRequest?: BranchPullRequest;
  worktree?: { baseRef: string | null } | null;
  writeRunning?: boolean;
} = {}) =>
  getBranchActions({
    pullRequest,
    status: status(overrides),
    worktree,
    writeRunning,
  });

test("a level, clean branch offers sync and a pull request, nothing to commit or push", () => {
  const result = actions();
  assert.deepEqual(result.commit, { enabled: false, fileCount: 0 });
  assert.deepEqual(result.push, {
    aheadCount: 0,
    enabled: false,
    publish: false,
  });
  assert.equal(result.fetch.enabled, true);
  assert.deepEqual(result.pull, { behindCount: 0, enabled: true });
  assert.equal(result.viewPullRequest, null);
  assert.equal(result.createPullRequest.offered, true);
  assert.equal(result.createPullRequest.enabled, true);
  assert.equal(result.worktree, null);
  assert.equal(result.highlighted, false);
});

test("changed files and commits ahead highlight the trigger", () => {
  const changed = actions({ fileCount: 2 });
  assert.deepEqual(changed.commit, { enabled: true, fileCount: 2 });
  assert.equal(changed.highlighted, true);

  const ahead = actions({ aheadCount: 3, behindCount: 1 });
  assert.deepEqual(ahead.push, {
    aheadCount: 3,
    enabled: true,
    publish: false,
  });
  assert.deepEqual(ahead.pull, { behindCount: 1, enabled: true });
  assert.equal(ahead.highlighted, true);
});

test("a branch without an upstream is published to its remote", () => {
  const result = actions({
    aheadCount: 4,
    behindCount: 2,
    upstreamBranch: null,
  });
  // Counts are against an upstream; there is none.
  assert.deepEqual(result.push, {
    aheadCount: 0,
    enabled: true,
    publish: true,
  });
  assert.deepEqual(result.pull, { behindCount: 0, enabled: false });
  assert.equal(result.fetch.enabled, true);
  assert.equal(result.highlighted, true);
  assert.equal(result.createPullRequest.nextStep, "push-create");
});

test("a pull request still loading is not offered for creation", () => {
  const result = actions({ pullRequest: "loading" });
  assert.equal(result.viewPullRequest, null);
  assert.equal(result.createPullRequest.offered, false);
});

test("a failed pull request lookup still offers creating one", () => {
  const result = actions({ pullRequest: "unavailable" });
  assert.equal(result.viewPullRequest, null);
  assert.equal(result.createPullRequest.offered, true);
  assert.equal(result.createPullRequest.enabled, true);
});

test("an open or merged pull request is viewed, not created again", () => {
  for (const state of ["open", "merged"] as const) {
    const pullRequest = pr(state);
    const result = actions({ pullRequest });
    assert.equal(result.viewPullRequest, pullRequest, state);
    assert.equal(result.createPullRequest.offered, false, state);
  }
});

test("a closed pull request is viewed and a new one offered", () => {
  const pullRequest = pr("closed");
  const result = actions({ pullRequest });
  assert.equal(result.viewPullRequest, pullRequest);
  assert.equal(result.createPullRequest.offered, true);
  assert.equal(result.createPullRequest.enabled, true);
});

test("a worktree with no remote merges into its base; nothing goes to a remote", () => {
  const local = { remoteName: null, upstreamBranch: null };
  const result = actions({ ...local, worktree: { baseRef: "develop" } });
  assert.deepEqual(result.worktree, { enabled: true, mergeBase: "develop" });
  assert.equal(result.push.enabled, false);
  assert.equal(result.fetch.enabled, false);
  assert.equal(result.pull.enabled, false);
  assert.equal(result.createPullRequest.offered, true);
  assert.equal(result.createPullRequest.enabled, false);
  assert.equal(result.highlighted, false);

  // Without a recorded base ref, the repository's base branch.
  assert.deepEqual(
    actions({ ...local, worktree: { baseRef: null } }).worktree,
    {
      enabled: true,
      mergeBase: "main",
    },
  );
  assert.deepEqual(
    actions({ ...local, baseBranch: null, worktree: { baseRef: null } })
      .worktree,
    { enabled: true, mergeBase: null },
  );
});

test("a detached HEAD cannot open a pull request", () => {
  const result = actions({ branch: null, fileCount: 1 });
  assert.equal(result.createPullRequest.problem, "detached-head");
  assert.equal(result.createPullRequest.enabled, false);
  assert.deepEqual(result.createPullRequest.nextSteps, []);
  assert.equal(result.commit.enabled, true);
});

test("the base branch cannot open a pull request into itself", () => {
  const result = actions({ branch: "main", upstreamBranch: "origin/main" });
  assert.equal(result.createPullRequest.problem, "same-branch");
  assert.equal(result.createPullRequest.enabled, false);
  assert.deepEqual(result.createPullRequest.nextSteps, []);

  const named = actions({
    baseBranch: "refs/heads/develop",
    branch: "develop",
  });
  assert.equal(named.createPullRequest.problem, "same-branch");
  assert.equal(named.createPullRequest.baseBranch, "refs/heads/develop");

  // Without a known base branch, main.
  const unknownBase = actions({ baseBranch: null, branch: "main" });
  assert.equal(unknownBase.createPullRequest.baseBranch, "main");
  assert.equal(unknownBase.createPullRequest.problem, "same-branch");
});

test("creating a pull request first commits, then pushes, what is pending", () => {
  const changed = actions({ aheadCount: 1, fileCount: 1 }).createPullRequest;
  assert.equal(changed.nextStep, "commit-push-create");
  assert.deepEqual(changed.nextSteps, [
    "create",
    "push-create",
    "commit-push-create",
  ]);

  const ahead = actions({ aheadCount: 1 }).createPullRequest;
  assert.equal(ahead.nextStep, "push-create");
  assert.deepEqual(ahead.nextSteps, ["create", "push-create"]);

  assert.equal(actions().createPullRequest.nextStep, "create");
});

test("a running git write disables every write and the highlight", () => {
  const pullRequest = pr("closed");
  const result = actions({
    aheadCount: 2,
    fileCount: 3,
    pullRequest,
    worktree: { baseRef: "main" },
    writeRunning: true,
  });
  assert.equal(result.commit.enabled, false);
  assert.equal(result.push.enabled, false);
  assert.equal(result.fetch.enabled, false);
  assert.equal(result.pull.enabled, false);
  assert.equal(result.createPullRequest.offered, true);
  assert.equal(result.createPullRequest.enabled, false);
  assert.deepEqual(result.worktree, { enabled: false, mergeBase: "main" });
  assert.equal(result.highlighted, false);
  // Viewing is not a write.
  assert.equal(result.viewPullRequest, pullRequest);
  // What is pending is unchanged; only starting it waits.
  assert.equal(result.commit.fileCount, 3);
  assert.equal(result.createPullRequest.nextStep, "commit-push-create");
});
