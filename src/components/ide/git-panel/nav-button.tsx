import { useTranslations } from "next-intl";
import { memo } from "react";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import { getStatusFileCount } from "../git-actions/utils";
import { useIdeStore } from "../ide-store";
import { usePullRequestContext } from "../pull-requests/api";
import { useShortcutTitle } from "../shortcuts/shortcut-keys";
import { SourceControlIcon } from "../source-control-icon";
import { WorkspaceNavButton } from "../workspace/nav-button";

const GitNavButtonImpl = ({
  active,
  onClick,
  projectId,
  projectPath,
  visible,
}: {
  /** Whether the Git panel is the one shown. */
  active: boolean;
  onClick: () => void;
  projectId: string;
  projectPath: string;
  /** Whether the project's workspace is on screen. */
  visible: boolean;
}) => {
  const gitT = useTranslations("git");
  const title = useShortcutTitle("showGit", gitT("title"));
  const projectHostId = useIdeStore((s) =>
    getProjectHostId(s.projects.find((item) => item.id === projectId)),
  );
  const { isRepo, status } = useProjectGitStatus(projectPath, {
    active: visible,
    detail: "summary",
    hostId: projectHostId,
  });
  const { data } = usePullRequestContext(
    projectPath,
    visible && isRepo,
    projectHostId,
  );
  const hasOpenPullRequest = data?.current?.state === "open";

  // Not a repository, or not known to be one yet.
  if (!isRepo) {
    return null;
  }

  return (
    <WorkspaceNavButton
      aria-label={gitT("title")}
      accent={getStatusFileCount(status) > 0 || hasOpenPullRequest}
      active={active}
      onClick={onClick}
      title={title}
    >
      <SourceControlIcon className="size-4" />
    </WorkspaceNavButton>
  );
};

export const GitNavButton = memo(GitNavButtonImpl);
GitNavButton.displayName = "GitNavButton";
