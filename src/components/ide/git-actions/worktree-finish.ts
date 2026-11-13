/**
 * Finishing a worktree: merging its branch into its base, removing it (and
 * its branch), or both. The Git actions dialog of a worktree project and the
 * projects panel's remove dialog both render one; they differ only in layout
 * and pacing (the first shows the outcome before the app forgets the
 * worktree, the second forgets it at once).
 *
 * A worktree may be removed when its status has been read, its uncommitted
 * changes are either absent or to be discarded, and, when its branch goes
 * too, the delete preview has loaded and nothing blocks it; an unmerged
 * branch is deleted only against the head the preview showed. The app's own
 * record of a worktree is dropped (`finish`) only once git has removed it.
 *
 * Merging needs the comparison with the base branch, read whenever the
 * review is shown, so a commit or a failed merge is followed by a fresh one.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBranchDeletePreview } from "@/hooks/use-branch-delete-preview";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { apiClient } from "@/lib/api-client";
import type {
  ProjectGitBranchDeleteBlock,
  ProjectGitBranchDeletePreview,
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
  ProjectGitWorktreeCleanupResponse,
  ProjectGitWorktreeCompareResponse,
  ProjectGitWorktreeMergeResponse,
} from "@/types/ide";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import { useIdeStore } from "../ide-store";
import { confirmedHeadFor } from "./branch-delete-summary";

/**
 * `merged` is the pause after a successful merge, where the worktree can be
 * kept or removed. `done` follows a removal attempt, whatever its outcome.
 */
export type WorktreeFinishPhase =
  | "review"
  | "commit"
  | "working"
  | "merged"
  | "done";

/** Why the branch cannot be merged now; the dialog puts it into words. */
export type WorktreeMergeBlock =
  | { kind: "nothingToMerge"; base: string }
  | { kind: "unrelatedHistories"; base: string }
  | { kind: "mainOperationInProgress" }
  | { kind: "mainWorktreeDirty"; branch: string | null; count: number };

export type WorktreeMerged = Extract<
  ProjectGitWorktreeMergeResponse,
  { status: "merged" }
>;

export type WorktreeMergeFailure =
  | { kind: "conflict"; baseBranch: string; files: string[] }
  | { kind: "error"; error: unknown };

/** What a removal came to: git removed the worktree, or it failed. */
export type WorktreeRemoval =
  | { ok: true; result: ProjectGitWorktreeCleanupResponse }
  | { ok: false; error: unknown };

export interface WorktreeBranchPreview {
  error: string | null;
  loading: boolean;
  preview: ProjectGitBranchDeletePreview | null;
}

export interface WorktreeFinishInputs {
  /** A full status read of the worktree; null while unread or unreadable. */
  status: ProjectGitStatusResponse | null;
  statusLoading: boolean;
  /** The delete preview of its branch, read while `deleteBranch` is on. */
  branchPreview: WorktreeBranchPreview;
}

export interface WorktreeFinishSnapshot {
  phase: WorktreeFinishPhase;
  status: ProjectGitStatusResponse | null;
  statusLoading: boolean;
  /** Uncommitted changes in the worktree, and how many there are. */
  uncommitted: ProjectGitStatusEntry[];
  uncommittedCount: number;

  compare: ProjectGitWorktreeCompareResponse | null;
  compareLoading: boolean;
  compareError: unknown;
  /** Commits only on the worktree branch; 0 for unrelated histories. */
  unmergedCommits: number;
  mergeBlock: WorktreeMergeBlock | null;
  canMerge: boolean;
  merged: WorktreeMerged | null;
  mergeFailure: WorktreeMergeFailure | null;

  discardUncommitted: boolean;
  deleteBranch: boolean;
  branchPreview: WorktreeBranchPreview;
  /** What stops the branch going, while it is to go. */
  branchBlocked: ProjectGitBranchDeleteBlock | null;
  canRemove: boolean;
  removal: WorktreeRemoval | null;
}

