import { useFormatter, useTranslations } from "next-intl";
import type { ProjectGitPushPreviewCommit } from "@/types/ide";

/**
 * A git dialog's list of commits: short hash, subject and author date, with
 * a note when only the first of `totalCommits` are shown.
 */
export const GitCommitList = ({
  commits,
  totalCommits,
  truncated,
}: {
  commits: ProjectGitPushPreviewCommit[];
  totalCommits: number;
  truncated: boolean;
}) => {
  const format = useFormatter();
  const gitT = useTranslations("git");

  if (commits.length === 0) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-md border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900">
      <div className="max-h-[12.5rem] divide-y divide-surface-200 dark:divide-surface-800 overflow-y-auto">
        {commits.map((commit) => (
          <div
            className="grid h-10 grid-cols-[auto_1fr_auto] items-center gap-3 px-3 text-sm"
            key={commit.hash || commit.shortHash}
          >
            <span className="font-mono text-muted-foreground text-xs">
              {commit.shortHash}
            </span>
            <span className="min-w-0 truncate text-foreground">
              {commit.subject || gitT("noSubject")}
            </span>
            <span className="text-muted-foreground text-xs">
              {Number.isNaN(new Date(commit.authorDate).getTime())
                ? ""
                : format.dateTime(new Date(commit.authorDate), {
                    day: "numeric",
                    month: "short",
                  })}
            </span>
          </div>
        ))}
      </div>
      {truncated ? (
        <div className="border-surface-200 dark:border-surface-800 border-t px-3 py-2 text-muted-foreground text-xs">
          {gitT("showingCommits", {
            shown: commits.length,
            total: totalCommits,
          })}
        </div>
      ) : null}
    </div>
  );
};
