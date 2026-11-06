import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useBranchDeletePreview } from "@/hooks/use-branch-delete-preview";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { getApiErrorMessage } from "@/lib/api-client";
import type { ProjectConfig, ProjectGitWorktreeInfo } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import {
  BranchDeleteSummary,
  branchDeleteBlockedKey,
  confirmedHeadFor,
} from "./branch-delete-summary";
import { InfoLine } from "./info-line";

const ErrorMessage = ({ children }: { children: string }) => (
  <p className="min-w-0 whitespace-pre-wrap break-words rounded-md border border-destructive-border bg-destructive-surface px-3 py-2 text-destructive text-sm">
    {children}
  </p>
);

/**
 * Removes a worktree listed in the projects panel, which may not be open as a
 * project of its own, and optionally its branch.
 */
export const RemoveWorktreeDialog = ({
  onClose,
  project,
  worktree,
}: {
  onClose: () => void;
  /** The project whose panel lists the worktree. */
  project: ProjectConfig;
  worktree: ProjectGitWorktreeInfo;
}) => {
  const branchT = useTranslations("branches");
  const commonT = useTranslations("common");
  const worktreeT = useTranslations("worktrees");
  const forgetWorktree = useIdeStore((s) => s.forgetWorktree);
  const purgeWorktreeProject = useIdeStore((s) => s.purgeWorktreeProject);
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const { hostId } = project;
  const { branch } = worktree;

  const { loading: statusLoading, status } = useProjectGitStatus(
    worktree.path,
    {
      hostId,
    },
  );
  const dirtyCount = status?.fileCount ?? 0;

  const [alsoDeleteBranch, setAlsoDeleteBranch] = useState(false);
  const [discardUncommitted, setDiscardUncommitted] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The worktree went but its branch did not: nothing is left to retry here.
  const [worktreeRemoved, setWorktreeRemoved] = useState(false);

  const branchPreview = useBranchDeletePreview({
    branchName: branch ?? "",
    enabled: alsoDeleteBranch && branch !== null,
    hostId,
    projectPath: project.path,
    removingWorktreePath: worktree.path,
  });
  const preview = branchPreview.preview;
  const blockedReason = alsoDeleteBranch
    ? (preview?.blockedReason ?? null)
    : null;
  const canRemove =
    !statusLoading &&
    (dirtyCount === 0 || discardUncommitted) &&
    (!alsoDeleteBranch || (preview !== null && blockedReason === null));

  const handleRemove = async () => {
    setWorking(true);
    setError(null);
    try {
      const result = await forgetWorktree({
        branch,
        confirmedBranchHead: alsoDeleteBranch
          ? confirmedHeadFor(preview)
          : null,
        deleteBranch: alsoDeleteBranch,
        force: discardUncommitted,
        hostId,
        mainWorktreePath: project.path,
        worktreePath: worktree.path,
      });
      purgeWorktreeProject(worktree.path, { hostId });
      if (result.branchDeleteError) {
        setWorktreeRemoved(true);
        setError(
          worktreeT("branchDeleteFailed", {
            branch: branch ?? "",
            error: result.branchDeleteError,
          }),
        );
      } else {
        onClose();
      }
    } catch (failure) {
      setError(getApiErrorMessage(failure, worktreeT("unableToRemove")));
    } finally {
      bumpProjectGitRefreshKey(project.id);
      setWorking(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !working) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{worktreeT("removeWorktree")}</DialogTitle>
          <DialogDescription>
            {worktreeT.rich("removeDescription", {
              name: branch ?? worktree.path,
              strong: (chunks) => (
                <span className="break-all font-medium text-foreground">
                  {chunks}
                </span>
              ),
            })}
          </DialogDescription>
        </DialogHeader>

        {worktreeRemoved ? null : (
          <div className="min-w-0 space-y-3">
            {dirtyCount > 0 ? (
              <div className="space-y-1.5">
                <InfoLine tone="warning">
                  {worktreeT("uncommittedChanges", { count: dirtyCount })}
                </InfoLine>
                <label
                  className="flex cursor-pointer items-center gap-2 text-xs"
                  htmlFor="remove-worktree-discard"
                >
                  <Checkbox
                    checked={discardUncommitted}
                    id="remove-worktree-discard"
                    onCheckedChange={(checked) =>
                      setDiscardUncommitted(checked === true)
                    }
                  />
                  <span>{worktreeT("discardUncommitted")}</span>
                </label>
                {discardUncommitted ? (
                  <InfoLine tone="warning">
                    {worktreeT("discardWarning")}
                  </InfoLine>
                ) : null}
              </div>
            ) : null}

            {branch ? (
              <div className="space-y-1.5">
                <label
                  className="flex cursor-pointer items-center gap-2 text-xs"
                  htmlFor="remove-worktree-delete-branch"
                >
                  <Checkbox
                    checked={alsoDeleteBranch}
                    id="remove-worktree-delete-branch"
                    onCheckedChange={(checked) =>
                      setAlsoDeleteBranch(checked === true)
                    }
                  />
                  <span className="min-w-0 break-all">
                    {worktreeT("alsoDeleteBranch", { branch })}
                  </span>
                </label>
                {alsoDeleteBranch && branchPreview.loading ? (
                  <Spinner className="size-4 text-muted-foreground" />
                ) : null}
                {alsoDeleteBranch && branchPreview.error ? (
                  <ErrorMessage>{branchPreview.error}</ErrorMessage>
                ) : null}
                {blockedReason ? (
                  <InfoLine tone="warning">
                    {branchT(branchDeleteBlockedKey(blockedReason))}
                  </InfoLine>
                ) : null}
                {alsoDeleteBranch && preview ? (
                  <BranchDeleteSummary preview={preview} />
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {error ? <ErrorMessage>{error}</ErrorMessage> : null}

        <DialogFooter>
          <Button
            disabled={working}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            {worktreeRemoved ? commonT("close") : commonT("cancel")}
          </Button>
          {worktreeRemoved ? null : (
            <Button
              disabled={!canRemove || working}
              onClick={() => void handleRemove()}
              type="button"
              variant="destructive"
            >
              {working ? (
                <>
                  <Spinner className="size-4" />
                  {worktreeT("removing")}
                </>
              ) : alsoDeleteBranch ? (
                worktreeT("removeWorktreeAndBranch")
              ) : (
                worktreeT("removeWorktree")
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