/** How a removal asks git to remove the worktree. */
export interface WorktreeRemovalOptions {
  confirmedBranchHead: string | null;
  deleteBranch: boolean;
  force: boolean;
}

export interface WorktreeFinishDependencies {
  /** Compares the worktree with its base; absent where merging is not offered. */
  compare?: (signal: AbortSignal) => Promise<ProjectGitWorktreeCompareResponse>;
  /** Merges the branch into its base; the store's `completeWorktreeProject`. */
  merge?: () => Promise<ProjectGitWorktreeMergeResponse>;
  /** Has git remove the worktree; the store's `forgetWorktree`. */
  forget: (
    options: WorktreeRemovalOptions,
  ) => Promise<ProjectGitWorktreeCleanupResponse>;
  /** Drops the app's record of it; the store's `purgeWorktreeProject`. */
  purge: () => void;
}

const NO_PREVIEW: WorktreeBranchPreview = {
  error: null,
  loading: false,
  preview: null,
};

const INITIAL: WorktreeFinishSnapshot = {
  branchBlocked: null,
  branchPreview: NO_PREVIEW,
  canMerge: false,
  canRemove: false,
  compare: null,
  compareError: null,
  compareLoading: false,
  deleteBranch: false,
  discardUncommitted: false,
  merged: null,
  mergeBlock: null,
  mergeFailure: null,
  phase: "review",
  removal: null,
  status: null,
  statusLoading: true,
  uncommitted: [],
  uncommittedCount: 0,
  unmergedCommits: 0,
};

const mergeBlockOf = (
  compare: ProjectGitWorktreeCompareResponse | null,
): WorktreeMergeBlock | null => {
  if (!compare) return null;
  if (compare.aheadCount === 0)
    return { base: compare.baseBranch, kind: "nothingToMerge" };
  if (compare.mergeBase === null)
    return { base: compare.baseBranch, kind: "unrelatedHistories" };
  if (compare.mainInProgressOperation)
    return { kind: "mainOperationInProgress" };
  if (!compare.mainClean)
    return {
      branch: compare.mainBranch,
      count: compare.mainDirtyCount,
      kind: "mainWorktreeDirty",
    };
  return null;
};

export class WorktreeFinish {
  readonly #deps: WorktreeFinishDependencies;
  readonly #listeners = new Set<() => void>();
  #snapshot = INITIAL;
  #compareRequest: AbortController | null = null;
  /** The options of the last removal, for a retry. */
  #lastRemoval: WorktreeRemovalOptions | null = null;
  #purged = false;

  constructor(dependencies: WorktreeFinishDependencies) {
    this.#deps = dependencies;
  }

