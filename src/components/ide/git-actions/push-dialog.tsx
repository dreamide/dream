import {
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  UploadCloud,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { apiClient, getApiErrorMessage, isAbortError } from "@/lib/api-client";
import type {
  ProjectGitPushPreviewResponse,
  ProjectGitStatusResponse,
} from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { GitCommitList } from "./commit-list";
import { ActionError, DialogMetricRow, GitDialogHeader } from "./dialog-layout";
import { hasPushableCommits } from "./utils";

export const PushDialog = ({
  branch,
  onOpenChange,
  open,
  projectId,
  projectPath,
  hostId,
  refreshToken,
  status,
}: {
  branch: string | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
  projectPath: string;
  hostId?: string;
  refreshToken: number;
  status: ProjectGitStatusResponse | null;
}) => {
  const commonT = useTranslations("common");
  const gitT = useTranslations("git");
  const gitBusy = useIdeStore((s) => s.gitWriteByProject[projectId] != null);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh the preview after any project git write.
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
        const payload = await apiClient.gitPushPreview(
          { projectPath },
          { hostId, signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setPreview(payload);
        }
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        if (!controller.signal.aborted) {
          setPreviewError(
            getApiErrorMessage(error, gitT("unableToPreviewCommits")),
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
  }, [gitT, hostId, open, projectPath, refreshToken]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting || gitBusy || previewLoading || !preview || !canPush) {
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        const outcome = await useIdeStore.getState().pushProject(projectId);
        if (outcome.ok) {
          toast.success(
            gitT("pushedTo", {
              target: outcome.result.upstreamBranch ?? outcome.result.branch,
            }),
          );
          onOpenChange(false);
        } else {
          setError(getApiErrorMessage(outcome.error, gitT("unableToPush")));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      canPush,
      gitBusy,
      gitT,
      onOpenChange,
      preview,
      previewLoading,
      projectId,
      submitting,
    ],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-2xl">
        <GitDialogHeader icon={<UploadCloud />} title={gitT("pushChanges")} />

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <DialogMetricRow
              icon={<GitBranch className="size-4" />}
              label={commonT("branch")}
              value={
                <span className="text-foreground">
                  {preview?.branch ?? branch ?? commonT("unknown")}
                </span>
              }
            />
            <DialogMetricRow
              icon={<GitFork className="size-4" />}
              label={gitT("destination")}
              value={
                previewLoading ? (
                  <Spinner className="size-4" />
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
              label={gitT("commits")}
              value={
                previewLoading ? (
                  <Spinner className="size-4" />
                ) : preview ? (
                  <span className="text-foreground">
                    {preview.totalCommits}
                    {preview.behindCount > 0 ? (
                      <span className="text-muted-foreground">
                        {" "}
                        {gitT("aheadAndBehind", {
                          ahead: preview.totalCommits,
                          behind: preview.behindCount,
                        })}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span>{status?.aheadCount ?? 0}</span>
                )
              }
            />
          </div>

          {preview ? (
            <GitCommitList
              commits={preview.commits}
              totalCommits={preview.totalCommits}
              truncated={preview.truncated}
            />
          ) : null}
          {previewError ? (
            <div className="text-destructive text-sm">{previewError}</div>
          ) : null}

          <ActionError error={error} />

          <div className="flex justify-end">
            <Button
              className="min-w-36"
              disabled={
                submitting || gitBusy || previewLoading || !preview || !canPush
              }
              type="submit"
            >
              {submitting ? <Spinner className="size-4" /> : null}
              <span>{gitT("push")}</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
