import { ArrowDown, File, GitCommitHorizontal, GitFork } from "lucide-react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import type { ProjectGitPullResponse } from "@/types/ide";
import { MaterialFileIcon } from "../material-file-icon";
import { GitCommitList } from "./commit-list";
import { DialogMetricRow, GitDialogHeader } from "./dialog-layout";
import { GitChangesDeltaSummary } from "./summary";

/**
 * What a finished pull brought in: its commits and the files they changed
 * with line counts, the summary `git pull` prints in a terminal.
 */
export const PullDialog = ({
  onOpenChange,
  open,
  result,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** The pull to show, kept after close so the closing dialog keeps it. */
  result: ProjectGitPullResponse | null;
}) => {
  const commonT = useTranslations("common");
  const gitT = useTranslations("git");
  const commits = result?.commits ?? [];
  const files = result?.files ?? [];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-5 overflow-hidden sm:max-w-2xl">
        <GitDialogHeader icon={<ArrowDown />} title={gitT("pulledChanges")} />

        {/* Short windows scroll the summary; the header and Close stay put. */}
        <div className="min-h-0 space-y-5 overflow-y-auto">
          {result ? (
            <>
              <div className="space-y-2">
                <DialogMetricRow
                  icon={<GitFork className="size-4" />}
                  label={gitT("source")}
                  value={
                    <span className="text-foreground">
                      {result.upstreamBranch}
                    </span>
                  }
                />
                <DialogMetricRow
                  icon={<GitCommitHorizontal className="size-4" />}
                  label={gitT("commits")}
                  value={
                    <span className="text-foreground">
                      {result.commitCount}
                    </span>
                  }
                />
                <DialogMetricRow
                  icon={<File className="size-4" />}
                  label={commonT("files")}
                  value={
                    <div className="flex justify-end">
                      <GitChangesDeltaSummary changes={files} />
                    </div>
                  }
                />
              </div>

              <GitCommitList
                commits={commits}
                totalCommits={result.commitCount}
                truncated={result.truncated ?? false}
              />

              {files.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-surface-200 bg-surface-50 dark:border-surface-800 dark:bg-surface-900">
                  <div className="max-h-[18rem] divide-y divide-surface-200 overflow-y-auto dark:divide-surface-800">
                    {files.map((file) => (
                      <div
                        className="flex h-10 items-center gap-2 px-3 text-sm"
                        key={`${file.status}:${file.path}`}
                      >
                        <MaterialFileIcon
                          className="size-4 shrink-0"
                          path={file.path}
                        />
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-xs"
                          title={
                            file.previousPath
                              ? `${file.previousPath} → ${file.path}`
                              : file.path
                          }
                        >
                          {file.path}
                        </span>
                        <span className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
                          <span className="font-medium text-emerald-600">
                            +{file.addedLines}
                          </span>
                          <span className="font-medium text-rose-600">
                            -{file.removedLines}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
};