  getSnapshot = (): WorktreeFinishSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Whether this flow offers merging (it can compare and merge). */
  get mergeable() {
    return Boolean(this.#deps.compare && this.#deps.merge);
  }

  /** A fresh review (a dialog opening), with the comparison read anew. */
  start() {
    this.#purged = false;
    this.#lastRemoval = null;
    const { branchPreview, status, statusLoading } = this.#snapshot;
    this.#snapshot = { ...INITIAL, branchPreview, status, statusLoading };
    this.#toReview();
  }

  /** The worktree's status or its branch's delete preview changed. */
  update(inputs: WorktreeFinishInputs) {
    this.#set({
      branchPreview: inputs.branchPreview,
      status: inputs.status,
      statusLoading: inputs.statusLoading,
    });
  }

  setDiscardUncommitted(discardUncommitted: boolean) {
    this.#set({ discardUncommitted });
  }

  setDeleteBranch(deleteBranch: boolean) {
    this.#set({ deleteBranch });
  }

  /** Commit the uncommitted changes first. */
  startCommit() {
    if (this.#snapshot.phase === "review") this.#set({ phase: "commit" });
  }

  /** The commit landed: the comparison shown predates it. */
  commitCompleted() {
    this.#set({ compare: null, compareLoading: this.mergeable });
  }

  /** Back from committing, to a review read afresh. */
  endCommit() {
    if (this.#snapshot.phase === "commit") this.#toReview();
  }

  /** Merges the branch into its base. True when it merged. */
  async merge(): Promise<boolean> {
    const merge = this.#deps.merge;
    if (!merge || this.#snapshot.phase !== "review" || !this.#snapshot.canMerge)
      return false;
    this.#set({ mergeFailure: null, phase: "working" });
    try {
      const result = await merge();
      if (result.status === "conflict") {
        this.#set({
          mergeFailure: {
            baseBranch: result.baseBranch,
            files: result.conflictingFiles,
            kind: "conflict",
          },
        });
        this.#toReview();
        return false;
      }
      this.#set({ merged: result, phase: "merged" });
      return true;
    } catch (error) {
      this.#set({ mergeFailure: { error, kind: "error" } });
      this.#toReview();
      return false;
    }
  }

  /** Removes the worktree with the options chosen. True when git removed it. */
  remove(): Promise<boolean> {
    const { branchPreview, canRemove, deleteBranch, discardUncommitted } =
      this.#snapshot;
    // Again after a failed removal, never after one that went through.
    const { phase, removal } = this.#snapshot;
    if (
      !canRemove ||
      !(phase === "review" || (phase === "done" && removal?.ok === false))
    ) {
      return Promise.resolve(false);
    }
    return this.#runRemoval({
      confirmedBranchHead: deleteBranch
        ? confirmedHeadFor(branchPreview.preview)
        : null,
      deleteBranch,
      force: discardUncommitted,
    });
  }

  /**
   * After a merge, removes the worktree and its now merged branch. Offered
   * only while nothing uncommitted would be lost.
   */
  removeAfterMerge(): Promise<boolean> {
    if (
      this.#snapshot.phase !== "merged" ||
      this.#snapshot.uncommittedCount > 0
    ) {
      return Promise.resolve(false);
    }
    return this.#runRemoval({
      confirmedBranchHead: null,
      deleteBranch: true,
      force: false,
    });
  }

  /** Tries the failed removal again, with the options it had. */
  retryRemoval(): Promise<boolean> {
    const last = this.#lastRemoval;
    const { phase, removal } = this.#snapshot;
    if (!last || phase !== "done" || removal?.ok !== false)
      return Promise.resolve(false);
    return this.#runRemoval(last);
  }

  /**
   * The flow is over: once git has removed the worktree, the app forgets it
   * too, once. Nothing is forgotten after a failed or no removal.
   */
  finish() {
    if (this.#snapshot.removal?.ok && !this.#purged) {
      this.#purged = true;
      this.#deps.purge();
    }
  }

  /** Ignores the comparison still being read (the dialog went away). */
  dispose() {
    this.#compareRequest?.abort();
  }

  async #runRemoval(options: WorktreeRemovalOptions): Promise<boolean> {
    this.#lastRemoval = options;
    this.#set({ phase: "working", removal: null });
    let removal: WorktreeRemoval;
    try {
      removal = { ok: true, result: await this.#deps.forget(options) };
    } catch (error) {
      removal = { error, ok: false };
    }
    this.#set({ phase: "done", removal });
    return removal.ok;
  }

  #toReview() {
    this.#set({ phase: "review" });
    this.#loadCompare();
  }

  #loadCompare() {
    const compare = this.#deps.compare;
    this.#compareRequest?.abort();
    if (!compare) return;
    const request = new AbortController();
    this.#compareRequest = request;
    this.#set({ compareError: null, compareLoading: true });
    compare(request.signal).then(
      (result) => {
        if (request.signal.aborted) return;
        this.#set({ compare: result, compareLoading: false });
      },
      (error) => {
        if (request.signal.aborted) return;
        this.#set({
          compare: null,
          compareError: error,
          compareLoading: false,
        });
      },
    );
  }

  /** Applies `next` and re-derives what follows from it. */
  #set(next: Partial<WorktreeFinishSnapshot>) {
    const merged = { ...this.#snapshot, ...next };
    const { branchPreview, compare, deleteBranch, status } = merged;
    const uncommittedCount = status?.fileCount ?? 0;
    const branchBlocked = deleteBranch
      ? (branchPreview.preview?.blockedReason ?? null)
      : null;
    const mergeBlock = mergeBlockOf(compare);
    this.#snapshot = {
      ...merged,
      branchBlocked,
      canMerge:
        this.mergeable &&
        compare !== null &&
        !merged.compareLoading &&
        mergeBlock === null,
      canRemove:
        !merged.statusLoading &&
        (uncommittedCount === 0 || merged.discardUncommitted) &&
        (!deleteBranch ||
          (branchPreview.preview !== null && branchBlocked === null)),
      mergeBlock,
      uncommitted: status?.changes ?? [],
      uncommittedCount,
      unmergedCommits:
        compare && compare.mergeBase !== null ? compare.aheadCount : 0,
    };
    for (const listener of this.#listeners) listener();
  }
}

