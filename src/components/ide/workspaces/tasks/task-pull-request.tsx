import { GitPullRequest } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TaskPullRequest } from "./task-delivery";

// GitHub's own colours for each state, so the badge reads at a glance.
const PULL_REQUEST_STATES = {
  closed: {
    className:
      "border-destructive-border bg-destructive-surface text-destructive",
    labelKey: "prStateClosed",
  },
  draft: {
    className: "border-border bg-muted text-muted-foreground",
    labelKey: "prStateDraft",
  },
  merged: {
    className:
      "border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-700 dark:bg-purple-950 dark:text-purple-400",
    labelKey: "prStateMerged",
  },
  open: {
    className:
      "border-success-border bg-success-surface text-success-foreground",
    labelKey: "prStateOpen",
  },
} as const;

/**
 * A task's pull request on GitHub: "PR #12" with its state as a
 * badge when `gh` could say what became of it, and a plain "PR" link
 * when only the stored URL is known (no `gh`, no network, or no match for the
 * branch).
 */
export const TaskPullRequestRow = ({
  onOpen,
  pullRequest,
  url,
}: {
  onOpen: (url: string) => void;
  pullRequest: TaskPullRequest | null;
  url: string;
}) => {
  const t = useTranslations("tasks");
  // A draft is still open, but "Draft" is what the author needs to know.
  const state = pullRequest
    ? PULL_REQUEST_STATES[
        pullRequest.state === "open" && pullRequest.isDraft
          ? "draft"
          : pullRequest.state
      ]
    : null;

  return (
    <button
      className="group mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
      onClick={() => onOpen(url)}
      type="button"
    >
      <GitPullRequest className="size-4 shrink-0" />
      <span className="truncate group-hover:underline">
        {pullRequest ? `PR #${pullRequest.number}` : "PR"}
      </span>
      {state ? (
        <Badge
          className={cn("h-4 px-1.5 text-[10px]", state.className)}
          variant="outline"
        >
          {t(state.labelKey)}
        </Badge>
      ) : null}
    </button>
  );
};
