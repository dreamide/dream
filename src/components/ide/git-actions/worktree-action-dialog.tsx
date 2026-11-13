import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderTree,
  FolderX,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Home,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import { getDefaultGitGenerationModelSelection } from "@/lib/ide-defaults";
import { cn } from "@/lib/utils";
import type {
  ProjectConfig,
  ProjectGitDiffResponse,
  ProjectGitStatusEntry,
  ProjectWorktreeInfo,
} from "@/types/ide";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import {
  DIFF_RENDER_CHANGED_LINE_LIMIT,
  IdeDiffViewer,
  LargeDiffGuard,
} from "../diff-viewer";
import { useIdeStore } from "../ide-store";
import { MaterialFileIcon } from "../material-file-icon";
import {
  BranchDeleteSummary,
  branchDeleteBlockedKey,
} from "./branch-delete-summary";
import { CommitDialog } from "./commit-dialog";
import { ActionError, DialogMetricRow, GitDialogHeader } from "./dialog-layout";
import { InfoLine } from "./info-line";
import { GitChangesDeltaSummary } from "./summary";
import {
  useWorktreeFinish,
  type WorktreeMergeBlock,
  type WorktreeMerged,
} from "./worktree-finish";

type WorktreeProject = ProjectConfig & { worktree: ProjectWorktreeInfo };
/** Which worktree action the dialog performs. */
export type WorktreeDialogAction = "merge" | "remove";
type DiffState = {
  diff: ProjectGitDiffResponse | null;
  error: string | null;
  loading: boolean;
};

const MAX_DIRTY_FILES_SHOWN = 8;