/** The worktree being finished, as either dialog knows it. */
export interface FinishingWorktree {
  /** Its branch; null for a detached worktree, whose branch cannot go. */
  branch: string | null;
  /** The base recorded when it was created, for comparing and merging. */
  baseRef?: string | null;
  hostId?: string;
  mainWorktreePath: string;
  path: string;
  /** Its project, when it is open as one: merging is offered then. */
  projectId?: string;
}

/**
 * Finishing `worktree`, for one dialog. It starts afresh each time `open`
 * turns on; the dialog decides when to `finish` (forget the worktree).
 */
export const useWorktreeFinish = (
  worktree: FinishingWorktree,
  { open = true }: { open?: boolean } = {},
) => {
  const target = useRef(worktree);
  target.current = worktree;
  const [finish] = useState(() => {
    const host = () => getProjectHostId({ hostId: target.current.hostId });
    const { projectId } = worktree;
    return new WorktreeFinish({
      ...(projectId
        ? {
            compare: (signal: AbortSignal) =>
              apiClient.gitWorktreeCompare(
                {
                  baseRef: target.current.baseRef ?? null,
                  projectPath: target.current.path,
                },
                { hostId: host(), signal },
              ),
            merge: () =>
              useIdeStore
                .getState()
                .completeWorktreeProject(
                  target.current.projectId ?? projectId,
                  {
                    // Uncommitted changes are neither merged nor lost: the
                    // worktree stays, so they stay with it.
                    acknowledgeUncommitted: true,
                  },
                ),
          }
        : {}),
      forget: (options) =>
        useIdeStore.getState().forgetWorktree({
          ...options,
          branch: target.current.branch,
          hostId: target.current.hostId,
          mainWorktreePath: target.current.mainWorktreePath,
          worktreePath: target.current.path,
        }),
      purge: () =>
        useIdeStore.getState().purgeWorktreeProject(target.current.path, {
          hostId: target.current.hostId,
        }),
    });
  });
  const snapshot = useSyncExternalStore(finish.subscribe, finish.getSnapshot);

  const { loading: statusLoading, status } = useProjectGitStatus(
    worktree.path,
    { active: open, hostId: worktree.hostId },
  );
  const branchPreview = useBranchDeletePreview({
    branchName: worktree.branch ?? "",
    enabled: open && snapshot.deleteBranch && worktree.branch !== null,
    hostId: worktree.hostId,
    projectPath: worktree.mainWorktreePath,
    removingWorktreePath: worktree.path,
  });
  const { error, loading, preview } = branchPreview;

  useEffect(() => {
    finish.update({
      branchPreview: { error, loading, preview },
      status,
      statusLoading,
    });
  }, [error, finish, loading, preview, status, statusLoading]);

  useEffect(() => {
    if (open) finish.start();
  }, [finish, open]);

  useEffect(() => () => finish.dispose(), [finish]);

  return { finish, snapshot };
};
