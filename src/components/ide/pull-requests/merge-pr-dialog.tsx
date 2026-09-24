import { GitBranch, GitCommitHorizontal, GitMerge } from "lucide-react";
import { useEffect, useState } from "react";
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
import { NextStepSelector } from "../git-actions/dialog-layout";
import { type PullRequestSummary, prRequest } from "./api";

type MergeMethod = "merge" | "squash" | "rebase";
type MergeInfo = PullRequestSummary & {
  head: string;
  base: string;
  canMerge: boolean;
  methods: MergeMethod[];
};

export function MergePrDialog({
  projectPath,
  repository,
  number,
  onClose,
  onMerged,
}: {
  projectPath: string;
  repository: string;
  number: number;
  onClose: () => void;
  onMerged: () => void;
}) {
  const [info, setInfo] = useState<MergeInfo | null>(null);
  const [method, setMethod] = useState<MergeMethod>("merge");
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads merge details after an error.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setInfo(null);
    setError(null);
    prRequest<MergeInfo>(
      projectPath,
      { action: "mergeInfo", repository, number },
      true,
    )
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setMethod(data.methods[0] ?? "merge");
      })
      .catch((error) => {
        if (!cancelled)
          setError(
            error instanceof Error
              ? error.message
              : "Unable to load merge details.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, repository, number, revision]);

  const blocked =
    info &&
    (info.state !== "open"
      ? "This pull request is no longer open."
      : info.draft
        ? "Mark this pull request ready before merging."
        : !info.canMerge
          ? "You do not have permission to merge this pull request."
          : !info.methods.length
            ? "No merge methods are enabled for this repository."
            : null);
  const merge = async () => {
    if (!info?.commit || loading || merging || blocked) return;
    setMerging(true);
    setError(null);
    try {
      await prRequest(projectPath, {
        action: "merge",
        repository,
        number,
        commit: info.commit,
        mergeMethod: method,
      });
      onMerged();
      onClose();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to merge this PR.",
      );
    } finally {
      setMerging(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !merging) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <GitMerge className="size-4" />
            Merge PR #{number}
          </DialogTitle>
          <DialogDescription>
            {info?.title ?? "Merge this pull request into its target branch."}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex min-h-24 items-center justify-center">
            <Spinner />
          </div>
        ) : info ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="break-all">
                {info.head} → {info.base}
              </span>
            </div>
            <NextStepSelector<MergeMethod>
              idPrefix="merge-pr-method"
              value={method}
              onValueChange={setMethod}
              options={[
                {
                  value: "merge",
                  label: "Create a merge commit",
                  icon: <GitMerge />,
                },
                {
                  value: "squash",
                  label: "Squash and merge",
                  icon: <GitCommitHorizontal />,
                },
                {
                  value: "rebase",
                  label: "Rebase and merge",
                  icon: <GitBranch />,
                },
              ].map((option) => ({
                ...option,
                value: option.value as MergeMethod,
                disabled:
                  merging ||
                  !info.methods.includes(option.value as MergeMethod),
              }))}
            />
          </div>
        ) : null}
        {blocked || error ? (
          <p
            role="alert"
            className="text-xs text-destructive whitespace-pre-wrap"
          >
            {error ?? blocked}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            className="text-xs"
            size="sm"
            variant="ghost"
            disabled={merging}
            onClick={onClose}
          >
            Cancel
          </Button>
          {error ? (
            <Button
              className="text-xs"
              size="sm"
              variant="outline"
              disabled={loading || merging}
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh
            </Button>
          ) : null}
          <Button
            className="text-xs"
            size="sm"
            disabled={loading || merging || !info?.commit || Boolean(blocked)}
            onClick={merge}
          >
            {merging ? (
              <Spinner className="size-3.5" />
            ) : (
              <GitMerge className="size-3.5" />
            )}
            {merging ? "Merging…" : "Merge PR"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
