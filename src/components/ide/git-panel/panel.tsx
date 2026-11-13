import { useTranslations } from "next-intl";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { cn } from "@/lib/utils";
import type { GitPanelTab, ProjectConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { DEFAULT_GIT_PANEL_TAB } from "../ide-types";
import { RightPanelExpandButton } from "../right-panel-expand-button";
import { RightPanelHeaderIconButton } from "../right-panel-header-icon-button";
import { SourceControlIcon } from "../source-control-icon";
import { GitChanges } from "./changes";
import { GitPanelHeaderSlotContext } from "./header-actions";
import { GitLog } from "./log";

// The pull request view brings Markdown and diff rendering; it loads the
// first time its tab is shown.
const PullRequestView = lazy(() =>
  import("../pull-requests/panel").then((module) => ({
    default: module.PullRequestView,
  })),
);

const GIT_PANEL_TABS: readonly GitPanelTab[] = [
  "changes",
  "log",
  "pull-request",
];

const isGitPanelTab = (value: unknown): value is GitPanelTab =>
  GIT_PANEL_TABS.includes(value as GitPanelTab);

const TabLoadingFallback = () => (
  <div className="flex h-full items-center justify-center">
    <Spinner className="size-4 text-muted-foreground" />
  </div>
);

/**
 * The Git right-panel view: the working tree's changes with the commit
 * composer, the branch's log and its pull request, as tabs under one header. A tab
 * mounts the first time it is shown and stays mounted, so the log keeps its
 * loaded pages and search.
 */
export const GitPanel = ({
  active,
  expanded = false,
  onClosePanel,
  onToggleExpanded,
  project,
}: {
  active: boolean;
  expanded?: boolean;
  onClosePanel: () => void;
  onToggleExpanded?: () => void;
  project: ProjectConfig;
}) => {
  const commonT = useTranslations("common");
  const gitT = useTranslations("git");
  const projectId = project.id;
  const tab = useIdeStore(
    (s) => s.projectGitPanelTabByProject[projectId] ?? DEFAULT_GIT_PANEL_TAB,
  );
  const setProjectGitPanelTab = useIdeStore((s) => s.setProjectGitPanelTab);
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [visitedTabs, setVisitedTabs] = useState(
    () => new Set<GitPanelTab>([tab]),
  );

  useEffect(() => {
    setVisitedTabs((visited) =>
      visited.has(tab) ? visited : new Set([...visited, tab]),
    );
  }, [tab]);

  // Commits, pushes and branch switches made outside the app move nothing
  // here, so showing the panel, or another of its tabs, reads git again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Showing another tab reads git again.
  useEffect(() => {
    if (active) {
      bumpProjectGitRefreshKey(projectId);
    }
  }, [active, bumpProjectGitRefreshKey, projectId, tab]);

  const handleTabChange = useCallback(
    (value: unknown) => {
      if (isGitPanelTab(value)) {
        setProjectGitPanelTab(projectId, value);
      }
    },
    [projectId, setProjectGitPanelTab],
  );

  const renderTab = (value: GitPanelTab) => {
    const tabActive = active && tab === value;
    if (value === "changes") {
      return <GitChanges active={tabActive} projectId={projectId} />;
    }
    if (value === "log") {
      return (
        <GitLog
          active={tabActive}
          hostId={project.hostId ?? LOCAL_HOST_ID}
          projectPath={project.path}
        />
      );
    }
    return (
      <Suspense fallback={<TabLoadingFallback />}>
        <PullRequestView active={tabActive} project={project} />
      </Suspense>
    );
  };

  return (
    <GitPanelHeaderSlotContext.Provider value={headerSlot}>
      <Tabs
        className="h-full min-h-0 gap-0"
        onValueChange={handleTabChange}
        value={tab}
      >
        <div className="flex min-h-[50px] shrink-0 items-center gap-2 border-b border-surface-200 bg-surface-50 px-3 py-2 dark:border-surface-800 dark:bg-surface-900">
          <RightPanelHeaderIconButton
            icon={SourceControlIcon}
            onClose={onClosePanel}
          />
          <span className="mr-2 shrink-0 whitespace-nowrap font-medium text-sm">
            {gitT("title")}
          </span>
          <TabsList aria-label={gitT("views")} className="min-w-0">
            <TabsTrigger value="changes">{commonT("changes")}</TabsTrigger>
            <TabsTrigger value="log">{gitT("log")}</TabsTrigger>
            <TabsTrigger value="pull-request">
              {gitT("pullRequest")}
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <div className="contents" ref={setHeaderSlot} />
            {onToggleExpanded ? (
              <RightPanelExpandButton
                expanded={expanded}
                onToggle={onToggleExpanded}
              />
            ) : null}
          </div>
        </div>
        <div className="relative min-h-0 flex-1" data-right-panel-body>
          {GIT_PANEL_TABS.map((value) =>
            visitedTabs.has(value) ? (
              <TabsContent
                className={cn(
                  // Text inherits, as in the other right-panel views.
                  "absolute inset-0 min-h-0 text-[length:inherit]",
                  tab !== value && "hidden",
                )}
                keepMounted
                key={value}
                value={value}
              >
                {renderTab(value)}
              </TabsContent>
            ) : null,
          )}
        </div>
      </Tabs>
    </GitPanelHeaderSlotContext.Provider>
  );
};
