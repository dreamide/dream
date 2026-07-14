import {
  Code,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  UploadCloud,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { getDefaultGitGenerationModelSelection } from "@/lib/ide-defaults";
import type { AiProvider, ProjectGitStatusResponse } from "@/types/ide";
import { CommitDialog } from "./git-actions/commit-dialog";
import { CreatePrDialog } from "./git-actions/create-pr-dialog";
import { PushDialog } from "./git-actions/push-dialog";
import { GitMenuDeltaSummary } from "./git-actions/summary";
import { getStatusFileCount, hasPushableCommits } from "./git-actions/utils";
import { useIdeStore } from "./ide-store";
import { WorkspaceNavButton } from "./workspace/nav-button";

type GitActionDialog = "commit" | "push" | "pr" | null;
type ActiveGitActionDialog = Exclude<GitActionDialog, null>;

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
  projectPath,
  provider,
  refreshToken,
  status,
}: {
  action: ActiveGitActionDialog;
  branch: string | null;
  onActionCompleted: () => void;
  onOpenChange: (open: boolean) => void;
  onPrCompleted: (url: string | null, shouldOpen: boolean) => void;
  model: string;
  projectPath: string;
  provider: AiProvider;
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
        projectPath={projectPath}
        provider={provider}
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
      projectPath={projectPath}
      provider={provider}
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
  const { branch, status } = useProjectGitStatus(projectPath, gitRefreshKey);
  const [activeDialog, setActiveDialog] = useState<GitActionDialog>(null);
  const hasGitChanges = getStatusFileCount(status) > 0;
  const canPush = hasPushableCommits(status);
  const canCreatePr = hasGitChanges || canPush;
  const hasGitActivity = hasGitChanges || canPush;

  const handleOpenChanges = useCallback(() => {
    setProjectRightPanelView(projectId, "changes");
    setProjectRightPanelOpen(projectId, true);
  }, [projectId, setProjectRightPanelOpen, setProjectRightPanelView]);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
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

      setActiveDialog(dialog);
    },
    [canCreatePr, canPush, hasGitChanges],
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
      <DropdownMenu onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger
          render={
            <WorkspaceNavButton
              aria-label={gitT("openActions")}
              accent={hasGitActivity}
              title={gitT("actions")}
            />
          }
        >
          <GitFork className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
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
        </DropdownMenuContent>
      </DropdownMenu>

      {activeDialog ? (
        <GitActionDialogHost
          action={activeDialog}
          branch={branch}
          onActionCompleted={handleActionCompleted}
          onOpenChange={handleDialogOpenChange}
          onPrCompleted={handlePrCompleted}
          model={gitGenerationModelSelection.model}
          projectPath={projectPath}
          provider={gitGenerationModelSelection.provider}
          refreshToken={gitRefreshKey}
          status={status}
        />
      ) : null}
    </>
  );
};

export const GitActionsMenu = memo(GitActionsMenuImpl);
GitActionsMenu.displayName = "GitActionsMenu";
