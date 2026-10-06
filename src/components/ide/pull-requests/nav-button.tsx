import { GitPullRequest } from "lucide-react";
import { WorkspaceNavButton } from "../workspace/nav-button";
import { usePullRequestContext } from "./api";

export function PullRequestNavButton({
  projectPath,
  active,
  visible = true,
  onClick,
}: {
  projectPath: string;
  active: boolean;
  visible?: boolean;
  onClick: () => void;
}) {
  const { data, error } = usePullRequestContext(projectPath, visible);
  const pr = data?.current;
  const label = pr
    ? `PR #${pr.number} · ${pr.draft ? "Draft" : pr.state} · ${pr.title}`
    : error
      ? "Pull request · GitHub unavailable"
      : "Pull request";
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
