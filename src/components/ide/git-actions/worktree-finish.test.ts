// Finishing a worktree through its interface: what may be removed or
// merged, what each removal asks git for, and when the app forgets the
// worktree. Git and the store are replaced by fakes the test controls.
import { expect, test, vi } from "vitest";
import type {
  ProjectGitBranchDeletePreview,
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
  ProjectGitWorktreeCleanupResponse,
  ProjectGitWorktreeCompareResponse,
  ProjectGitWorktreeMergeResponse,
} from "@/types/ide";
import {
  type WorktreeBranchPreview,
  WorktreeFinish,
  type WorktreeFinishDependencies,
} from "./worktree-finish";

const change = (path: string): ProjectGitStatusEntry => ({
  addedLines: 1,
  path,
  previousPath: null,
  removedLines: 0,
  staged: false,
  status: "modified",
  unstaged: true,
});

const statusOf = (paths: string[] = []): ProjectGitStatusResponse =>
  ({
    changes: paths.map(change),
    fileCount: paths.length,
    isRepo: true,
  }) as ProjectGitStatusResponse;

const compareOf = (
  overrides: Partial<ProjectGitWorktreeCompareResponse> = {},
): ProjectGitWorktreeCompareResponse =>
  ({
    aheadCount: 2,
    baseBranch: "main",
    behindCount: 0,
    mainBranch: "main",
    mainClean: true,
    mainDirtyCount: 0,
    mainInProgressOperation: false,
    mergeBase: "base",
    ...overrides,
  }) as ProjectGitWorktreeCompareResponse;

const previewOf = (
  overrides: Partial<ProjectGitBranchDeletePreview> = {},
): WorktreeBranchPreview => ({
  error: null,
  loading: false,
  preview: {
    baseBranch: "main",
    blockedReason: null,
    branch: "feature",
    checkedOutAt: null,
    head: "head-1",
    localOnlyCount: 0,
    pullRequest: null,
    unmergedCount: 0,
    ...overrides,
  },
});

const removed = (
  overrides: Partial<ProjectGitWorktreeCleanupResponse> = {},
): ProjectGitWorktreeCleanupResponse => ({
  branch: "feature",
  branchDeleted: false,
  branchDeleteError: null,
  path: "/work/feature",
  pruned: false,
  removed: true,
  ...overrides,
});

