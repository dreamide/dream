import {
  ArrowLeft,
  ArrowRight,
  Folder,
  GitCompareArrows,
  Globe,
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
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import { ChangesPanel } from "./changes-panel";
import { FileExplorerPanel } from "./file-explorer-panel";
import { AppShellPlaceholder } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { type StandardTabItem, StandardTabs } from "./standard-tabs";

const RIGHT_PANEL_SURFACE_CLASSES =
  "overflow-hidden rounded-lg border border-foreground/20 bg-background text-foreground shadow-md";

export interface BrowserPanelProps {
  onSyncBrowserBounds: (reload?: boolean) => void;
  browserHostRef: RefObject<HTMLDivElement | null>;
}

const normalizeBrowserUrlInput = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
};

const getBrowserTabTitle = (url: string) => {
  try {
    return new URL(url).hostname || "New Tab";
  } catch {
    return url.replace(/^https?:\/\//i, "").split("/")[0] || "New Tab";
  }
};

const BrowserViewport = ({
  onSyncBrowserBounds,
  browserHostRef,
}: BrowserPanelProps) => {
  const browserContainerRef = useRef<HTMLDivElement | null>(null);
  const [browserUrlDraft, setBrowserUrlDraft] = useState("");

  const activeProject = useIdeStore((state) => state.getActiveProject());
  const browserError = useIdeStore((state) => state.browserError);
  const browserLoading = useIdeStore((state) => state.browserLoading);
  const browserTabsByProject = useIdeStore(
    (state) => state.browserTabsByProject,
  );
  const activeBrowserTabIdByProject = useIdeStore(
    (state) => state.activeBrowserTabIdByProject,
  );
  const setBrowserError = useIdeStore((state) => state.setBrowserError);
  const updateProject = useIdeStore((state) => state.updateProject);
  const ensureBrowserTabs = useIdeStore((state) => state.ensureBrowserTabs);
  const createBrowserTab = useIdeStore((state) => state.createBrowserTab);
  const updateBrowserTab = useIdeStore((state) => state.updateBrowserTab);
  const closeBrowserTab = useIdeStore((state) => state.closeBrowserTab);
  const reorderBrowserTabs = useIdeStore((state) => state.reorderBrowserTabs);
  const setActiveBrowserTab = useIdeStore((state) => state.setActiveBrowserTab);

  const activeProjectId = activeProject?.id ?? null;
  const tabs = useMemo(
    () =>
      activeProjectId ? (browserTabsByProject[activeProjectId] ?? []) : [],
    [activeProjectId, browserTabsByProject],
  );
  const activeTabId = activeProjectId
    ? (activeBrowserTabIdByProject[activeProjectId] ?? tabs[0]?.id ?? null)
    : null;
  const activeTab =
    tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  const isBrowserLoading = activeTab
    ? (browserLoading[activeTab.id] ?? false)
    : false;
  const browserVisible = Boolean(activeProject && activeTab?.url);
  const browserTabItems = useMemo<StandardTabItem[]>(
    () =>
      tabs.map((tab) => {
        const tabLoading = browserLoading[tab.id] ?? false;

        return {
          id: tab.id,
          label: tab.title || "New Tab",
          leading: tabLoading ? (
            <Spinner className="size-3 shrink-0 text-muted-foreground" />
          ) : null,
        };
      }),
    [browserLoading, tabs],
  );

  useEffect(() => {
    if (!activeProject) {
      return;
    }

    ensureBrowserTabs(activeProject.id, activeProject.browserUrl);
  }, [activeProject, ensureBrowserTabs]);

  useEffect(() => {
    if (!activeProjectId || !tabs.length || activeTabId) {
      return;
    }

    setActiveBrowserTab(activeProjectId, tabs[0].id);
  }, [activeProjectId, activeTabId, setActiveBrowserTab, tabs]);

  useEffect(() => {
    setBrowserUrlDraft(activeTab?.url ?? "");
  }, [activeTab?.url]);

  const syncAfterStateChange = useCallback(
    (reload = false) => {
      requestAnimationFrame(() => {
        onSyncBrowserBounds(reload);
      });
    },
    [onSyncBrowserBounds],
  );

  const handleActivateTab = useCallback(
    (tabId: string) => {
      if (!activeProjectId) {
        return;
      }

      const nextTab = tabs.find((tab) => tab.id === tabId) ?? null;
      setActiveBrowserTab(activeProjectId, tabId);
      setBrowserUrlDraft(nextTab?.url ?? "");
      setBrowserError(null);

      updateProject(activeProjectId, (project) => ({
        ...project,
        browserUrl: nextTab?.url ?? "",
      }));

      syncAfterStateChange();
    },
    [
      activeProjectId,
      setActiveBrowserTab,
      setBrowserError,
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

      reorderBrowserTabs(activeProjectId, fromIndex, toIndex);
      syncAfterStateChange();
    },
    [activeProjectId, reorderBrowserTabs, syncAfterStateChange],
  );

  const handleAddTab = useCallback(() => {
    if (!activeProjectId) {
      return;
    }

    createBrowserTab(activeProjectId);
    setBrowserError(null);
    setBrowserUrlDraft("");
    updateProject(activeProjectId, (project) => ({
      ...project,
      browserUrl: "",
    }));
    syncAfterStateChange();
  }, [
    activeProjectId,
    createBrowserTab,
    setBrowserError,
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

      getDesktopApi()?.updateBrowser({ destroyTab: tabId });
      closeBrowserTab(activeProjectId, tabId);
      setBrowserError(null);
      setBrowserUrlDraft(fallbackTab?.url ?? "");

      updateProject(activeProjectId, (project) => ({
        ...project,
        browserUrl: fallbackTab?.url ?? "",
      }));

      syncAfterStateChange();
    },
    [
      activeProjectId,
      activeTab,
      activeTabId,
      closeBrowserTab,
      setBrowserError,
      syncAfterStateChange,
      tabs,
      updateProject,
    ],
  );

  const handleNavigate = useCallback(() => {
    if (!activeProjectId || !activeTab) {
      return;
    }

    const nextUrl = normalizeBrowserUrlInput(browserUrlDraft);
    if (!nextUrl) {
      return;
    }

    setBrowserError(null);
    updateBrowserTab(activeProjectId, activeTab.id, (tab) => ({
      ...tab,
      title: getBrowserTabTitle(nextUrl),
      url: nextUrl,
    }));
    updateProject(activeProjectId, (project) => ({
      ...project,
      browserUrl: nextUrl,
    }));
    setBrowserUrlDraft(nextUrl);
    syncAfterStateChange(true);
  }, [
    activeProjectId,
    activeTab,
    browserUrlDraft,
    setBrowserError,
    syncAfterStateChange,
    updateBrowserTab,
    updateProject,
  ]);

  const handleRefresh = useCallback(() => {
    if (!activeProjectId || !activeTab) {
      return;
    }

    if (isBrowserLoading) {
      getDesktopApi()?.updateBrowser({
        projectId: activeProjectId,
        stop: true,
        tabId: activeTab.id,
      });
      return;
    }

    setBrowserError(null);
    syncAfterStateChange(true);
  }, [
    activeProjectId,
    activeTab,
    isBrowserLoading,
    setBrowserError,
    syncAfterStateChange,
  ]);

  const handleGoBack = useCallback(() => {
    if (!activeProjectId || !activeTab?.canGoBack) {
      return;
    }

    setBrowserError(null);
    getDesktopApi()?.updateBrowser({
      goBack: true,
      projectId: activeProjectId,
      tabId: activeTab.id,
    });
  }, [activeProjectId, activeTab, setBrowserError]);

  const handleGoForward = useCallback(() => {
    if (!activeProjectId || !activeTab?.canGoForward) {
      return;
    }

    setBrowserError(null);
    getDesktopApi()?.updateBrowser({
      goForward: true,
      projectId: activeProjectId,
      tabId: activeTab.id,
    });
  }, [activeProjectId, activeTab, setBrowserError]);

  useEffect(() => {
    const container = browserContainerRef.current;
    if (!container) {
      return;
    }

    const sync = () => onSyncBrowserBounds();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    const frame = window.requestAnimationFrame(sync);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [onSyncBrowserBounds]);

  return (
    <div id="browser-panel" className="flex h-full flex-col overflow-hidden">
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
          ariaLabel="Browser tabs"
          canClose={tabs.length > 1}
          closeAriaLabel={(tab) => `Close ${tab.label.toLowerCase()}`}
          className="flex-1"
          items={browserTabItems}
          onActivate={handleActivateTab}
          onClose={handleCloseTab}
          onReorder={handleReorderTab}
        />
      </div>

      <div className="flex items-center gap-0.5 border-b border-foreground/10 bg-muted/50 px-1.5 py-2">
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
            {isBrowserLoading ? (
              <X className="size-4" />
            ) : (
              <RotateCw className="size-4" />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {isBrowserLoading ? "Stop loading" : "Refresh browser"}
          </TooltipContent>
        </Tooltip>

        <div className="relative mx-1.5 flex-1">
          <Input
            className="h-7 rounded-full border-foreground/10 bg-background px-3 text-xs focus:border-foreground/20"
            disabled={!activeProject || !activeTab}
            onChange={(event) => {
              setBrowserUrlDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !activeProject || !activeTab) {
                return;
              }

              event.preventDefault();
              handleNavigate();
            }}
            placeholder="Enter URL..."
            value={browserUrlDraft}
          />
          {isBrowserLoading ? (
            <div className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2">
              <Spinner className="size-3.5 text-muted-foreground" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <div className="relative h-full" ref={browserContainerRef}>
          <div
            className="absolute top-px right-[2px] bottom-[2px] left-[2px]"
            ref={browserHostRef}
          />
          {!activeProject ? (
            <div className="absolute inset-0 p-3">
              <AppShellPlaceholder message="Add a project to start a live browser." />
            </div>
          ) : !browserVisible ? (
            <div className="absolute inset-0 p-3">
              <AppShellPlaceholder message="Enter a URL to show the live browser." />
            </div>
          ) : null}
          {browserError ? (
            <div className="pointer-events-none absolute right-3 bottom-3 left-3 rounded-md border border-destructive/20 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm">
              {browserError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const MemoizedBrowserViewport = memo(BrowserViewport);
MemoizedBrowserViewport.displayName = "BrowserViewport";

const RightPanelTabs = () => {
  const rightPanelView = useIdeStore((state) => state.rightPanelView);
  const setRightPanelView = useIdeStore((state) => state.setRightPanelView);

  const handleValueChange = useCallback(
    (value: string) => {
      if (value !== "browser" && value !== "explorer" && value !== "changes") {
        return;
      }

      setRightPanelView(value);
    },
    [setRightPanelView],
  );

  return (
    <div className="flex items-center px-2 pb-2">
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
                  aria-label="Show browser"
                  className="h-6 w-8 px-0 data-[active]:bg-background"
                  value="browser"
                />
              }
            >
              <Globe className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Browser</TooltipContent>
          </Tooltip>
        </TabsList>
      </Tabs>
    </div>
  );
};

export const BrowserPanel = (props: BrowserPanelProps) => {
  const rightPanelView = useIdeStore((state) => state.rightPanelView);
  const baseColor = useUiStore((state) => state.baseColor);

  return (
    <div className="flex h-full min-h-0 flex-col pt-2">
      <RightPanelTabs />
      <div
        className={cn(
          RIGHT_PANEL_SURFACE_CLASSES,
          "flex min-h-0 flex-1 flex-col",
        )}
        data-base-color={baseColor === "neutral" ? undefined : baseColor}
      >
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
            rightPanelView === "browser" ? "" : "hidden",
          )}
        >
          <MemoizedBrowserViewport {...props} />
        </div>
      </div>
    </div>
  );
};
