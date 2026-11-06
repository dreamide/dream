import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import { getApiErrorMessage } from "@/lib/api-client";
import { useIdeStore } from "../ide-store";
import {
  BranchDeleteSummary,
  branchDeleteBlockedKey,
  confirmedHeadFor,
} from "./branch-delete-summary";
import { InfoLine } from "./info-line";

/**
 * Confirms deleting one branch, showing what would be lost with it. A branch
 * checked out in a linked worktree can only go with that worktree, so that is
 * what the dialog then offers.
 */
export const DeleteBranchDialog = ({
  branchName,
  hostId,
  onClose,
  onDelete,
  projectId,
  projectPath,
}: {
  branchName: string;
  hostId?: string;
  onClose: () => void;
  /** Answers once the branch is gone; throws a displayable error if not. */
  onDelete: (branchName: string, confirmedHead: string | null) => Promise<void>;
  projectId: string;
  projectPath: string;
}) => {
  const branchT = useTranslations("branches");
  const commonT = useTranslations("common");
  const worktreeT = useTranslations("worktrees");
  const forgetWorktree = useIdeStore((s) => s.forgetWorktree);
  const purgeWorktreeProject = useIdeStore((s) => s.purgeWorktreeProject);
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const {
    error: previewError,
    loading,
    preview,
  } = useBranchDeletePreview({
    branchName,
    enabled: true,
    hostId,
    projectPath,
  });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The worktree went but its branch did not: nothing is left to retry here.
  const [worktreeRemoved, setWorktreeRemoved] = useState(false);

  const worktreePath = preview?.checkedOutAt ?? null;
  const blockedReason = preview?.blockedReason ?? null;
  const canDelete =
    preview !== null && blockedReason === null && !worktreeRemoved;
  const confirmedHead = confirmedHeadFor(preview);

  const removeWorktreeAndBranch = async (path: string) => {
    const result = await forgetWorktree({
      branch: branchName,
      confirmedBranchHead: confirmedHead,
      deleteBranch: true,
      hostId,
      mainWorktreePath: projectPath,
      worktreePath: path,
    });
    purgeWorktreeProject(path, { hostId });
    bumpProjectGitRefreshKey(projectId);
    if (result.branchDeleteError) {
      setWorktreeRemoved(true);
      setError(
        worktreeT("branchDeleteFailed", {
          branch: branchName,
          error: result.branchDeleteError,
        }),
      );
      return false;
    }
    return true;
  };

  const handleConfirm = async () => {
    setWorking(true);
    setError(null);
    try {
      if (worktreePath) {
        if (await removeWorktreeAndBranch(worktreePath)) {
          onClose();
        }
      } else {
        await onDelete(branchName, confirmedHead);
        onClose();
      }
    } catch (failure) {
      setError(
        getApiErrorMessage(
          failure,
          worktreePath
            ? worktreeT("unableToRemove")
            : branchT("unableToDeleteBranch"),
        ),
      );
    } finally {
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
          <DialogTitle>{branchT("deleteBranch")}</DialogTitle>
          <DialogDescription>
            {branchT.rich("deleteBranchDescription", {
              name: branchName,
              strong: (chunks) => (
                <span className="break-all font-medium text-foreground">
                  {chunks}
                </span>
              ),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          {loading ? (
            <Spinner className="size-4 text-muted-foreground" />
          ) : null}
          {blockedReason ? (
            <InfoLine tone="warning">
              {branchT(branchDeleteBlockedKey(blockedReason))}
            </InfoLine>
          ) : null}
          {worktreePath && !blockedReason && !worktreeRemoved ? (
            <InfoLine tone="warning">
              <span className="break-all">
                {branchT("branchInWorktree", { path: worktreePath })}
              </span>
            </InfoLine>
          ) : null}
          {preview && !worktreeRemoved ? (
            <BranchDeleteSummary preview={preview} />
          ) : null}
          {previewError || error ? (
            <p className="min-w-0 whitespace-pre-wrap break-words rounded-md border border-destructive-border bg-destructive-surface px-3 py-2 text-destructive text-sm">
              {previewError ?? error}
            </p>
          ) : null}
        </div>

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
              disabled={!canDelete || working}
              onClick={() => void handleConfirm()}
              type="button"
              variant="destructive"
            >
              {working ? <Spinner className="size-4" /> : null}
              {worktreePath
                ? worktreeT("removeWorktreeAndBranch")
                : preview && preview.unmergedCount !== 0
                  ? branchT("deleteAnyway")
                  : branchT("deleteBranch")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