const merged: ProjectGitWorktreeMergeResponse = {
  baseBranch: "main",
  branch: "feature",
  fastForward: true,
  mainWorktreePath: "/work",
  mergeCommit: "abc123",
  previousMainBranch: "main",
  status: "merged",
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A flow over fakes; `mergeable` offers merging as a worktree project does. */
const createFinish = ({
  compare = () => compareOf(),
  forget = () => removed(),
  merge = () => merged,
  mergeable = true,
}: {
  compare?: () => ProjectGitWorktreeCompareResponse;
  forget?: () => ProjectGitWorktreeCleanupResponse;
  merge?: () => ProjectGitWorktreeMergeResponse;
  mergeable?: boolean;
} = {}) => {
  const forgotten: Parameters<WorktreeFinishDependencies["forget"]>[0][] = [];
  const purge = vi.fn();
  const compares = vi.fn(async () => compare());
  const merges = vi.fn(async () => merge());
  const finish = new WorktreeFinish({
    ...(mergeable ? { compare: compares, merge: merges } : {}),
    forget: async (options) => {
      forgotten.push(options);
      return forget();
    },
    purge,
  });
  const show = (
    status: ProjectGitStatusResponse | null = statusOf(),
    branchPreview: WorktreeBranchPreview = {
      error: null,
      loading: false,
      preview: null,
    },
  ) => finish.update({ branchPreview, status, statusLoading: false });
  return { compares, finish, forgotten, merges, purge, show };
};

test("a worktree may be removed once its status is read, and while nothing would be lost unasked", () => {
  const { finish, show } = createFinish({ mergeable: false });
  finish.start();
  expect(finish.getSnapshot().canRemove).toBe(false); // status not read yet

  show(statusOf());
  expect(finish.getSnapshot().canRemove).toBe(true);

  show(statusOf(["a.ts", "b.ts"]));
  expect(finish.getSnapshot()).toMatchObject({
    canRemove: false,
    uncommittedCount: 2,
  });
  finish.setDiscardUncommitted(true);
  expect(finish.getSnapshot().canRemove).toBe(true);
});

test("deleting the branch too waits for its delete preview and refuses a blocked one", () => {
  const { finish, show } = createFinish({ mergeable: false });
  finish.start();
  show();
  finish.setDeleteBranch(true);
  expect(finish.getSnapshot().canRemove).toBe(false);

  show(statusOf(), { error: null, loading: true, preview: null });
  expect(finish.getSnapshot().canRemove).toBe(false);

  show(statusOf(), previewOf({ blockedReason: "main-checkout" }));
  expect(finish.getSnapshot()).toMatchObject({
    branchBlocked: "main-checkout",
    canRemove: false,
  });

  show(statusOf(), previewOf());
  expect(finish.getSnapshot()).toMatchObject({
    branchBlocked: null,
    canRemove: true,
  });

  // A block only matters while the branch is to go.
  show(statusOf(), previewOf({ blockedReason: "base" }));
  finish.setDeleteBranch(false);
  expect(finish.getSnapshot()).toMatchObject({
    branchBlocked: null,
    canRemove: true,
  });
});

test("an unmerged branch is deleted only against the head its preview showed", async () => {
  const { finish, forgotten, show } = createFinish({ mergeable: false });
  finish.start();
  show(statusOf(["a.ts"]), previewOf({ head: "seen", unmergedCount: 3 }));
  finish.setDiscardUncommitted(true);
  finish.setDeleteBranch(true);
  expect(await finish.remove()).toBe(true);

  finish.start();
  show(statusOf(), previewOf({ head: "seen", unmergedCount: 0 }));
  finish.setDeleteBranch(true);
  await finish.remove();

  finish.start();
  show(statusOf(), previewOf({ head: "seen", unmergedCount: 3 }));
  await finish.remove(); // a fresh start keeps the branch, so sends no head

  expect(forgotten).toEqual([
    { confirmedBranchHead: "seen", deleteBranch: true, force: true },
    { confirmedBranchHead: null, deleteBranch: true, force: false },
    { confirmedBranchHead: null, deleteBranch: false, force: false },
  ]);
});

test("the app forgets the worktree only after git removed it, and only once", async () => {
  const { finish, purge, show } = createFinish({
    forget: () => {
      throw new Error("worktree is locked");
    },
    mergeable: false,
  });
  finish.start();
  show();
  expect(await finish.remove()).toBe(false);
  expect(finish.getSnapshot()).toMatchObject({
    phase: "done",
    removal: { ok: false },
  });
  finish.finish();
  expect(purge).not.toHaveBeenCalled();

  const {
    finish: second,
    purge: purgeSecond,
    show: showSecond,
  } = createFinish({ mergeable: false });
  second.start();
  showSecond();
  await second.remove();
  second.finish();
  second.finish();
  expect(purgeSecond).toHaveBeenCalledTimes(1);

  // Never finished, never forgotten.
  const { finish: third, purge: purgeThird } = createFinish({
    mergeable: false,
  });
  third.start();
  third.finish();
  expect(purgeThird).not.toHaveBeenCalled();
});

test("a failed removal is retried with the options it had, and a removal that went through is not repeated", async () => {
  let fail = true;
  const { finish, forgotten, show } = createFinish({
    forget: () => {
      if (fail) throw new Error("busy");
      return removed();
    },
    mergeable: false,
  });
  finish.start();
  show(statusOf(["a.ts"]));
  finish.setDiscardUncommitted(true);
  await finish.remove();
  finish.setDiscardUncommitted(false); // changing the form does not change the retry

  fail = false;
  expect(await finish.retryRemoval()).toBe(true);
  expect(finish.getSnapshot()).toMatchObject({
    phase: "done",
    removal: { ok: true },
  });
  expect(await finish.retryRemoval()).toBe(false);
  expect(await finish.remove()).toBe(false);
  expect(forgotten).toEqual([
    { confirmedBranchHead: null, deleteBranch: false, force: true },
    { confirmedBranchHead: null, deleteBranch: false, force: true },
  ]);
});

test("a second click while a removal runs asks git nothing more", async () => {
  const { finish, forgotten, show } = createFinish({ mergeable: false });
  finish.start();
  show();
  const first = finish.remove();
  expect(finish.getSnapshot().phase).toBe("working");
  expect(await finish.remove()).toBe(false);
  await first;
  expect(forgotten.length).toBe(1);
});

test("merging waits for the comparison and says why it cannot merge", async () => {
  const cases: [Partial<ProjectGitWorktreeCompareResponse>, unknown][] = [
    [{ aheadCount: 0 }, { base: "main", kind: "nothingToMerge" }],
    [{ mergeBase: null }, { base: "main", kind: "unrelatedHistories" }],
    [{ mainInProgressOperation: true }, { kind: "mainOperationInProgress" }],
    [
      { mainBranch: "dev", mainClean: false, mainDirtyCount: 3 },
      { branch: "dev", count: 3, kind: "mainWorktreeDirty" },
    ],
  ];
  for (const [overrides, block] of cases) {
    const { finish } = createFinish({ compare: () => compareOf(overrides) });
    finish.start();
    expect(finish.getSnapshot()).toMatchObject({
      canMerge: false,
      compareLoading: true,
    });
    await flush();
    expect(finish.getSnapshot()).toMatchObject({
      canMerge: false,
      mergeBlock: block,
    });
  }

  const { finish } = createFinish();
  finish.start();
  await flush();
  expect(finish.getSnapshot()).toMatchObject({
    canMerge: true,
    mergeBlock: null,
    unmergedCommits: 2,
  });
});

test("unrelated histories have no unmerged commit count; a removal-only flow never compares", async () => {
  const { finish } = createFinish({
    compare: () => compareOf({ aheadCount: 5, mergeBase: null }),
  });
  finish.start();
  await flush();
  expect(finish.getSnapshot().unmergedCommits).toBe(0);

  const { compares, finish: removalOnly } = createFinish({ mergeable: false });
  removalOnly.start();
  await flush();
  expect(compares).not.toHaveBeenCalled();
  expect(removalOnly.getSnapshot()).toMatchObject({
    canMerge: false,
    compareLoading: false,
  });
  expect(await removalOnly.merge()).toBe(false);
});

test("a conflict returns to a review read afresh, with the conflicting files", async () => {
  const { compares, finish } = createFinish({
    merge: () => ({
      baseBranch: "main",
      branch: "feature",
      conflictingFiles: ["a.ts"],
      mainWorktreePath: "/work",
      previousMainBranch: "main",
      status: "conflict",
    }),
  });
  finish.start();
  await flush();
  expect(await finish.merge()).toBe(false);
  expect(finish.getSnapshot()).toMatchObject({
    mergeFailure: { baseBranch: "main", files: ["a.ts"], kind: "conflict" },
    phase: "review",
  });
  expect(compares).toHaveBeenCalledTimes(2);
});

test("after a merge the worktree and its merged branch can go, unless something uncommitted would be lost", async () => {
  const { finish, forgotten, show } = createFinish();
  finish.start();
  show();
  await flush();
  expect(await finish.merge()).toBe(true);
  expect(finish.getSnapshot()).toMatchObject({ merged, phase: "merged" });
  expect(await finish.removeAfterMerge()).toBe(true);
  expect(forgotten).toEqual([
    { confirmedBranchHead: null, deleteBranch: true, force: false },
  ]);

  const dirty = createFinish();
  dirty.finish.start();
  dirty.show(statusOf(["a.ts"]));
  await flush();
  await dirty.finish.merge();
  expect(await dirty.finish.removeAfterMerge()).toBe(false);
  expect(dirty.forgotten).toEqual([]);
});

test("committing first returns to a fresh comparison, and the stale one is not shown meanwhile", async () => {
  let ahead = 1;
  const { compares, finish } = createFinish({
    compare: () => compareOf({ aheadCount: ahead }),
  });
  finish.start();
  await flush();
  finish.startCommit();
  expect(finish.getSnapshot().phase).toBe("commit");

  ahead = 2;
  finish.commitCompleted();
  expect(finish.getSnapshot()).toMatchObject({
    canMerge: false,
    compare: null,
    compareLoading: true,
  });
  finish.endCommit();
  expect(finish.getSnapshot().phase).toBe("review");
  await flush();
  expect(finish.getSnapshot().compare?.aheadCount).toBe(2);
  expect(compares).toHaveBeenCalledTimes(2);
});

test("a comparison overtaken by a newer one, or by the dialog going away, is ignored", async () => {
  const pending: ((value: ProjectGitWorktreeCompareResponse) => void)[] = [];
  const finish = new WorktreeFinish({
    compare: () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
    forget: async () => removed(),
    merge: async () => merged,
    purge: () => {},
  });
  finish.start();
  finish.start();
  pending[1](compareOf({ aheadCount: 7 }));
  pending[0](compareOf({ aheadCount: 1 }));
  await flush();
  expect(finish.getSnapshot().compare?.aheadCount).toBe(7);

  finish.start();
  finish.dispose();
  pending[2](compareOf({ aheadCount: 9 }));
  await flush();
  expect(finish.getSnapshot().compare).toBe(null);
});

test("a comparison that fails is reported and blocks merging", async () => {
  const { finish } = createFinish({
    compare: () => {
      throw new Error("not a linked worktree");
    },
  });
  finish.start();
  await flush();
  expect(finish.getSnapshot()).toMatchObject({
    canMerge: false,
    compare: null,
    compareLoading: false,
  });
  expect(finish.getSnapshot().compareError).toBeInstanceOf(Error);
});
