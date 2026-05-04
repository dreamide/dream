import {
  Code,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  UploadCloud,
} from "lucide-react";
import { memo, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { cn } from "@/lib/utils";
import type { AiProvider, ProjectGitStatusResponse } from "@/types/ide";
import { CommitDialog } from "./git-actions/commit-dialog";
import { CreatePrDialog } from "./git-actions/create-pr-dialog";
import { PushDialog } from "./git-actions/push-dialog";
import { GitMenuDeltaSummary } from "./git-actions/summary";
import { getStatusFileCount, hasPushableCommits } from "./git-actions/utils";
import { useIdeStore } from "./ide-store";

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
      projectPath={projectPath}
      status={status}
    />
  );
};

const GitActionsMenuImpl = ({
  projectId,
  projectPath,
}: GitActionsMenuProps) => {
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
  const provider = useIdeStore(
    (s) =>
      s.projects.find((project) => project.id === projectId)?.provider ??
      "openai",
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
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="Open Git actions"
              className={cn(
                "size-8 [-webkit-app-region:no-drag]",
                hasGitActivity
                  ? "text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
                  : "text-muted-foreground hover:text-foreground",
              )}
              size="icon"
              title="Git actions"
              variant="ghost"
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
            Changes
            <GitMenuDeltaSummary status={status} />
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!hasGitChanges}
            onClick={() => handleOpenDialog("commit")}
          >
            <GitCommitHorizontal className="size-4" />
            Commit
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canPush}
            onClick={() => handleOpenDialog("push")}
          >
            <UploadCloud className="size-4" />
            Push
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canCreatePr}
            onClick={() => handleOpenDialog("pr")}
          >
            <GitPullRequest className="size-4" />
            Create pull request
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
          projectPath={projectPath}
          provider={provider}
          refreshToken={gitRefreshKey}
          status={status}
        />
      ) : null}
    </>
  );
};

export const GitActionsMenu = memo(GitActionsMenuImpl);
GitActionsMenu.displayName = "GitActionsMenu";
