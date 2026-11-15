import type {
  ProjectGitCreatePrNextStep,
  ProjectGitStatusResponse,
} from "@/types/ide";
import type { PullRequestSummary } from "../pull-requests/api";
import { getPullRequestBranchError } from "./branch-utils";
import { getStatusFileCount } from "./utils";

/**
 * The branch's pull request as far as the client knows: the pull request,
 * `null` when it has none, `"loading"` before the first lookup answers, and
 * `"unavailable"` when the lookup failed (no `gh`, a remote that is not on
 * GitHub, GitHub unreachable).
 */
export type BranchPullRequest =
  | PullRequestSummary
  | null
  | "loading"
  | "unavailable";

/** Creating a pull request from the branch into its base. */
export interface CreatePullRequestAction {
  /** Listed in the menu: no open pull request, and none merged without newer work. */
  offered: boolean;
  /** Can be started now: a remote, a branch to propose, no git write running. */
  enabled: boolean;
  /** The branch the pull request goes into. */
  baseBranch: string;
  /** Why no pull request can be opened from this branch into its base. */
  problem: "detached-head" | "same-branch" | null;
  /** What creating it does first by default: commit and push, push, or neither. */
  nextStep: ProjectGitCreatePrNextStep;
  /** The next steps that can be chosen. */
  nextSteps: ProjectGitCreatePrNextStep[];
}

/**
 * The Project git writes a branch offers, each enabled or not. Several are
 * offered at once; the menu lists them all rather than one next step.
 */
export interface BranchActions {
  /** Commit the changed files. */
  commit: { enabled: boolean; fileCount: number };
  /** Push commits ahead of the upstream, or publish a branch that has none. */
  push: { enabled: boolean; publish: boolean; aheadCount: number };
  fetch: { enabled: boolean };
  /** Pull from the upstream. */
  pull: { enabled: boolean; behindCount: number };
  /** The branch's pull request, in any state, once known. */
  viewPullRequest: PullRequestSummary | null;
  createPullRequest: CreatePullRequestAction;
  /** Merge a worktree into its base or remove it; null for a branch that is not a worktree. */
  worktree: { enabled: boolean; mergeBase: string | null } | null;
  /** Something is ready to commit or push and no git write runs. */
  highlighted: boolean;
}

export const getBranchActions = ({
  pullRequest,
  status,
  worktree,
  writeRunning,
}: {
  pullRequest: BranchPullRequest;
  /** A full status read: the upstream and ahead and behind counts are only in one. */
  status: ProjectGitStatusResponse;
  /** Set for a worktree project: the ref it was created from, if known. */
  worktree: { baseRef: string | null } | null;
  /** A git write runs for the project; no other may start. */
  writeRunning: boolean;
}): BranchActions => {
  const fileCount = getStatusFileCount(status);
  const hasChanges = fileCount > 0;
  const hasRemote = Boolean(status.remoteName);
  const upstream = Boolean(status.upstreamBranch);
  // A branch with an upstream pushes its commits ahead; one without is
  // published, when there is a remote to publish to.
  const canPush = upstream ? status.aheadCount > 0 : hasRemote;

  const baseBranch = status.baseBranch ?? "main";
  const problem = getPullRequestBranchError<CreatePullRequestAction["problem"]>(
    status.branch,
    baseBranch,
    {
      detachedHead: "detached-head",
      sameBranch: () => "same-branch",
    },
  );
  const known = typeof pullRequest === "object" ? pullRequest : null;
  // Not offered while loading, so a branch with an open pull request is
  // never offered a second. A failed lookup still offers it: `gh` refuses a
  // duplicate, and says why it cannot create one. A merged pull request is
  // the branch's only while the branch has no newer work (`branchPullRequest`
  // on the host), so there is nothing new to propose.
  const offered =
    pullRequest !== "loading" &&
    known?.state !== "open" &&
    known?.state !== "merged";

  return {
    commit: { enabled: hasChanges && !writeRunning, fileCount },
    push: {
      aheadCount: upstream ? status.aheadCount : 0,
      enabled: canPush && !writeRunning,
      publish: !upstream,
    },
    fetch: { enabled: hasRemote && !writeRunning },
    pull: {
      behindCount: upstream ? status.behindCount : 0,
      enabled: upstream && !writeRunning,
    },
    viewPullRequest: known,
    createPullRequest: {
      baseBranch,
      enabled: hasRemote && !problem && !writeRunning,
      nextStep: hasChanges
        ? "commit-push-create"
        : !upstream || status.aheadCount > 0
          ? "push-create"
          : "create",
      nextSteps: problem
        ? []
        : hasChanges
          ? ["create", "push-create", "commit-push-create"]
          : ["create", "push-create"],
      offered,
      problem,
    },
    worktree: worktree
      ? {
          enabled: !writeRunning,
          mergeBase: worktree.baseRef ?? status.baseBranch ?? null,
        }
      : null,
    highlighted: !writeRunning && (hasChanges || canPush),
  };
};
