import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Where a branch stands against the remote branch it tracks. */
export interface TaskDeliveryStatus {
  aheadCount: number;
  behindCount: number;
  branch: string;
  branchExists: boolean;
  /** `null` when it cannot be known, e.g. the branch tracks no remote. */
  pushed: boolean | null;
  upstream: string | null;
  pullRequest?: { url: string; state: "open" | "closed" | "merged" } | null;
}

/**
 * Reads whether a task's work has reached the remote. Merging a task is local,
 * so "done" and "pushed" are separate facts, and the Tasks workspace reports
 * the second one. It deliberately offers no way to push: a task's buttons act
 * on the task, and a push moves a whole branch.
 */
export const useTaskDelivery = ({
  branch,
  commit,
  enabled = true,
  projectPath,
  refreshKey = "",
  taskBranch = null,
}: {
  branch: string | null;
  /** The commit the task landed as; `null` judges the whole branch. */
  commit: string | null;
  enabled?: boolean;
  projectPath: string | null;
  refreshKey?: string;
  taskBranch?: string | null;
}): TaskDeliveryStatus | null => {
  const [status, setStatus] = useState<TaskDeliveryStatus | null>(null);

  useEffect(() => {
    if (!enabled || !branch || !projectPath) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    let requestId = 0;
    const readDelivery = async (deliveryBranch: string, lookupPr: boolean) => {
      const response = await fetch("/api/project-git-task-delivery", {
        body: JSON.stringify({
          branch: deliveryBranch,
          commit,
          projectPath,
          taskBranch: lookupPr ? taskBranch : null,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      return response.ok
        ? ((await response.json()) as TaskDeliveryStatus)
        : null;
    };
    const refresh = async () => {
      const id = ++requestId;
      const [baseDelivery, branchDelivery] = await Promise.all([
        readDelivery(branch, true).catch(() => null),
        // The same commit may have been published on the task branch for a PR
        // while the local base branch remains ahead of its own upstream.
        // Verify the commit itself, not just whether the task branch is in sync.
        taskBranch && taskBranch !== branch && commit
          ? readDelivery(taskBranch, false).catch(() => null)
          : null,
      ]);
      const next =
        baseDelivery?.pushed !== true && branchDelivery?.pushed === true
          ? { ...branchDelivery, pullRequest: baseDelivery?.pullRequest }
          : baseDelivery;
      if (!cancelled && id === requestId) {
        setStatus(next);
      }
    };
    void refreshKey;
    setStatus(null);
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [branch, commit, enabled, projectPath, refreshKey, taskBranch]);

  return status;
};

const useDeliveryStateText = (status: TaskDeliveryStatus) => {
  const t = useTranslations("tasks");
  return status.upstream === null
    ? t("deliveryNoUpstream", { branch: status.branch })
    : status.aheadCount === 0 && status.behindCount === 0
      ? t("deliveryInSync", {
          branch: status.branch,
          upstream: status.upstream,
        })
      : t("deliveryState", {
          ahead: status.aheadCount,
          behind: status.behindCount,
          branch: status.branch,
          upstream: status.upstream,
        });
};

/** "master is 4 ahead, 2 behind origin/master". */
export const TaskDeliveryLine = ({
  className,
  status,
}: {
  className?: string;
  status: TaskDeliveryStatus;
}) => (
  <div className={cn("text-muted-foreground text-xs", className)}>
    {useDeliveryStateText(status)}
  </div>
);

/**
 * On a finished card: whether the merged work has reached the remote. "Done"
 * only means merged locally, so an unpushed task says so.
 */
export const TaskDeliveryBadge = ({
  status,
}: {
  status: TaskDeliveryStatus;
}) => {
  const t = useTranslations("tasks");
  const stateText = useDeliveryStateText(status);
  return (
    <div
      className={cn(
        "mt-2 truncate text-xs",
        status.pushed
          ? "text-muted-foreground"
          : "text-amber-600 dark:text-amber-400",
      )}
      title={stateText}
    >
      {status.pushed ? t("deliveryPushed") : t("deliveryNotPushed")}
    </div>
  );
};
