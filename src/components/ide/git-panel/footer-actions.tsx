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
import { memo, useCallback, useMemo, useState } from "react";
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
  ProjectGitPullResponse,
  ProjectWorktreeInfo,
} from "@/types/ide";
import { getPullRequestBranchError } from "../git-actions/branch-utils";
import { CreatePrDialog } from "../git-actions/create-pr-dialog";
import { PullDialog } from "../git-actions/pull-dialog";
import { PushDialog } from "../git-actions/push-dialog";
import { GitMenuDeltaSummary } from "../git-actions/summary";
import { getStatusFileCount, hasPushableCommits } from "../git-actions/utils";
import {
  WorktreeActionDialog,
  type WorktreeDialogAction,
} from "../git-actions/worktree-action-dialog";
import { useIdeStore } from "../ide-store";
import { usePullRequestContext } from "../pull-requests/api";
import { SourceControlIcon } from "../source-control-icon";
import { useShowGitPanel } from "./show-git-panel";

type WorktreeProject = ProjectConfig & { worktree: ProjectWorktreeInfo };

// Long enough to reach the toast's View changes action.
const PULL_TOAST_DURATION_MS = 8000;

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
  const worktreeProject = project.worktree
    ? (project as WorktreeProject)
    : null;
  // Full detail: the upstream and ahead/behind counts are only in a full read.
  const { status } = useProjectGitStatus(projectPath, {
    active,
    detail: "full",
    hostId: project.hostId,
  });
  const { data: pullRequestContext } = usePullRequestContext(
    projectPath,
    active && Boolean(status?.isRepo),
    project.hostId,
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
  const [pullResult, setPullResult] = useState<ProjectGitPullResponse | null>(
    null,
  );
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  // Kept after close, so a closing dialog does not switch modes mid-animation.
  const [worktreeAction, setWorktreeAction] =
    useState<WorktreeDialogAction>("merge");

  const pullRequest = pullRequestContext
    ? pullRequestContext.current
    : undefined;
  const hasChanges = getStatusFileCount(status) > 0;
  const canPush = hasPushableCommits(status);
  const gitBusy = gitWrite !== null;
  // Something is ready to commit or push: the trigger is tinted like the
  // sidebar's accented buttons.
  const highlightTrigger = !gitBusy && (hasChanges || canPush);
  const syncing = gitWrite === "fetch" || gitWrite === "pull" ? gitWrite : null;
  const canCreatePr =
    Boolean(status?.remoteName) &&
    pullRequest?.state !== "open" &&
    !getPullRequestBranchError(
      status?.branch ?? null,
      status?.baseBranch ?? "main",
      { detachedHead: "detached", sameBranch: () => "same" },
    );
  const worktreeMergeBase =
    worktreeProject?.worktree.baseRef ?? status?.baseBranch ?? null;

  const handleSync = async (action: "fetch" | "pull") => {
    if (gitBusy) return;
    const store = useIdeStore.getState();
    if (action === "fetch") {
      const outcome = await store.fetchProject(projectId);
      if (outcome.ok) {
        toast.success(gitT("fetchedFrom", { target: outcome.result.remote }));
      } else {
        toast.error(getApiErrorMessage(outcome.error, gitT("unableToFetch")));
      }
      return;
    }
    const outcome = await store.pullProject(projectId);
    if (outcome.ok) {
      const result = outcome.result;
      const { commitCount, upstreamBranch } = result;
      if (commitCount === 0) {
        toast.success(gitT("alreadyUpToDate", { target: upstreamBranch }));
        return;
      }
      const title = gitT("pulledFrom", {
        count: commitCount,
        target: upstreamBranch,
      });
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
      const { url } = await apiClient.gitRemoteUrl({ projectPath });
      openExternalUrl(url);
    } catch (error) {
      toast.error(getApiErrorMessage(error, gitT("unableToOpenRepository")));
    } finally {
      setOpeningRepository(false);
    }
  };

  const openWorktreeDialog = useCallback((action: WorktreeDialogAction) => {
    setWorktreeAction(action);
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

  const menu = (
    <DropdownMenuContent align="end" className="w-56" side="top">
      <DropdownMenuItem
        disabled={!hasChanges || gitBusy}
        onClick={() => showGitPanel("changes", { focusCommitMessage: true })}
      >
        <GitCommitHorizontal className="size-4" />
        {gitT("commit")}
        <GitMenuDeltaSummary status={status} />
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!canPush || gitBusy}
        onClick={() => setPushOpen(true)}
      >
        <UploadCloud className="size-4" />
        {status.upstreamBranch ? gitT("push") : gitT("publishBranch")}
        <MenuCommitCount
          count={status.upstreamBranch ? status.aheadCount : 0}
          direction="ahead"
        />
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!status.remoteName || gitBusy}
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
        disabled={!status.upstreamBranch || gitBusy}
        onClick={() => void handleSync("pull")}
      >
        {syncing === "pull" ? (
          <Spinner className="size-4" />
        ) : (
          <ArrowDown className="size-4" />
        )}
        {gitT("pull")}
        <MenuCommitCount
          count={status.upstreamBranch ? status.behindCount : 0}
          direction="behind"
        />
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {pullRequest ? (
        <DropdownMenuItem onClick={() => showGitPanel("pull-request")}>
          <GitPullRequest className="size-4" />
          {gitT("viewPullRequest", { number: pullRequest.number })}
        </DropdownMenuItem>
      ) : null}
      {pullRequest?.state === "open" ? null : (
        <DropdownMenuItem
          disabled={!canCreatePr || gitBusy}
          onClick={() => setCreatePrOpen(true)}
        >
          <GitPullRequest className="size-4" />
          {gitT("createPullRequest")}
        </DropdownMenuItem>
      )}
      {worktreeProject ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={gitBusy}
            onClick={() => openWorktreeDialog("merge")}
          >
            <GitMerge className="size-4" />
            {worktreeMergeBase
              ? worktreeT("mergeInto", { base: worktreeMergeBase })
              : worktreeT("merge")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={gitBusy}
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={gitT("gitActions")}
              className={highlightTrigger ? undefined : "text-muted-foreground"}
              size="icon-sm"
              title={gitT("gitActions")}
              variant={highlightTrigger ? "accent-subtle" : "ghost"}
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
          hostId={project.hostId}
          onOpenChange={setPushOpen}
          open
          projectId={projectId}
          projectPath={projectPath}
          refreshToken={gitRefreshKey}
          status={status}
        />
      ) : null}
      {createPrOpen ? (
        <CreatePrDialog
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
      {worktreeProject ? (
        <WorktreeActionDialog
          action={worktreeAction}
          onOpenChange={setWorktreeDialogOpen}
          open={worktreeDialogOpen}
          project={worktreeProject}
        />
      ) : null}
    </>
  );
};

export const GitFooterActions = memo(GitFooterActionsImpl);
GitFooterActions.displayName = "GitFooterActions";
