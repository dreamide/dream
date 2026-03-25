import { ArrowLeft, ArrowRight, Plus, RotateCw, X } from "lucide-react";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import { FileExplorerPanel } from "./file-explorer-panel";
import { AppShellPlaceholder } from "./ide-helpers";
import { useIdeStore } from "./ide-store";

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
      <div className="flex items-end bg-muted/50 pl-1.5 pt-1.5">
        <div className="flex items-end gap-0.5 overflow-x-auto pb-0.5">
          {tabs.map((tab) => {
            const tabLoading = previewLoading[tab.id] ?? false;
            const isActive = tab.id === activeTab?.id;

            return (
              <div
                className={cn(
                  "group flex max-w-[180px] min-w-[90px] shrink-0 items-center gap-1 rounded-t-md pr-1",
                  isActive
                    ? "bg-background text-foreground"
                    : "bg-transparent text-muted-foreground hover:bg-muted/60",
                )}
                key={tab.id}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-1 px-3 py-1.5 text-xs font-medium"
                  onClick={() => handleActivateTab(tab.id)}
                  type="button"
                >
                  {tabLoading ? (
                    <Spinner className="size-3 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="min-w-0 truncate">
                    {tab.title || "New Tab"}
                  </span>
                </button>
                {tabs.length > 1 ? (
                  <button
                    className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                    onClick={() => handleCloseTab(tab.id)}
                    type="button"
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  className="mb-0.5 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={handleAddTab}
                  type="button"
                />
              }
            >
              <Plus className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>New tab</TooltipContent>
          </Tooltip>
        </div>
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

export const PreviewPanel = (props: PreviewPanelProps) => {
  const rightPanelView = useIdeStore((state) => state.rightPanelView);

  if (rightPanelView === "explorer") {
    return <FileExplorerPanel />;
  }

  return <PreviewViewport {...props} />;
};
