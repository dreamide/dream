import {
  ArrowLeft,
  ArrowRight,
  Folder,
  GitCompareArrows,
  Monitor,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import {
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import { ChangesPanel } from "./changes-panel";
import { FileExplorerPanel } from "./file-explorer-panel";
import { AppShellPlaceholder } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { type StandardTabItem, StandardTabs } from "./standard-tabs";

export interface PreviewPanelProps {
  onSyncPreviewBounds: (reload?: boolean) => void;
  previewHostRef: RefObject<HTMLDivElement | null>;
}

const normalizePreviewUrlInput = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
};

const getPreviewTabTitle = (url: string) => {
  try {
    return new URL(url).hostname || "New Tab";
  } catch {
    return url.replace(/^https?:\/\//i, "").split("/")[0] || "New Tab";
  }
};

const PreviewViewport = ({
  onSyncPreviewBounds,
  previewHostRef,
}: PreviewPanelProps) => {
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewUrlDraft, setPreviewUrlDraft] = useState("");

  const activeProject = useIdeStore((state) => state.getActiveProject());
  const previewError = useIdeStore((state) => state.previewError);
  const previewLoading = useIdeStore((state) => state.previewLoading);
  const previewTabsByProject = useIdeStore(
    (state) => state.previewTabsByProject,
  );
  const activePreviewTabIdByProject = useIdeStore(
    (state) => state.activePreviewTabIdByProject,
  );
  const setPreviewError = useIdeStore((state) => state.setPreviewError);
  const updateProject = useIdeStore((state) => state.updateProject);
  const ensurePreviewTabs = useIdeStore((state) => state.ensurePreviewTabs);
  const createPreviewTab = useIdeStore((state) => state.createPreviewTab);
  const updatePreviewTab = useIdeStore((state) => state.updatePreviewTab);
  const closePreviewTab = useIdeStore((state) => state.closePreviewTab);
  const reorderPreviewTabs = useIdeStore((state) => state.reorderPreviewTabs);
  const setActivePreviewTab = useIdeStore((state) => state.setActivePreviewTab);

  const activeProjectId = activeProject?.id ?? null;
  const tabs = useMemo(
    () =>
      activeProjectId ? (previewTabsByProject[activeProjectId] ?? []) : [],
    [activeProjectId, previewTabsByProject],
  );
  const activeTabId = activeProjectId
    ? (activePreviewTabIdByProject[activeProjectId] ?? tabs[0]?.id ?? null)
    : null;
  const activeTab =
    tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  const isPreviewLoading = activeTab
    ? (previewLoading[activeTab.id] ?? false)
    : false;
  const previewVisible = Boolean(activeProject && activeTab?.url);
  const previewTabItems = useMemo<StandardTabItem[]>(
    () =>
      tabs.map((tab) => {
        const tabLoading = previewLoading[tab.id] ?? false;

        return {
          id: tab.id,
          label: tab.title || "New Tab",
          leading: tabLoading ? (
            <Spinner className="size-3 shrink-0 text-muted-foreground" />
          ) : null,
        };
      }),
    [previewLoading, tabs],
  );

  useEffect(() => {
    if (!activeProject) {
      return;
    }

    ensurePreviewTabs(activeProject.id, activeProject.previewUrl);
  }, [activeProject, ensurePreviewTabs]);

  useEffect(() => {
    if (!activeProjectId || !tabs.length || activeTabId) {
      return;
    }

    setActivePreviewTab(activeProjectId, tabs[0].id);
  }, [activeProjectId, activeTabId, setActivePreviewTab, tabs]);

  useEffect(() => {
    setPreviewUrlDraft(activeTab?.url ?? "");
  }, [activeTab?.url]);

  const syncAfterStateChange = useCallback(
    (reload = false) => {
      requestAnimationFrame(() => {
        onSyncPreviewBounds(reload);
      });
    },
    [onSyncPreviewBounds],
  );

  const handleActivateTab = useCallback(
    (tabId: string) => {
      if (!activeProjectId) {
        return;
      }

      const nextTab = tabs.find((tab) => tab.id === tabId) ?? null;
      setActivePreviewTab(activeProjectId, tabId);
      setPreviewUrlDraft(nextTab?.url ?? "");
      setPreviewError(null);

      updateProject(activeProjectId, (project) => ({
        ...project,
        previewUrl: nextTab?.url ?? "",
      }));

      syncAfterStateChange();
    },
    [
      activeProjectId,
      setActivePreviewTab,
      setPreviewError,
      syncAfterStateChange,
      tabs,
      updateProject,
    ],
  );

  const handleReorderTab = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!activeProjectId) {
        return;
      }

      reorderPreviewTabs(activeProjectId, fromIndex, toIndex);
      syncAfterStateChange();
    },
    [activeProjectId, reorderPreviewTabs, syncAfterStateChange],
  );

  const handleAddTab = useCallback(() => {
    if (!activeProjectId) {
      return;
    }

    createPreviewTab(activeProjectId);
    setPreviewError(null);
    setPreviewUrlDraft("");
    updateProject(activeProjectId, (project) => ({
      ...project,
      previewUrl: "",
    }));
    syncAfterStateChange();
  }, [
    activeProjectId,
    createPreviewTab,
    setPreviewError,
    syncAfterStateChange,
    updateProject,
  ]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      if (!activeProjectId) {
        return;
      }

      const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
      const remainingTabs = tabs.filter((tab) => tab.id !== tabId);
      const fallbackTab =
        activeTabId === tabId
          ? (remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)] ??
            null)
          : activeTab;

      getDesktopApi()?.updatePreview({ destroyTab: tabId });
      closePreviewTab(activeProjectId, tabId);
      setPreviewError(null);
      setPreviewUrlDraft(fallbackTab?.url ?? "");

      updateProject(activeProjectId, (project) => ({
        ...project,
        previewUrl: fallbackTab?.url ?? "",
      }));

      syncAfterStateChange();
    },
    [
      activeProjectId,
      activeTab,
      activeTabId,
      closePreviewTab,
      setPreviewError,
      syncAfterStateChange,
      tabs,
      updateProject,
    ],
  );

  const handleNavigate = useCallback(() => {
    if (!activeProjectId || !activeTab) {
      return;
    }

    const nextUrl = normalizePreviewUrlInput(previewUrlDraft);
    if (!nextUrl) {
      return;
    }

    setPreviewError(null);
    updatePreviewTab(activeProjectId, activeTab.id, (tab) => ({
      ...tab,
      title: getPreviewTabTitle(nextUrl),
      url: nextUrl,
    }));
    updateProject(activeProjectId, (project) => ({
      ...project,
      previewUrl: nextUrl,
    }));
    setPreviewUrlDraft(nextUrl);
    syncAfterStateChange(true);
  }, [
    activeProjectId,
    activeTab,
    previewUrlDraft,
    setPreviewError,
    syncAfterStateChange,
    updatePreviewTab,
    updateProject,
  ]);

  const handleRefresh = useCallback(() => {
    if (!activeProjectId || !activeTab) {
      return;
    }

    if (isPreviewLoading) {
      getDesktopApi()?.updatePreview({
        projectId: activeProjectId,
        stop: true,
        tabId: activeTab.id,
      });
      return;
    }

    setPreviewError(null);
    syncAfterStateChange(true);
  }, [
    activeProjectId,
    activeTab,
    isPreviewLoading,
    setPreviewError,
    syncAfterStateChange,
  ]);

  const handleGoBack = useCallback(() => {
    if (!activeProjectId || !activeTab?.canGoBack) {
      return;
    }

    setPreviewError(null);
    getDesktopApi()?.updatePreview({
      goBack: true,
      projectId: activeProjectId,
      tabId: activeTab.id,
    });
  }, [activeProjectId, activeTab, setPreviewError]);

  const handleGoForward = useCallback(() => {
    if (!activeProjectId || !activeTab?.canGoForward) {
      return;
    }

    setPreviewError(null);
    getDesktopApi()?.updatePreview({
      goForward: true,
      projectId: activeProjectId,
      tabId: activeTab.id,
    });
  }, [activeProjectId, activeTab, setPreviewError]);

  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container) {
      return;
    }

    const sync = () => onSyncPreviewBounds();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    const frame = window.requestAnimationFrame(sync);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [onSyncPreviewBounds]);

  return (
    <div
      id="preview-panel"
      className="flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md"
    >
      <div className="flex items-end bg-muted/50 px-1.5 py-1.5">
        <StandardTabs
          activeId={activeTab?.id ?? null}
          after={
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label="New tab"
                    className="mb-px flex h-8 w-8 shrink-0 items-center justify-center rounded-lg p-0 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                    onClick={handleAddTab}
                    type="button"
                  />
                }
              >
                <Plus className="size-4" />
              </TooltipTrigger>
              <TooltipContent>New tab</TooltipContent>
            </Tooltip>
          }
          ariaLabel="Preview tabs"
          canClose={tabs.length > 1}
          closeAriaLabel={(tab) => `Close ${tab.label.toLowerCase()}`}
          className="flex-1"
          items={previewTabItems}
          onActivate={handleActivateTab}
          onClose={handleCloseTab}
          onReorder={handleReorderTab}
        />
      </div>

      <div className="flex items-center gap-0.5 border-b border-foreground/10 px-1.5 py-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                className={cn(
                  "rounded p-1 transition-colors",
                  activeTab?.canGoBack
                    ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                    : "text-muted-foreground/40",
                )}
                disabled={!activeTab?.canGoBack}
                onClick={handleGoBack}
                type="button"
              />
            }
          >
            <ArrowLeft className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Go back</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                className={cn(
                  "rounded p-1 transition-colors",
                  activeTab?.canGoForward
                    ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                    : "text-muted-foreground/40",
                )}
                disabled={!activeTab?.canGoForward}
                onClick={handleGoForward}
                type="button"
              />
            }
          >
            <ArrowRight className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Go forward</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                className={cn(
                  "rounded p-1 transition-colors",
                  activeProject
                    ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                    : "text-muted-foreground/40",
                )}
                disabled={!activeProject || !activeTab}
                onClick={handleRefresh}
                type="button"
              />
            }
          >
            {isPreviewLoading ? (
              <X className="size-4" />
            ) : (
              <RotateCw className="size-4" />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {isPreviewLoading ? "Stop loading" : "Refresh preview"}
          </TooltipContent>
        </Tooltip>

        <div className="relative mx-1.5 flex-1">
          <Input
            className="h-7 rounded-full border-transparent bg-muted/40 px-3 text-xs focus:border-foreground/20"
            disabled={!activeProject || !activeTab}
            onChange={(event) => {
              setPreviewUrlDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !activeProject || !activeTab) {
                return;
              }

              event.preventDefault();
              handleNavigate();
            }}
            placeholder="Enter URL..."
            value={previewUrlDraft}
          />
          {isPreviewLoading ? (
            <div className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2">
              <Spinner className="size-3.5 text-muted-foreground" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <div className="relative h-full" ref={previewContainerRef}>
          <div
            className="absolute top-px right-[2px] bottom-[2px] left-[2px]"
            ref={previewHostRef}
          />
          {!activeProject ? (
            <div className="absolute inset-0 p-3">
              <AppShellPlaceholder message="Add a project to start a live preview." />
            </div>
          ) : !previewVisible ? (
            <div className="absolute inset-0 p-3">
              <AppShellPlaceholder message="Enter a URL to show the live preview." />
            </div>
          ) : null}
          {previewError ? (
            <div className="pointer-events-none absolute right-3 bottom-3 left-3 rounded-md border border-destructive/20 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm">
              {previewError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const MemoizedPreviewViewport = memo(PreviewViewport);
MemoizedPreviewViewport.displayName = "PreviewViewport";

const RightPanelTabs = () => {
  const rightPanelView = useIdeStore((state) => state.rightPanelView);
  const setRightPanelView = useIdeStore((state) => state.setRightPanelView);

  const handleValueChange = useCallback(
    (value: string) => {
      if (value !== "preview" && value !== "explorer" && value !== "changes") {
        return;
      }

      setRightPanelView(value);
    },
    [setRightPanelView],
  );

  return (
    <div className="flex items-center border-b border-border/60 px-2 py-2">
      <Tabs onValueChange={handleValueChange} value={rightPanelView}>
        <TabsList className="h-8 bg-muted/60">
          <Tooltip>
            <TooltipTrigger
              render={
                <TabsTrigger
                  aria-label="Show changes"
                  className="h-6 w-8 px-0 data-[active]:bg-background"
                  value="changes"
                />
              }
            >
              <GitCompareArrows className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Changes</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <TabsTrigger
                  aria-label="Show file explorer"
                  className="h-6 w-8 px-0 data-[active]:bg-background"
                  value="explorer"
                />
              }
            >
              <Folder className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Files</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <TabsTrigger
                  aria-label="Show preview"
                  className="h-6 w-8 px-0 data-[active]:bg-background"
                  value="preview"
                />
              }
            >
              <Monitor className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Preview</TooltipContent>
          </Tooltip>
        </TabsList>
      </Tabs>
    </div>
  );
};

export const PreviewPanel = (props: PreviewPanelProps) => {
  const rightPanelView = useIdeStore((state) => state.rightPanelView);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <RightPanelTabs />
      <div
        className={cn(
          "min-h-0 flex-1",
          rightPanelView === "explorer" ? "" : "hidden",
        )}
      >
        <FileExplorerPanel />
      </div>
      <div
        className={cn(
          "min-h-0 flex-1",
          rightPanelView === "changes" ? "" : "hidden",
        )}
      >
        <ChangesPanel />
      </div>
      <div
        className={cn(
          "min-h-0 flex-1",
          rightPanelView === "preview" ? "" : "hidden",
        )}
      >
        <MemoizedPreviewViewport {...props} />
      </div>
    </div>
  );
};
