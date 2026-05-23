import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Code2,
  EllipsisVertical,
  ExternalLink,
  Globe,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Trash2,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import type {
  BrowserTabState,
  BrowserUpdatePayload,
  ProjectConfig,
} from "@/types/ide";
import { useIdeStore } from "./ide-store";
import { type StandardTabItem, StandardTabs } from "./standard-tabs";

const EMPTY_BROWSER_TABS: BrowserTabState[] = [];
const BROWSER_ZOOM_STEP = 0.1;

export interface BrowserPanelProps {
  active?: boolean;
  browserHostRef: RefObject<HTMLDivElement | null>;
  browserResizeHidden?: boolean;
  onSyncBrowserBounds: (reload?: boolean) => void;
  project: ProjectConfig;
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

const isNewBrowserTab = (tab: BrowserTabState) => tab.url.trim().length === 0;

const BrowserPanelImpl = ({
  active = true,
  onSyncBrowserBounds,
  browserResizeHidden = false,
  browserHostRef,
  project,
}: BrowserPanelProps) => {
  const browserContainerRef = useRef<HTMLDivElement | null>(null);
  const [browserUrlDraft, setBrowserUrlDraft] = useState("");

  const browserError = useIdeStore((state) => state.browserError);
  const browserLoading = useIdeStore((state) => state.browserLoading);
  const tabs = useIdeStore(
    (state) => state.browserTabsByProject[project.id] ?? EMPTY_BROWSER_TABS,
  );
  const activeTabId = useIdeStore(
    (state) => state.activeBrowserTabIdByProject[project.id] ?? null,
  );
  const setBrowserError = useIdeStore((state) => state.setBrowserError);
  const openExternalUrl = useIdeStore((state) => state.openExternalUrl);
  const updateProject = useIdeStore((state) => state.updateProject);
  const ensureBrowserTabs = useIdeStore((state) => state.ensureBrowserTabs);
  const createBrowserTab = useIdeStore((state) => state.createBrowserTab);
  const updateBrowserTab = useIdeStore((state) => state.updateBrowserTab);
  const closeBrowserTab = useIdeStore((state) => state.closeBrowserTab);
  const reorderBrowserTabs = useIdeStore((state) => state.reorderBrowserTabs);
  const setActiveBrowserTab = useIdeStore((state) => state.setActiveBrowserTab);
  const setProjectRightPanelOpen = useIdeStore(
    (state) => state.setProjectRightPanelOpen,
  );

  const projectId = project.id;
  const resolvedActiveTabId = activeTabId ?? tabs[0]?.id ?? null;
  const activeTab =
    tabs.find((tab) => tab.id === resolvedActiveTabId) ?? tabs[0] ?? null;
  const isBrowserLoading = activeTab
    ? (browserLoading[activeTab.id] ?? false)
    : false;
  const browserZoomFactor = activeTab?.zoomFactor ?? 1;
  const browserZoomPercent = `${Math.round(browserZoomFactor * 100)}%`;
  const browserVisible = Boolean(activeTab?.url);
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
    if (!active) {
      return;
    }

    ensureBrowserTabs(project.id, project.browserUrl);
  }, [active, ensureBrowserTabs, project.browserUrl, project.id]);

  useEffect(() => {
    if (!active || !tabs.length || activeTabId) {
      return;
    }

    setActiveBrowserTab(projectId, tabs[0].id);
  }, [active, activeTabId, projectId, setActiveBrowserTab, tabs]);

  useEffect(() => {
    setBrowserUrlDraft(activeTab?.url ?? "");
  }, [activeTab?.url]);

  const syncAfterStateChange = useCallback(
    (reload = false) => {
      if (!active) {
        return;
      }

      requestAnimationFrame(() => {
        onSyncBrowserBounds(reload);
      });
    },
    [active, onSyncBrowserBounds],
  );

  const handleActivateTab = useCallback(
    (tabId: string) => {
      const nextTab = tabs.find((tab) => tab.id === tabId) ?? null;
      setActiveBrowserTab(projectId, tabId);
      setBrowserUrlDraft(nextTab?.url ?? "");
      setBrowserError(null);

      updateProject(projectId, (project) => ({
        ...project,
        browserUrl: nextTab?.url ?? "",
      }));

      syncAfterStateChange();
    },
    [
      projectId,
      setActiveBrowserTab,
      setBrowserError,
      syncAfterStateChange,
      tabs,
      updateProject,
    ],
  );

  const handleReorderTab = useCallback(
    (fromIndex: number, toIndex: number) => {
      reorderBrowserTabs(projectId, fromIndex, toIndex);
      syncAfterStateChange();
    },
    [projectId, reorderBrowserTabs, syncAfterStateChange],
  );

  const handleAddTab = useCallback(() => {
    createBrowserTab(projectId);
    setBrowserError(null);
    setBrowserUrlDraft("");
    updateProject(projectId, (project) => ({
      ...project,
      browserUrl: "",
    }));
    syncAfterStateChange();
  }, [
    createBrowserTab,
    projectId,
    setBrowserError,
    syncAfterStateChange,
    updateProject,
  ]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const closingTab = tabs.find((tab) => tab.id === tabId) ?? null;
      if (tabs.length === 1 && closingTab && isNewBrowserTab(closingTab)) {
        setProjectRightPanelOpen(projectId, false);
        setBrowserError(null);
        setBrowserUrlDraft("");
        updateProject(projectId, (project) => ({
          ...project,
          browserUrl: "",
        }));
        syncAfterStateChange();
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
      closeBrowserTab(projectId, tabId);
      setBrowserError(null);
      setBrowserUrlDraft(fallbackTab?.url ?? "");

      updateProject(projectId, (project) => ({
        ...project,
        browserUrl: fallbackTab?.url ?? "",
      }));

      syncAfterStateChange();
    },
    [
      activeTab,
      activeTabId,
      closeBrowserTab,
      projectId,
      setBrowserError,
      setProjectRightPanelOpen,
      syncAfterStateChange,
      tabs,
      updateProject,
    ],
  );

  const handleNavigate = useCallback(() => {
    if (!activeTab) {
      return;
    }

    const nextUrl = normalizeBrowserUrlInput(browserUrlDraft);
    if (!nextUrl) {
      return;
    }

    setBrowserError(null);
    updateBrowserTab(projectId, activeTab.id, (tab) => ({
      ...tab,
      title: getBrowserTabTitle(nextUrl),
      url: nextUrl,
    }));
    updateProject(projectId, (project) => ({
      ...project,
      browserUrl: nextUrl,
    }));
    setBrowserUrlDraft(nextUrl);
    syncAfterStateChange(true);
  }, [
    activeTab,
    browserUrlDraft,
    projectId,
    setBrowserError,
    syncAfterStateChange,
    updateBrowserTab,
    updateProject,
  ]);

  const handleRefresh = useCallback(() => {
    if (!activeTab) {
      return;
    }

    if (isBrowserLoading) {
      getDesktopApi()?.updateBrowser({
        projectId,
        stop: true,
        tabId: activeTab.id,
      });
      return;
    }

    setBrowserError(null);
    syncAfterStateChange(true);
  }, [
    activeTab,
    isBrowserLoading,
    projectId,
    setBrowserError,
    syncAfterStateChange,
  ]);

  const handleForceReload = useCallback(() => {
    if (!activeTab?.url) {
      return;
    }

    setBrowserError(null);
    syncAfterStateChange(true);
  }, [activeTab?.url, setBrowserError, syncAfterStateChange]);

  const handleOpenExternal = useCallback(() => {
    if (!activeTab?.url) {
      return;
    }

    openExternalUrl(activeTab.url);
  }, [activeTab?.url, openExternalUrl]);

  const handleGoBack = useCallback(() => {
    if (!activeTab?.canGoBack) {
      return;
    }

    setBrowserError(null);
    getDesktopApi()?.updateBrowser({
      goBack: true,
      projectId,
      tabId: activeTab.id,
    });
  }, [activeTab, projectId, setBrowserError]);

  const handleGoForward = useCallback(() => {
    if (!activeTab?.canGoForward) {
      return;
    }

    setBrowserError(null);
    getDesktopApi()?.updateBrowser({
      goForward: true,
      projectId,
      tabId: activeTab.id,
    });
  }, [activeTab, projectId, setBrowserError]);

  const handleOpenDevTools = useCallback(() => {
    if (!activeTab) {
      return;
    }

    onSyncBrowserBounds();
    window.requestAnimationFrame(() => {
      getDesktopApi()?.updateBrowser({
        openDevTools: true,
        projectId,
        tabId: activeTab.id,
      });
    });
  }, [activeTab, onSyncBrowserBounds, projectId]);

  const handleBrowserAction = useCallback(
    (payload: BrowserUpdatePayload) => {
      if (!activeTab) {
        return;
      }

      setBrowserError(null);
      getDesktopApi()?.updateBrowser({
        ...payload,
        projectId,
        tabId: activeTab.id,
      });
    },
    [activeTab, projectId, setBrowserError],
  );

  const handleZoomOut = useCallback(() => {
    handleBrowserAction({ zoomDelta: -BROWSER_ZOOM_STEP });
  }, [handleBrowserAction]);

  const handleZoomIn = useCallback(() => {
    handleBrowserAction({ zoomDelta: BROWSER_ZOOM_STEP });
  }, [handleBrowserAction]);

  const handleResetZoom = useCallback(() => {
    handleBrowserAction({ resetZoom: true });
  }, [handleBrowserAction]);

  const handleClearCookies = useCallback(() => {
    handleBrowserAction({ clearCookies: true });
  }, [handleBrowserAction]);

  const handleClearCache = useCallback(() => {
    handleBrowserAction({ clearCache: true });
  }, [handleBrowserAction]);

  const handleTakeScreenshot = useCallback(() => {
    handleBrowserAction({ takeScreenshot: true });
  }, [handleBrowserAction]);

  useEffect(() => {
    if (!active) {
      return;
    }

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
  }, [active, onSyncBrowserBounds]);

  return (
    <div
      id={`browser-panel-${projectId}`}
      className="flex h-full flex-col overflow-hidden"
    >
      <div className="flex items-center gap-2 bg-surface-50 dark:bg-surface-900 px-3 py-1.5">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <StandardTabs
          activeId={activeTab?.id ?? null}
          after={
            <button
              aria-label="New tab"
              className="mb-px flex h-8 w-8 shrink-0 items-center justify-center rounded-lg p-0 text-muted-foreground transition-colors hover:bg-surface-100 dark:hover:bg-surface-800 hover:text-foreground"
              onClick={handleAddTab}
              title="New tab"
              type="button"
            >
              <Plus className="size-4" />
            </button>
          }
          ariaLabel="Browser tabs"
          canClose={true}
          closeAriaLabel={(tab) => `Close ${tab.label.toLowerCase()}`}
          className="flex-1"
          items={browserTabItems}
          onActivate={handleActivateTab}
          onClose={handleCloseTab}
          onReorder={handleReorderTab}
        />
      </div>

      <div className="flex items-center gap-0.5 border-b border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-1.5 py-2">
        <button
          className={cn(
            "rounded p-1 transition-colors",
            activeTab?.canGoBack
              ? "text-muted-foreground hover:bg-muted hover:text-foreground"
              : "text-surface-400 dark:text-surface-600",
          )}
          disabled={!activeTab?.canGoBack}
          onClick={handleGoBack}
          title="Go back"
          type="button"
        >
          <ArrowLeft className="size-4" />
        </button>

        <button
          className={cn(
            "rounded p-1 transition-colors",
            activeTab?.canGoForward
              ? "text-muted-foreground hover:bg-muted hover:text-foreground"
              : "text-surface-400 dark:text-surface-600",
          )}
          disabled={!activeTab?.canGoForward}
          onClick={handleGoForward}
          title="Go forward"
          type="button"
        >
          <ArrowRight className="size-4" />
        </button>

        <button
          className={cn(
            "rounded p-1 transition-colors",
            activeTab
              ? "text-muted-foreground hover:bg-muted hover:text-foreground"
              : "text-surface-400 dark:text-surface-600",
          )}
          disabled={!activeTab}
          onClick={handleRefresh}
          title={isBrowserLoading ? "Stop loading" : "Refresh browser"}
          type="button"
        >
          {isBrowserLoading ? (
            <X className="size-4" />
          ) : (
            <RotateCw className="size-4" />
          )}
        </button>

        <div className="group relative mx-1.5 flex-1">
          <Input
            className="h-7 rounded-full border-surface-200 dark:border-surface-800 bg-surface-100 dark:bg-surface-950 px-3 pr-14 text-xs focus:border-surface-300 dark:focus:border-surface-700"
            disabled={!activeTab}
            onChange={(event) => {
              setBrowserUrlDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !activeTab) {
                return;
              }

              event.preventDefault();
              handleNavigate();
            }}
            placeholder="Enter URL..."
            value={browserUrlDraft}
          />
          <button
            aria-label="Open current URL in system browser"
            className={cn(
              "-translate-y-1/2 absolute top-1/2 right-2 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 focus:outline-none group-focus-within:opacity-100 group-hover:opacity-100",
              activeTab?.url ? "" : "pointer-events-none",
            )}
            disabled={!activeTab?.url}
            onClick={handleOpenExternal}
            title="Open in system browser"
            type="button"
          >
            <ExternalLink className="size-3.5" />
          </button>
          {isBrowserLoading ? (
            <div className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-8">
              <Spinner className="size-3.5 text-muted-foreground" />
            </div>
          ) : null}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                aria-label="Browser actions"
                className={cn(
                  "rounded p-1 transition-colors",
                  activeTab?.url && !browserResizeHidden
                    ? "text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
                    : "text-surface-400 dark:text-surface-600",
                )}
                disabled={!activeTab?.url || browserResizeHidden}
                title="Browser actions"
                type="button"
              />
            }
          >
            <EllipsisVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onClick={handleForceReload}>
              <RotateCw className="size-4" />
              Force reload
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleTakeScreenshot}>
              <Camera className="size-4" />
              Take screenshot
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleOpenDevTools}>
              <Code2 className="size-4" />
              Open DevTools
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div
              className="flex items-center gap-2 px-2 py-1.5 text-sm"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span className="min-w-0 flex-1">Zoom</span>
              <div className="flex items-center overflow-hidden rounded-md border border-surface-200 dark:border-surface-800">
                <button
                  aria-label="Zoom out"
                  className="flex size-7 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={handleZoomOut}
                  title="Zoom out"
                  type="button"
                >
                  <Minus className="size-3.5" />
                </button>
                <div className="min-w-14 border-x border-surface-200 px-2 text-center text-muted-foreground dark:border-surface-800">
                  {browserZoomPercent}
                </div>
                <button
                  aria-label="Zoom in"
                  className="flex size-7 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={handleZoomIn}
                  title="Zoom in"
                  type="button"
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
              <button
                aria-label="Reset zoom"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={handleResetZoom}
                title="Reset zoom"
                type="button"
              >
                <RotateCcw className="size-3.5" />
              </button>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleClearCookies}>
              <Trash2 className="size-4" />
              Clear cookies
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleClearCache}>
              <Trash2 className="size-4" />
              Clear cache
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1">
        <div className="relative h-full" ref={browserContainerRef}>
          <div
            className="absolute top-px right-[2px] bottom-[2px] left-[2px]"
            ref={browserHostRef}
          />
          {browserVisible && browserResizeHidden ? (
            <div className="absolute inset-0 bg-background" />
          ) : null}
          {browserError ? (
            <div className="pointer-events-none absolute right-3 bottom-3 left-3 rounded-md border border-destructive-border bg-background px-3 py-2 text-xs text-destructive shadow-sm">
              {browserError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export const BrowserPanel = memo(BrowserPanelImpl);
BrowserPanel.displayName = "BrowserPanel";
