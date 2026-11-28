import {
  ArrowDown,
  ArrowUp,
  Download,
  ExternalLink,
  FolderX,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  History,
  UploadCloud,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { lazy, memo, Suspense, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import { getDefaultGitGenerationModelSelection } from "@/lib/ide-defaults";
import type {
  ProjectConfig,
  ProjectGitPulledResponse,
  ProjectGitPullStrategy,
  ProjectWorktreeInfo,
} from "@/types/ide";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import {
  type BranchPullRequest,
  getBranchActions,
} from "../git-actions/branch-actions";
import { CreatePrDialog } from "../git-actions/create-pr-dialog";
import { PullDialog } from "../git-actions/pull-dialog";
import { PushDialog } from "../git-actions/push-dialog";
import { GitMenuDeltaSummary } from "../git-actions/summary";
import type { WorktreeDialogAction } from "../git-actions/worktree-action-dialog";
import { useIdeStore } from "../ide-store";
import { usePullRequestContext } from "../pull-requests/api";
import { SourceControlIcon } from "../source-control-icon";
import { useShowGitPanel } from "./show-git-panel";

const WorktreeActionDialog = lazy(() =>
  import("../git-actions/worktree-action-dialog").then((module) => ({
    default: module.WorktreeActionDialog,
  })),
);

type WorktreeProject = ProjectConfig & { worktree: ProjectWorktreeInfo };

// Long enough to reach the toast's View changes action.
const PULL_TOAST_DURATION_MS = 8000;
/** Conflicting files a pull toast names before summing up the rest. */
const PULL_CONFLICT_FILES_SHOWN = 5;

/** The ways a conflicted pull toast offers to pull again. */
const PULL_RETRY_STRATEGIES = [
  {
    description: "pullKeepMineDescription",
    label: "pullKeepMine",
    strategy: "ours",
  },
  {
    description: "pullTakeTheirsDescription",
    label: "pullTakeTheirs",
    strategy: "theirs",
  },
  {
    description: "pullRebaseDescription",
    label: "pullRebase",
    strategy: "rebase",
  },
] as const satisfies readonly {
  description: string;
  label: string;
  strategy: ProjectGitPullStrategy;
}[];

/** A commit count on the right of a git menu item, e.g. "↑ 2". */
const MenuCommitCount = ({
  count,
  direction,
}: {
  count: number;
  direction: "ahead" | "behind";
}) => {
  if (count === 0) return null;
  const Arrow = direction === "ahead" ? ArrowUp : ArrowDown;
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-mono text-muted-foreground text-xs tabular-nums group-focus/dropdown-menu-item:text-accent-foreground">
      <Arrow className="size-3" />
      {count}
    </span>
  );
};

/**
 * The chat footer's git menu (commit, push, sync, pull requests, finish a
 * worktree), with pending line and commit counts beside its items.
 */
const GitFooterActionsImpl = ({
  active,
  project,
}: {
  /** Whether the project's workspace is on screen. */
  active: boolean;
  project: ProjectConfig;
}) => {
  const gitT = useTranslations("git");
  const worktreeT = useTranslations("worktrees");
  const projectId = project.id;
  const projectPath = project.path;
  const hostId = getProjectHostId(project);
  const worktreeProject = project.worktree
    ? (project as WorktreeProject)
    : null;
  // Full detail: the upstream and ahead/behind counts are only in a full read.
  const { status } = useProjectGitStatus(projectPath, {
    active,
    detail: "full",
    hostId,
  });
  const { data: pullRequestContext, lookupFailed } = usePullRequestContext(
    projectPath,
    active && Boolean(status?.isRepo),
    hostId,
  );
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[projectId] ?? 0,
  );
  // The git write running for this project, from any surface.
  const gitWrite = useIdeStore((s) => s.gitWriteByProject[projectId] ?? null);
  const openExternalUrl = useIdeStore((s) => s.openExternalUrl);
  const settings = useIdeStore((s) => s.settings);
  const modelSelection = useMemo(
    () => getDefaultGitGenerationModelSelection(settings),
    [settings],
  );
  const showGitPanel = useShowGitPanel(projectId);
  const [openingRepository, setOpeningRepository] = useState(false);
  const [createPrOpen, setCreatePrOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);
  // Kept after close, so the closing dialog keeps its contents.
  const [pullResult, setPullResult] = useState<ProjectGitPulledResponse | null>(
    null,
  );
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [worktreeDialogMounted, setWorktreeDialogMounted] = useState(false);
  // Kept after close, so a closing dialog does not switch modes mid-animation.
  const [worktreeAction, setWorktreeAction] =
    useState<WorktreeDialogAction>("merge");

  const pullRequest: BranchPullRequest = pullRequestContext
    ? pullRequestContext.current
    : lookupFailed
      ? "unavailable"
      : "loading";
  const gitBusy = gitWrite !== null;
  const syncing = gitWrite === "fetch" || gitWrite === "pull" ? gitWrite : null;

  const handleSync = async (action: "fetch" | "pull") => {
    if (gitBusy) return;
    if (action === "pull") {
      await handlePull("merge");
      return;
    }
    const outcome = await useIdeStore.getState().fetchProject(projectId);
    if (outcome.ok) {
      toast.success(gitT("fetchedFrom", { target: outcome.result.remote }));
    } else {
      toast.error(getApiErrorMessage(outcome.error, gitT("unableToFetch")));
    }
  };

  const handlePull = async (strategy: ProjectGitPullStrategy) => {
    const outcome = await useIdeStore
      .getState()
      .pullProject(projectId, { strategy });
    if (outcome.ok) {
      const result = outcome.result;
      if (result.status === "conflict") {
        const files = result.conflictingFiles;
        // Older hosts ignore the strategy and do not name one.
        const tried = result.strategy ?? strategy;
        const id = crypto.randomUUID();
        toast.error(
          gitT(tried === "rebase" ? "rebaseConflict" : "pullConflict", {
            target: result.upstreamBranch,
          }),
          {
            description: (
              <div className="space-y-2">
                {files.length > 0 ? (
                  <div className="space-y-0.5">
                    {files.slice(0, PULL_CONFLICT_FILES_SHOWN).map((file) => (
                      <div className="truncate font-mono text-xs" key={file}>
                        {file}
                      </div>
                    ))}
                    {files.length > PULL_CONFLICT_FILES_SHOWN ? (
                      <div className="text-xs">
                        {gitT("moreFiles", {
                          count: files.length - PULL_CONFLICT_FILES_SHOWN,
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  {PULL_RETRY_STRATEGIES.filter(
                    (retry) => retry.strategy !== tried,
                  ).map((retry) => (
                    <Button
                      key={retry.strategy}
                      onClick={() => {
                        toast.dismiss(id);
                        void handlePull(retry.strategy);
                      }}
                      size="sm"
                      title={gitT(retry.description)}
                      variant="outline"
                    >
                      {gitT(retry.label)}
                    </Button>
                  ))}
                </div>
              </div>
            ),
            duration: PULL_TOAST_DURATION_MS,
            id,
          },
        );
        return;
      }
      const { commitCount, upstreamBranch } = result;
      if (commitCount === 0) {
        toast.success(gitT("alreadyUpToDate", { target: upstreamBranch }));
        return;
      }
      const title = gitT(
        result.rebased
          ? "rebasedFrom"
          : result.merged
            ? "mergedFrom"
            : "pulledFrom",
        {
          count: commitCount,
          target: upstreamBranch,
        },
      );
      // Older hosts answer with the count alone.
      if (!result.commits?.length && !result.files?.length) {
        toast.success(title);
        return;
      }
      const id = crypto.randomUUID();
      toast.success(title, {
        // A React element is rendered as-is, so the toast doesn't dismiss
        // itself on click the way a { label, onClick } action does.
        action: (
          <Button
            onClick={() => {
              toast.dismiss(id);
              setPullResult(result);
              setPullOpen(true);
            }}
            size="sm"
          >
            {gitT("viewChanges")}
          </Button>
        ),
        duration: PULL_TOAST_DURATION_MS,
        id,
      });
    } else {
      toast.error(getApiErrorMessage(outcome.error, gitT("unableToPull")));
    }
  };

  const handleOpenRepository = async () => {
    if (openingRepository) return;
    setOpeningRepository(true);
    try {
      const { url } = await apiClient.gitRemoteUrl({ projectPath }, { hostId });
      openExternalUrl(url);
    } catch (error) {
      toast.error(getApiErrorMessage(error, gitT("unableToOpenRepository")));
    } finally {
      setOpeningRepository(false);
    }
  };

  const openWorktreeDialog = useCallback((action: WorktreeDialogAction) => {
    setWorktreeAction(action);
    setWorktreeDialogMounted(true);
    setWorktreeDialogOpen(true);
  }, []);

  const handlePrCompleted = useCallback(
    (url: string | null, shouldOpen: boolean) => {
      if (url && shouldOpen) {
        openExternalUrl(url);
      }
    },
    [openExternalUrl],
  );

  if (!status?.isRepo) {
    return null;
  }

  const actions = getBranchActions({
    pullRequest,
    status,
    worktree: worktreeProject?.worktree ?? null,
    writeRunning: gitBusy,
  });

  const menu = (
    <DropdownMenuContent align="end" className="w-56" side="top">
      <DropdownMenuItem
        disabled={!actions.commit.enabled}
        onClick={() => showGitPanel("changes", { focusCommitMessage: true })}
      >
        <GitCommitHorizontal className="size-4" />
        {gitT("commit")}
        <GitMenuDeltaSummary status={status} />
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!actions.push.enabled}
        onClick={() => setPushOpen(true)}
      >
        <UploadCloud className="size-4" />
        {actions.push.publish ? gitT("publishBranch") : gitT("push")}
        <MenuCommitCount count={actions.push.aheadCount} direction="ahead" />
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!actions.fetch.enabled}
        onClick={() => void handleSync("fetch")}
      >
        {syncing === "fetch" ? (
          <Spinner className="size-4" />
        ) : (
          <Download className="size-4" />
        )}
        {gitT("fetch")}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!actions.pull.enabled}
        onClick={() => void handleSync("pull")}
      >
        {syncing === "pull" ? (
          <Spinner className="size-4" />
        ) : (
          <ArrowDown className="size-4" />
        )}
        {gitT("pull")}
        <MenuCommitCount count={actions.pull.behindCount} direction="behind" />
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {actions.viewPullRequest ? (
        <DropdownMenuItem onClick={() => showGitPanel("pull-request")}>
          <GitPullRequest className="size-4" />
          {gitT("viewPullRequest", {
            number: actions.viewPullRequest.number,
          })}
        </DropdownMenuItem>
      ) : null}
      {actions.createPullRequest?.offered ? (
        <DropdownMenuItem
          disabled={!actions.createPullRequest.enabled}
          onClick={() => setCreatePrOpen(true)}
        >
          <GitPullRequest className="size-4" />
          {gitT("createPullRequest")}
        </DropdownMenuItem>
      ) : null}
      {actions.worktree ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!actions.worktree.enabled}
            onClick={() => openWorktreeDialog("merge")}
          >
            <GitMerge className="size-4" />
            {actions.worktree.mergeBase
              ? worktreeT("mergeInto", { base: actions.worktree.mergeBase })
              : worktreeT("merge")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!actions.worktree.enabled}
            onClick={() => openWorktreeDialog("remove")}
            variant="destructive"
          >
            <FolderX className="size-4" />
            {worktreeT("removeWorktree")}
          </DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => showGitPanel("log")}>
        <History className="size-4" />
        {gitT("viewHistory")}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!status.remoteName || openingRepository}
        onClick={() => void handleOpenRepository()}
      >
        {openingRepository ? (
          <Spinner className="size-4" />
        ) : (
          <ExternalLink className="size-4" />
        )}
        {gitT("openRepository")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  // A highlighted trigger is tinted like the sidebar's accented buttons.
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={gitT("gitActions")}
              className={
                actions.highlighted ? undefined : "text-muted-foreground"
              }
              size="icon-sm"
              title={gitT("gitActions")}
              variant={actions.highlighted ? "accent-subtle" : "ghost"}
            />
          }
        >
          {gitBusy ? (
            <Spinner className="size-3.5" />
          ) : (
            <SourceControlIcon className="size-3.5" />
          )}
        </DropdownMenuTrigger>
        {menu}
      </DropdownMenu>

      {pushOpen ? (
        <PushDialog
          branch={status.branch}
          canPush={actions.push.enabled}
          hostId={hostId}
          onOpenChange={setPushOpen}
          open
          projectId={projectId}
          projectPath={projectPath}
          refreshToken={gitRefreshKey}
          status={status}
        />
      ) : null}
      {createPrOpen && actions.createPullRequest ? (
        <CreatePrDialog
          action={actions.createPullRequest}
          branch={status.branch}
          onCompleted={handlePrCompleted}
          onOpenChange={setCreatePrOpen}
          open
          model={modelSelection.model}
          modelSpeed={modelSelection.modelSpeed}
          projectId={projectId}
          projectPath={projectPath}
          provider={modelSelection.provider}
          reasoningEffort={modelSelection.reasoningEffort}
          refreshToken={gitRefreshKey}
          status={status}
        />
      ) : null}
      <PullDialog
        onOpenChange={setPullOpen}
        open={pullOpen}
        result={pullResult}
      />
      {worktreeProject && (worktreeDialogOpen || worktreeDialogMounted) ? (
        <Suspense fallback={null}>
          <WorktreeActionDialog
            action={worktreeAction}
            onOpenChange={setWorktreeDialogOpen}
            open={worktreeDialogOpen}
            project={worktreeProject}
          />
        </Suspense>
      ) : null}
    </>
  );
};

export const GitFooterActions = memo(GitFooterActionsImpl);
GitFooterActions.displayName = "GitFooterActions";