const CompareFileRow = ({
  baseRef,
  change,
  hostId,
  projectPath,
}: {
  baseRef: string | null;
  change: ProjectGitStatusEntry;
  /** The worktree's host (absent: the local host). */
  hostId?: string;
  projectPath: string;
}) => {
  const worktreeT = useTranslations("worktrees");
  const [expanded, setExpanded] = useState(false);
  const [forceRender, setForceRender] = useState(false);
  const [diffState, setDiffState] = useState<DiffState>({
    diff: null,
    error: null,
    loading: false,
  });

  useEffect(() => {
    if (!expanded || diffState.diff || diffState.loading || diffState.error) {
      return;
    }

    let cancelled = false;
    setDiffState({ diff: null, error: null, loading: true });
    void (async () => {
      try {
        const diff = await apiClient.gitWorktreeCompareDiff(
          {
            baseRef,
            filePath: change.path,
            previousPath: change.previousPath,
            projectPath,
            status: change.status,
          },
          { hostId: getProjectHostId({ hostId }) },
        );
        if (!cancelled) {
          setDiffState({ diff, error: null, loading: false });
        }
      } catch (error) {
        if (!cancelled) {
          setDiffState({
            diff: null,
            error: getApiErrorMessage(error, worktreeT("unableToLoadDiff")),
            loading: false,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [baseRef, change, diffState, expanded, hostId, projectPath, worktreeT]);

  const changedLineCount = change.addedLines + change.removedLines;
  const diffTooLarge =
    changedLineCount > DIFF_RENDER_CHANGED_LINE_LIMIT && !forceRender;

  return (
    <div className="border-surface-200 border-b last:border-b-0 dark:border-surface-800">
      <button
        aria-expanded={expanded}
        className="flex h-10 w-full items-center gap-2 px-3 text-left text-sm hover:bg-surface-100 dark:hover:bg-surface-800"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <MaterialFileIcon className="size-4 shrink-0" path={change.path} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {change.path}
        </span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
          <span className="font-medium text-emerald-600">
            +{change.addedLines}
          </span>
          <span className="font-medium text-rose-600">
            -{change.removedLines}
          </span>
        </span>
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
          {expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </span>
      </button>
      {expanded ? (
        <div className="border-surface-200 border-t bg-background text-xs dark:border-surface-800">
          {diffState.loading || (!diffState.diff && !diffState.error) ? (
            <div className="flex items-center gap-2 px-4 py-3 text-muted-foreground">
              <Spinner className="size-4" />
            </div>
          ) : diffState.error ? (
            <div className="px-4 py-3">
              <ActionError error={diffState.error} />
            </div>
          ) : diffState.diff ? (
            <div className="overflow-x-hidden">
              {change.previousPath ? (
                <div className="border-surface-200 border-b px-4 py-2 text-muted-foreground dark:border-surface-800">
                  {`${change.previousPath} -> ${change.path}`}
                </div>
              ) : null}
              {diffTooLarge ? (
                <LargeDiffGuard
                  changedLineCount={changedLineCount}
                  onRenderAnyway={() => setForceRender(true)}
                />
              ) : diffState.diff.parsedDiff ? (
                <IdeDiffViewer
                  changedLineCount={changedLineCount}
                  className="min-w-0"
                  diffStyle="unified"
                  fileDiff={diffState.diff.parsedDiff}
                  largeDiffGuardEnabled={false}
                  wordWrap
                />
              ) : (
                <pre className="whitespace-pre-wrap break-words p-4 font-mono">
                  {diffState.diff.diff}
                </pre>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const MergeResultLine = ({ result }: { result: WorktreeMerged }) => {
  const worktreeT = useTranslations("worktrees");
  return (
    <div className="flex items-start gap-2">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
      <div className="space-y-1">
        <div>
          {result.fastForward
            ? worktreeT("mergedFastForward", {
                base: result.baseBranch,
                branch: result.branch,
              })
            : worktreeT("mergedWithCommit", {
                base: result.baseBranch,
                branch: result.branch,
                hash: result.mergeCommit.slice(0, 7),
              })}
        </div>
        {result.previousMainBranch !== result.baseBranch ? (
          <div className="text-muted-foreground text-xs">
            {worktreeT("mainNowOn", { base: result.baseBranch })}
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** Why the branch cannot be merged now, in words. */
const useMergeBlockText = (block: WorktreeMergeBlock | null) => {
  const commonT = useTranslations("common");
  const worktreeT = useTranslations("worktrees");
  if (!block) return null;
  switch (block.kind) {
    case "nothingToMerge":
      return worktreeT("nothingToMerge", { base: block.base });
    case "unrelatedHistories":
      return worktreeT("unrelatedHistories", { base: block.base });
    case "mainOperationInProgress":
      return worktreeT("mainOperationInProgress");
    case "mainWorktreeDirty":
      return worktreeT("mainWorktreeDirty", {
        branch: block.branch ?? commonT("unknown"),
        count: block.count,
      });
  }
};

/**
 * Merges a worktree's branch into its base branch in the main checkout, or
 * removes the worktree. Opened from the Git actions menu of a worktree
 * project. The flow is worktree-finish.ts's; this shows it, and forgets the
 * worktree only as the dialog closes, after showing the outcome.
 */
export const WorktreeActionDialog = ({
  action,
  onOpenChange,
  open,
  project,
}: {
  action: WorktreeDialogAction;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  project: WorktreeProject;
}) => {
  const branchT = useTranslations("branches");
  const commonT = useTranslations("common");
  const gitT = useTranslations("git");
  const worktreeT = useTranslations("worktrees");
  const format = useFormatter();
  const settings = useIdeStore((s) => s.settings);
  const { model, modelSpeed, provider, reasoningEffort } = useMemo(
    () => getDefaultGitGenerationModelSelection(settings),
    [settings],
  );

  const { finish, snapshot } = useWorktreeFinish(
    {
      baseRef: project.worktree.baseRef,
      branch: project.worktree.branch,
      hostId: project.hostId,
      mainWorktreePath: project.worktree.mainWorktreePath,
      path: project.path,
      projectId: project.id,
    },
    { open },
  );
  const {
    branchBlocked,
    branchPreview,
    canMerge,
    canRemove,
    compare,
    compareError,
    compareLoading,
    deleteBranch: alsoDeleteBranch,
    discardUncommitted,
    merged: mergeResult,
    mergeFailure,
    phase,
    removal,
    uncommitted: dirtyChanges,
    uncommittedCount: dirtyCount,
    unmergedCommits,
  } = snapshot;
  const mergeDisabledReason = useMergeBlockText(snapshot.mergeBlock);
  const isDirty = dirtyCount > 0;
  const cleanupResult = removal?.ok ? removal.result : null;
  const cleanupError =
    removal && !removal.ok
      ? getApiErrorMessage(removal.error, worktreeT("unableToRemove"))
      : null;
  const error = !mergeFailure
    ? null
    : mergeFailure.kind === "conflict"
      ? worktreeT("mergeConflict", { base: mergeFailure.baseBranch })
      : getApiErrorMessage(mergeFailure.error, worktreeT("unableToMerge"));
  const conflictingFiles =
    mergeFailure?.kind === "conflict" ? mergeFailure.files : [];
  const compareErrorText = compareError
    ? getApiErrorMessage(compareError, worktreeT("unableToCompare"))
    : null;

  // Closing after a removal is when the app forgets the worktree.
  const close = useCallback(() => {
    onOpenChange(false);
    finish.finish();
  }, [finish, onOpenChange]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        onOpenChange(true);
        return;
      }
      if (phase === "working") {
        return;
      }
      close();
    },
    [close, onOpenChange, phase],
  );

  if (phase === "commit") {
    return (
      <CommitDialog
        branch={project.worktree.branch}
        model={model}
        modelSpeed={modelSpeed}
        onCompleted={() => finish.commitCompleted()}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            finish.endCommit();
          }
        }}
        open
        projectId={project.id}
        projectPath={project.path}
        provider={provider}
        reasoningEffort={reasoningEffort}
        status={snapshot.status}
      />
    );
  }

  const isMerge = action === "merge";
  const primaryDisabled = isMerge ? !canMerge : !canRemove;
  const baseBranch = compare?.baseBranch ?? null;
  const mergeLabel = baseBranch
    ? worktreeT("mergeInto", { base: baseBranch })
    : worktreeT("merge");
  // A merge under way, or a removal (on its own or after a merge).
  const workingLabel =
    isMerge && !mergeResult
      ? worktreeT("merging", { base: baseBranch ?? "" })
      : worktreeT("removingWorktree");

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent
        className={cn(
          "flex max-h-[85vh] flex-col gap-5",
          isMerge ? "sm:max-w-2xl" : "sm:max-w-lg",
        )}
      >
        <GitDialogHeader
          icon={isMerge ? <GitMerge /> : <FolderX />}
          subtitle={
            isMerge && baseBranch
              ? `${project.worktree.branch} -> ${baseBranch}`
              : project.worktree.branch
          }
          title={isMerge ? mergeLabel : worktreeT("removeWorktree")}
        />

        {phase === "working" ? (
          <div className="flex items-center gap-3 py-6 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            <span>{workingLabel}</span>
          </div>
        ) : phase === "merged" && mergeResult ? (
          <div className="space-y-4">
            <div className="space-y-2 rounded-md border border-surface-200 bg-surface-50 px-3 py-3 text-sm dark:border-surface-800 dark:bg-surface-900">
              <MergeResultLine result={mergeResult} />
            </div>
            {isDirty ? (
              <InfoLine>{worktreeT("uncommittedStay")}</InfoLine>
            ) : (
              <p className="text-muted-foreground text-sm">
                {worktreeT("removeAfterMergeDescription", {
                  branch: mergeResult.branch,
                })}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={close} type="button" variant="ghost">
                {worktreeT("keepWorktree")}
              </Button>
              {isDirty ? null : (
                <Button
                  onClick={() => void finish.removeAfterMerge()}
                  type="button"
                  variant="destructive"
                >
                  {worktreeT("removeWorktreeAndBranch")}
                </Button>
              )}
            </div>
          </div>
        ) : phase === "done" ? (
          <div className="space-y-4">
            <div className="space-y-2 rounded-md border border-surface-200 bg-surface-50 px-3 py-3 text-sm dark:border-surface-800 dark:bg-surface-900">
              {mergeResult ? <MergeResultLine result={mergeResult} /> : null}
              {cleanupResult ? (
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  <div className="space-y-1">
                    <div>{worktreeT("worktreeRemoved")}</div>
                    {cleanupResult.branch ? (
                      <div className="text-muted-foreground text-xs">
                        {cleanupResult.branchDeleted
                          ? worktreeT("branchDeleted", {
                              branch: cleanupResult.branch,
                            })
                          : cleanupResult.branchDeleteError
                            ? worktreeT("branchDeleteFailed", {
                                branch: cleanupResult.branch,
                                error: cleanupResult.branchDeleteError,
                              })
                            : worktreeT("branchKept", {
                                branch: cleanupResult.branch,
                              })}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : cleanupError ? (
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="space-y-2">
                    <div>{worktreeT("cleanupFailed")}</div>
                    <div className="text-destructive text-xs">
                      {cleanupError}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex justify-end gap-2">
              {cleanupError ? (
                <>
                  <Button
                    onClick={() => handleOpenChange(false)}
                    type="button"
                    variant="ghost"
                  >
                    {commonT("close")}
                  </Button>
                  <Button
                    onClick={() => void finish.retryRemoval()}
                    type="button"
                  >
                    {worktreeT("retryRemoval")}
                  </Button>
                </>
              ) : (
                <Button onClick={close} type="button">
                  {worktreeT("done")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-5">
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
              {!isMerge ? (
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-sm">
                    {worktreeT("removeWorktreeSummary")}
                  </p>
                  <label
                    className="flex cursor-pointer items-center gap-2 pt-1 text-xs"
                    htmlFor="worktree-action-delete-branch"
                  >
                    <Checkbox
                      checked={alsoDeleteBranch}
                      id="worktree-action-delete-branch"
                      onCheckedChange={(checked) =>
                        finish.setDeleteBranch(checked === true)
                      }
                    />
                    <span className="min-w-0 break-all">
                      {worktreeT("alsoDeleteBranch", {
                        branch: project.worktree.branch,
                      })}
                    </span>
                  </label>
                  {alsoDeleteBranch && branchPreview.loading ? (
                    <Spinner className="size-4 text-muted-foreground" />
                  ) : null}
                  {alsoDeleteBranch && branchPreview.error ? (
                    <ActionError error={branchPreview.error} />
                  ) : null}
                  {branchBlocked ? (
                    <InfoLine tone="warning">
                      {branchT(branchDeleteBlockedKey(branchBlocked))}
                    </InfoLine>
                  ) : null}
                  {alsoDeleteBranch && branchPreview.preview ? (
                    <BranchDeleteSummary preview={branchPreview.preview} />
                  ) : null}
                  {!alsoDeleteBranch && compare && unmergedCommits > 0 ? (
                    <InfoLine>
                      {worktreeT("unmergedCommitsKept", {
                        base: compare.baseBranch,
                        branch: project.worktree.branch,
                        count: unmergedCommits,
                      })}
                    </InfoLine>
                  ) : null}
                </div>
              ) : null}

              {compareLoading && !compare ? (
                <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
                  <Spinner className="size-4" />
                </div>
              ) : null}
              {compareErrorText ? (
                <ActionError error={compareErrorText} />
              ) : null}

              {isMerge && compare ? (
                <>
                  <div className="space-y-2">
                    <DialogMetricRow
                      icon={<GitBranch className="size-4" />}
                      label={worktreeT("baseBranch")}
                      value={
                        <span className="text-foreground">
                          {compare.baseBranch}
                        </span>
                      }
                    />
                    <DialogMetricRow
                      icon={<GitCommitHorizontal className="size-4" />}
                      label={gitT("commits")}
                      value={
                        <span className="text-foreground">
                          {worktreeT("commitsAheadBehind", {
                            ahead: compare.aheadCount,
                            behind: compare.behindCount,
                          })}
                        </span>
                      }
                    />
                    <DialogMetricRow
                      icon={<FolderTree className="size-4" />}
                      label={commonT("files")}
                      value={<GitChangesDeltaSummary changes={compare.files} />}
                    />
                    <DialogMetricRow
                      icon={<Home className="size-4" />}
                      label={worktreeT("mainCheckout")}
                      value={
                        <span className="text-foreground">
                          {compare.mainBranch ?? commonT("unknown")}
                          <span
                            className={cn(
                              "ml-2",
                              compare.mainClean
                                ? "text-muted-foreground"
                                : "text-amber-600 dark:text-amber-400",
                            )}
                          >
                            {compare.mainClean
                              ? worktreeT("clean")
                              : worktreeT("dirtyFiles", {
                                  count: compare.mainDirtyCount,
                                })}
                          </span>
                        </span>
                      }
                    />
                  </div>

                  <div className="space-y-1.5">
                    {compare.mainBranch !== compare.baseBranch ? (
                      <InfoLine>
                        {worktreeT("mainWillSwitch", {
                          from: compare.mainBranch ?? commonT("unknown"),
                          to: compare.baseBranch,
                        })}
                      </InfoLine>
                    ) : null}
                    {!compare.baseExistsLocally ? (
                      <InfoLine>
                        {worktreeT("baseNotLocal", {
                          base: compare.baseBranch,
                        })}
                      </InfoLine>
                    ) : null}
                    {compare.behindCount > 0 ? (
                      <InfoLine>
                        {worktreeT("behindBase", {
                          base: compare.baseBranch,
                          count: compare.behindCount,
                        })}
                      </InfoLine>
                    ) : null}
                  </div>

                  {compare.commits.length > 0 ? (
                    <div className="overflow-hidden rounded-md border border-surface-200 bg-surface-50 dark:border-surface-800 dark:bg-surface-900">
                      <div className="max-h-[10rem] divide-y divide-surface-200 overflow-y-auto dark:divide-surface-800">
                        {compare.commits.map((commit) => (
                          <div
                            className="grid h-9 grid-cols-[auto_1fr_auto] items-center gap-3 px-3 text-sm"
                            key={commit.hash || commit.shortHash}
                          >
                            <span className="font-mono text-muted-foreground text-xs">
                              {commit.shortHash}
                            </span>
                            <span className="min-w-0 truncate text-foreground">
                              {commit.subject || gitT("noSubject")}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {Number.isNaN(
                                new Date(commit.authorDate).getTime(),
                              )
                                ? ""
                                : format.dateTime(new Date(commit.authorDate), {
                                    day: "numeric",
                                    month: "short",
                                  })}
                            </span>
                          </div>
                        ))}
                      </div>
                      {compare.truncated ? (
                        <div className="border-surface-200 border-t px-3 py-2 text-muted-foreground text-xs dark:border-surface-800">
                          {gitT("showingCommits", {
                            shown: compare.commits.length,
                            total: compare.totalCommits,
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {compare.files.length > 0 ? (
                    <div className="overflow-hidden rounded-md border border-surface-200 bg-surface-50 dark:border-surface-800 dark:bg-surface-900">
                      <div className="max-h-[18rem] overflow-y-auto">
                        {compare.files.map((change) => (
                          <CompareFileRow
                            baseRef={project.worktree.baseRef}
                            change={change}
                            hostId={project.hostId}
                            key={`${change.status}:${change.path}`}
                            projectPath={project.path}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}

              {isDirty ? (
                <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="font-medium">
                        {worktreeT("uncommittedChanges", {
                          count: dirtyCount,
                        })}
                      </div>
                      <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
                        {dirtyChanges
                          .slice(0, MAX_DIRTY_FILES_SHOWN)
                          .map((change) => (
                            <li className="truncate" key={change.path}>
                              {change.path}
                            </li>
                          ))}
                        {dirtyChanges.length > MAX_DIRTY_FILES_SHOWN ? (
                          <li>
                            {worktreeT("andMoreFiles", {
                              count:
                                dirtyChanges.length - MAX_DIRTY_FILES_SHOWN,
                            })}
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    {isMerge ? (
                      <InfoLine>{worktreeT("uncommittedStay")}</InfoLine>
                    ) : (
                      <label
                        className="flex cursor-pointer items-center gap-2 text-xs"
                        htmlFor="worktree-action-discard"
                      >
                        <Checkbox
                          checked={discardUncommitted}
                          id="worktree-action-discard"
                          onCheckedChange={(checked) =>
                            finish.setDiscardUncommitted(checked === true)
                          }
                        />
                        <span>{worktreeT("discardUncommitted")}</span>
                      </label>
                    )}
                    <Button
                      className="h-7 px-2 text-xs"
                      onClick={() => finish.startCommit()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <GitCommitHorizontal className="size-3.5" />
                      {worktreeT("commitChangesFirst")}
                    </Button>
                  </div>
                  {!isMerge && discardUncommitted ? (
                    <InfoLine tone="warning">
                      {worktreeT("discardWarning")}
                    </InfoLine>
                  ) : null}
                </div>
              ) : null}

              {isMerge && mergeDisabledReason ? (
                <InfoLine tone="warning">{mergeDisabledReason}</InfoLine>
              ) : null}

              {conflictingFiles.length > 0 ? (
                <div className="space-y-2 rounded-md border border-destructive-border bg-destructive-surface-muted px-3 py-2 text-sm">
                  <div className="text-destructive">{error}</div>
                  <div className="font-medium text-xs">
                    {worktreeT("conflictingFiles")}
                  </div>
                  <ul className="space-y-0.5 font-mono text-xs">
                    {conflictingFiles.map((file) => (
                      <li className="truncate" key={file}>
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <ActionError error={error} />
              )}
            </div>

            <div className="flex shrink-0 justify-end gap-2">
              <Button
                onClick={() => onOpenChange(false)}
                type="button"
                variant="ghost"
              >
                {commonT("cancel")}
              </Button>
              <Button
                className="min-w-36"
                disabled={primaryDisabled}
                onClick={() =>
                  void (isMerge ? finish.merge() : finish.remove())
                }
                type="button"
                variant={isMerge ? "default" : "destructive"}
              >
                {isMerge
                  ? mergeLabel
                  : alsoDeleteBranch
                    ? worktreeT("removeWorktreeAndBranch")
                    : worktreeT("removeWorktree")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
