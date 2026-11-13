import { useTranslations } from "next-intl";
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
import { getApiErrorMessage } from "@/lib/api-client";
import type { ProjectConfig, ProjectGitWorktreeInfo } from "@/types/ide";
import {
  BranchDeleteSummary,
  branchDeleteBlockedKey,
} from "./branch-delete-summary";
import { InfoLine } from "./info-line";
import { useWorktreeFinish } from "./worktree-finish";

const ErrorMessage = ({ children }: { children: string }) => (
  <p className="min-w-0 whitespace-pre-wrap break-words rounded-md border border-destructive-border bg-destructive-surface px-3 py-2 text-destructive text-sm">
    {children}
  </p>
);

/**
 * Removes a worktree listed in the projects panel, which may not be open as a
 * project of its own, and optionally its branch. The app forgets the
 * worktree as soon as git has removed it (worktree-finish.ts).
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
  const { branch } = worktree;
  const { finish, snapshot } = useWorktreeFinish({
    branch,
    hostId: project.hostId,
    mainWorktreePath: project.path,
    path: worktree.path,
  });
  const {
    branchBlocked,
    branchPreview,
    canRemove,
    deleteBranch,
    discardUncommitted,
    phase,
    removal,
    uncommittedCount,
  } = snapshot;
  const working = phase === "working";
  // The worktree went but its branch did not: nothing is left to retry here.
  const worktreeRemoved = removal?.ok === true;
  const error = !removal
    ? null
    : removal.ok
      ? removal.result.branchDeleteError
        ? worktreeT("branchDeleteFailed", {
            branch: branch ?? "",
            error: removal.result.branchDeleteError,
          })
        : null
      : getApiErrorMessage(removal.error, worktreeT("unableToRemove"));

  const handleRemove = async () => {
    if (!(await finish.remove())) return;
    // Git removed it: the app forgets it now. The dialog stays open only to
    // say the branch could not go with it.
    finish.finish();
    const outcome = finish.getSnapshot().removal;
    if (outcome?.ok && !outcome.result.branchDeleteError) onClose();
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
            {uncommittedCount > 0 ? (
              <div className="space-y-1.5">
                <InfoLine tone="warning">
                  {worktreeT("uncommittedChanges", { count: uncommittedCount })}
                </InfoLine>
                <label
                  className="flex cursor-pointer items-center gap-2 text-xs"
                  htmlFor="remove-worktree-discard"
                >
                  <Checkbox
                    checked={discardUncommitted}
                    id="remove-worktree-discard"
                    onCheckedChange={(checked) =>
                      finish.setDiscardUncommitted(checked === true)
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
                    checked={deleteBranch}
                    id="remove-worktree-delete-branch"
                    onCheckedChange={(checked) =>
                      finish.setDeleteBranch(checked === true)
                    }
                  />
                  <span className="min-w-0 break-all">
                    {worktreeT("alsoDeleteBranch", { branch })}
                  </span>
                </label>
                {deleteBranch && branchPreview.loading ? (
                  <Spinner className="size-4 text-muted-foreground" />
                ) : null}
                {deleteBranch && branchPreview.error ? (
                  <ErrorMessage>{branchPreview.error}</ErrorMessage>
                ) : null}
                {branchBlocked ? (
                  <InfoLine tone="warning">
                    {branchT(branchDeleteBlockedKey(branchBlocked))}
                  </InfoLine>
                ) : null}
                {deleteBranch && branchPreview.preview ? (
                  <BranchDeleteSummary preview={branchPreview.preview} />
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
              ) : deleteBranch ? (
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
