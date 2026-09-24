import { GitPullRequest } from "lucide-react";
import { useIdeStore } from "../ide-store";
import { WorkspaceNavButton } from "../workspace/nav-button";
import { usePullRequestContext } from "./api";

export function PullRequestNavButton({
  projectId,
  projectPath,
  active,
  visible = true,
  onClick,
}: {
  projectId: string;
  projectPath: string;
  active: boolean;
  visible?: boolean;
  onClick: () => void;
}) {
  const refreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[projectId] ?? 0,
  );
  const { data, error } = usePullRequestContext(
    projectPath,
    refreshKey,
    visible,
  );
  const pr = data?.current;
  const label = pr
    ? `PR #${pr.number} · ${pr.draft ? "Draft" : pr.state} · ${pr.title}`
    : error
      ? "Pull requests · GitHub unavailable"
      : "Pull requests";
  return (
    <WorkspaceNavButton
      active={active}
      accent={Boolean(pr)}
      title={label}
      onClick={onClick}
    >
      <GitPullRequest className="size-4" />
    </WorkspaceNavButton>
  );
}
