import {
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  UploadCloud,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type {
  ProjectGitPushPreviewResponse,
  ProjectGitPushResponse,
  ProjectGitStatusResponse,
} from "@/types/ide";
import { formatCommitDate } from "./branch-utils";
import { ActionError, DialogMetricRow, GitDialogHeader } from "./dialog-layout";
import { hasPushableCommits, postJson, readResponseText } from "./utils";

export const PushDialog = ({
  branch,
  onCompleted,
  onOpenChange,
  open,
  projectPath,
  status,
}: {
  branch: string | null;
  onCompleted: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectPath: string;
  status: ProjectGitStatusResponse | null;
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProjectGitPushPreviewResponse | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const canPush = hasPushableCommits(status);

  useEffect(() => {
    if (!open) {
      return;
    }

    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const controller = new AbortController();
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);

    void (async () => {
      try {
        const response = await fetch("/api/project-git-push-preview", {
          body: JSON.stringify({ projectPath }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readResponseText(response));
        }

        const payload =
          (await response.json()) as ProjectGitPushPreviewResponse;
        if (!controller.signal.aborted) {
          setPreview(payload);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        if (!controller.signal.aborted) {
          setPreviewError(
            error instanceof Error
              ? error.message
              : "Unable to preview commits.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setPreviewLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [open, projectPath]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting || !canPush) {
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        await postJson<ProjectGitPushResponse>("/api/project-git-push", {
          commitMessage: null,
          includeUnstaged: true,
          nextStep: "push",
          projectPath,
        });
        onCompleted();
        onOpenChange(false);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "Unable to push changes.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [canPush, onCompleted, onOpenChange, projectPath, submitting],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-2xl">
        <GitDialogHeader icon={<UploadCloud />} title="Push changes" />

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <DialogMetricRow
              icon={<GitBranch className="size-4" />}
              label="Branch"
              value={
                <span className="text-foreground">{branch ?? "Unknown"}</span>
              }
            />
            <DialogMetricRow
              icon={<GitFork className="size-4" />}
              label="Destination"
              value={
                previewLoading ? (
                  <span>Loading...</span>
                ) : preview?.target ? (
                  <span className="font-mono text-foreground">
                    {preview.target}
                  </span>
                ) : (
                  <span>
                    {status?.upstreamBranch ?? status?.remoteName ?? "-"}
                  </span>
                )
              }
            />
            <DialogMetricRow
              icon={<GitCommitHorizontal className="size-4" />}
              label="Commits"
              value={
                previewLoading ? (
                  <span>Loading...</span>
                ) : preview ? (
                  <span className="text-foreground">
                    {preview.totalCommits}
                    {preview.behindCount > 0 ? (
                      <span className="text-muted-foreground">
                        {" "}
                        ahead, {preview.behindCount} behind
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span>{status?.aheadCount ?? 0}</span>
                )
              }
            />
          </div>

          {preview && preview.commits.length > 0 ? (
            <div className="max-h-64 overflow-auto rounded-md border border-foreground/10 bg-muted/20">
              <div className="divide-y divide-foreground/10">
                {preview.commits.map((commit) => (
                  <div
                    className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 text-sm"
                    key={commit.hash || commit.shortHash}
                  >
                    <span className="font-mono text-muted-foreground text-xs">
                      {commit.shortHash}
                    </span>
                    <span className="min-w-0 truncate text-foreground">
                      {commit.subject || "(no subject)"}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {formatCommitDate(commit.authorDate)}
                    </span>
                  </div>
                ))}
                {preview.truncated ? (
                  <div className="px-3 py-2 text-muted-foreground text-xs">
                    Showing first {preview.commits.length} of{" "}
                    {preview.totalCommits} commits.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {previewError ? (
            <div className="text-destructive text-sm">{previewError}</div>
          ) : null}

          <ActionError error={error} />

          <div className="flex justify-end">
            <Button
              className="min-w-36"
              disabled={submitting || !canPush}
              type="submit"
            >
              {submitting ? <Spinner className="size-4" /> : null}
              <span>Push</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
