import {
  Code,
  FolderX,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  UploadCloud,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { getDefaultGitGenerationModelSelection } from "@/lib/ide-defaults";
import type {
  AiProvider,
  ModelSpeed,
  ProjectConfig,
  ProjectGitStatusResponse,
  ProjectWorktreeInfo,
  ReasoningEffort,
} from "@/types/ide";
import { getPullRequestBranchError } from "./git-actions/branch-utils";
import { CommitDialog } from "./git-actions/commit-dialog";
import { CreatePrDialog } from "./git-actions/create-pr-dialog";
import { PushDialog } from "./git-actions/push-dialog";
import { GitMenuDeltaSummary } from "./git-actions/summary";
import { getStatusFileCount, hasPushableCommits } from "./git-actions/utils";
import {
  WorktreeActionDialog,
  type WorktreeDialogAction,
} from "./git-actions/worktree-action-dialog";
import { useIdeStore } from "./ide-store";
import { SourceControlIcon } from "./source-control-icon";
import { WorkspaceNavButton } from "./workspace/nav-button";

type GitActionDialog = "commit" | "push" | "pr" | WorktreeDialogAction | null;
type ActiveGitActionDialog = Exclude<
  GitActionDialog,
  WorktreeDialogAction | null
>;
type WorktreeProject = ProjectConfig & { worktree: ProjectWorktreeInfo };

const isWorktreeDialog = (
  dialog: GitActionDialog,
): dialog is WorktreeDialogAction => dialog === "merge" || dialog === "remove";

interface GitActionsMenuProps {
  projectId: string;
  projectPath: string;
}

const GitActionDialogHost = ({
  action,
  branch,
  onActionCompleted,
  onOpenChange,
  onPrCompleted,
  model,
  modelSpeed,
  projectPath,
  provider,
  reasoningEffort,
  refreshToken,
  status,
}: {
  action: ActiveGitActionDialog;
  branch: string | null;
  onActionCompleted: () => void;
  onOpenChange: (open: boolean) => void;
  onPrCompleted: (url: string | null, shouldOpen: boolean) => void;
  model: string;
  modelSpeed: ModelSpeed;
  projectPath: string;
  provider: AiProvider;
  reasoningEffort: ReasoningEffort | null;
  refreshToken: number;
  status: ProjectGitStatusResponse | null;
}) => {
  if (action === "commit") {
    return (
      <CommitDialog
        branch={branch}
        onCompleted={onActionCompleted}
        onOpenChange={onOpenChange}
        open
        model={model}
        modelSpeed={modelSpeed}
        projectPath={projectPath}
        provider={provider}
        reasoningEffort={reasoningEffort}
        refreshToken={refreshToken}
        status={status}
      />
    );
  }

  if (action === "push") {
    return (
      <PushDialog
        branch={branch}
        onCompleted={onActionCompleted}
        onOpenChange={onOpenChange}
        open
        projectPath={projectPath}
        status={status}
      />
    );
  }

  return (
    <CreatePrDialog
      branch={branch}
      onCompleted={onPrCompleted}
      onOpenChange={onOpenChange}
      open
      model={model}
      modelSpeed={modelSpeed}
      projectPath={projectPath}
      provider={provider}
      reasoningEffort={reasoningEffort}
      refreshToken={refreshToken}
      status={status}
    />
  );
};

const GitActionsMenuImpl = ({
  projectId,
  projectPath,
}: GitActionsMenuProps) => {
  const commonT = useTranslations("common");
  const gitT = useTranslations("git");
  const worktreeT = useTranslations("worktrees");
  const worktreeProject = useIdeStore((s) => {
    const project = s.projects.find((item) => item.id === projectId);
    return project?.worktree ? (project as WorktreeProject) : null;
  });
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[projectId] ?? 0,
  );
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const setProjectRightPanelOpen = useIdeStore(
    (s) => s.setProjectRightPanelOpen,
  );
  const setProjectRightPanelView = useIdeStore(
    (s) => s.setProjectRightPanelView,
  );
  const openExternalUrl = useIdeStore((s) => s.openExternalUrl);
  const settings = useIdeStore((s) => s.settings);
  const gitGenerationModelSelection = useMemo(
    () => getDefaultGitGenerationModelSelection(settings),
    [settings],
  );
  const [activeDialog, setActiveDialog] = useState<GitActionDialog>(null);
  // Kept after close, so a closing dialog does not switch modes mid-animation.
  const [worktreeAction, setWorktreeAction] =
    useState<WorktreeDialogAction>("merge");
  const [menuOpen, setMenuOpen] = useState(false);
  const { branch, status } = useProjectGitStatus(projectPath, gitRefreshKey, {
    detail: menuOpen || activeDialog ? "full" : "summary",
  });
  const hasGitChanges = getStatusFileCount(status) > 0;
  const canPush = hasPushableCommits(status);
  const isPullRequestHeadBranch =
    Boolean(status?.remoteName) &&
    !getPullRequestBranchError(branch, status?.baseBranch ?? "main", {
      detachedHead: "detached",
      sameBranch: () => "same",
    });
  const canCreatePr = hasGitChanges || canPush || isPullRequestHeadBranch;
  const hasGitActivity = hasGitChanges || canPush;
  // Same fallback the merge uses: the base recorded at creation, else the
  // repository's default base branch.
  const worktreeMergeBase =
    worktreeProject?.worktree.baseRef ?? status?.baseBranch ?? null;

  const handleOpenChanges = useCallback(() => {
    setProjectRightPanelView(projectId, "changes");
    setProjectRightPanelOpen(projectId, true);
  }, [projectId, setProjectRightPanelOpen, setProjectRightPanelView]);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      if (open) {
        bumpProjectGitRefreshKey(projectId);
      }
    },
    [bumpProjectGitRefreshKey, projectId],
  );

  const handleOpenDialog = useCallback(
    (dialog: GitActionDialog) => {
      if (dialog === "push" && !canPush) {
        return;
      }

      if (dialog === "commit" && !hasGitChanges) {
        return;
      }

      if (dialog === "pr" && !canCreatePr) {
        return;
      }

      if (isWorktreeDialog(dialog)) {
        if (!worktreeProject) {
          return;
        }
        setWorktreeAction(dialog);
      }

      setActiveDialog(dialog);
    },
    [canCreatePr, canPush, hasGitChanges, worktreeProject],
  );

  const handleActionCompleted = useCallback(() => {
    bumpProjectGitRefreshKey(projectId);
  }, [bumpProjectGitRefreshKey, projectId]);

  const handlePrCompleted = useCallback(
    (url: string | null, shouldOpen: boolean) => {
      handleActionCompleted();
      if (url && shouldOpen) {
        openExternalUrl(url);
      }
    },
    [handleActionCompleted, openExternalUrl],
  );

  const handleDialogOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      setActiveDialog(null);
    }
  }, []);

  return (
    <>
      <DropdownMenu onOpenChange={handleMenuOpenChange} open={menuOpen}>
        <DropdownMenuTrigger
          render={
            <WorkspaceNavButton
              aria-label={gitT("openActions")}
              accent={hasGitActivity}
              title={gitT("actions")}
            />
          }
        >
          <SourceControlIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="left"
          className="w-52 [-webkit-app-region:no-drag]"
        >
          <DropdownMenuItem onClick={handleOpenChanges}>
            <Code className="size-4" />
            {commonT("changes")}
            <GitMenuDeltaSummary status={status} />
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!hasGitChanges}
            onClick={() => handleOpenDialog("commit")}
          >
            <GitCommitHorizontal className="size-4" />
            {gitT("commit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canPush}
            onClick={() => handleOpenDialog("push")}
          >
            <UploadCloud className="size-4" />
            {gitT("push")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canCreatePr}
            onClick={() => handleOpenDialog("pr")}
          >
            <GitPullRequest className="size-4" />
            {gitT("createPullRequest")}
          </DropdownMenuItem>
          {worktreeProject ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleOpenDialog("merge")}>
                <GitMerge className="size-4" />
                {worktreeMergeBase
                  ? worktreeT("mergeInto", { base: worktreeMergeBase })
                  : worktreeT("merge")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleOpenDialog("remove")}
                variant="destructive"
              >
                <FolderX className="size-4" />
                {worktreeT("removeWorktree")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {activeDialog && !isWorktreeDialog(activeDialog) ? (
        <GitActionDialogHost
          action={activeDialog}
          branch={branch}
          onActionCompleted={handleActionCompleted}
          onOpenChange={handleDialogOpenChange}
          onPrCompleted={handlePrCompleted}
          model={gitGenerationModelSelection.model}
          modelSpeed={gitGenerationModelSelection.modelSpeed}
          projectPath={projectPath}
          provider={gitGenerationModelSelection.provider}
          reasoningEffort={gitGenerationModelSelection.reasoningEffort}
          refreshToken={gitRefreshKey}
          status={status}
        />
      ) : null}
      {worktreeProject ? (
        <WorktreeActionDialog
          action={worktreeAction}
          onOpenChange={handleDialogOpenChange}
          open={isWorktreeDialog(activeDialog)}
          project={worktreeProject}
        />
      ) : null}
    </>
  );
};

export const GitActionsMenu = memo(GitActionsMenuImpl);
GitActionsMenu.displayName = "GitActionsMenu";
