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
  type RefCallback,
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
import type { BrowserTabState, ProjectConfig } from "@/types/ide";
import { useIdeStore } from "./ide-store";
import { type StandardTabItem, StandardTabs } from "./standard-tabs";

const EMPTY_BROWSER_TABS: BrowserTabState[] = [];
const BROWSER_ZOOM_STEP = 0.1;
const MIN_BROWSER_ZOOM = 0.25;
const MAX_BROWSER_ZOOM = 3;

export interface BrowserPanelProps {
  active?: boolean;
  project: ProjectConfig;
}

type WebviewNavigationEvent = Event & {
  url?: string;
  isMainFrame?: boolean;
};

type WebviewTitleEvent = Event & {
  title?: string;
};

type WebviewFailEvent = Event & {
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
  isMainFrame?: boolean;
};

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

const clampBrowserZoom = (value: number) =>
  Math.min(MAX_BROWSER_ZOOM, Math.max(MIN_BROWSER_ZOOM, value));

const getWebviewUrl = (webview: ElectronWebviewElement) => {
  try {
    return webview.getURL() || "";
  } catch {
    return "";
  }
};

const getWebviewTitle = (webview: ElectronWebviewElement) => {
  try {
    return webview.getTitle() || "";
  } catch {
    return "";
  }
};

const getWebviewZoomFactor = (webview: ElectronWebviewElement) => {
  try {
    return webview.getZoomFactor();
  } catch {
    return 1;
  }
};

const getWebviewCanGoBack = (webview: ElectronWebviewElement) => {
  try {
    return webview.canGoBack();
  } catch {
    return false;
  }
};

const getWebviewCanGoForward = (webview: ElectronWebviewElement) => {
  try {
    return webview.canGoForward();
  } catch {
    return false;
  }
};

type BrowserWebviewProps = {
  active: boolean;
  onError: (tabId: string, event: WebviewFailEvent) => void;
  onLoadingChange: (tabId: string, loading: boolean) => void;
  onRef: RefCallback<ElectronWebviewElement>;
  onStateChange: (
    tabId: string,
    webview: ElectronWebviewElement,
    overrides?: Partial<BrowserTabState>,
  ) => void;
  tab: BrowserTabState;
};

const BrowserWebview = memo(
  ({
    active,
    onError,
    onLoadingChange,
    onRef,
    onStateChange,
    tab,
  }: BrowserWebviewProps) => {
    const webviewRef = useRef<ElectronWebviewElement | null>(null);

    const setWebviewRef = useCallback<RefCallback<ElectronWebviewElement>>(
      (node) => {
        webviewRef.current = node;
        onRef(node);
      },
      [onRef],
    );

    useEffect(() => {
      const webview = webviewRef.current;
      if (!webview) {
        return;
      }

      const handleStartLoading = () => {
        onLoadingChange(tab.id, true);
      };
      const handleStopLoading = () => {
        onLoadingChange(tab.id, false);
        onStateChange(tab.id, webview);
      };
      const handleNavigate = (event: Event) => {
        const navigationEvent = event as WebviewNavigationEvent;
        if (navigationEvent.isMainFrame === false) {
          return;
        }

        onStateChange(tab.id, webview, {
          url: navigationEvent.url || getWebviewUrl(webview),
        });
      };
      const handleTitleUpdated = (event: Event) => {
        const titleEvent = event as WebviewTitleEvent;
        onStateChange(tab.id, webview, {
          title: titleEvent.title || getWebviewTitle(webview),
        });
      };
      const handleFailLoad = (event: Event) => {
        const failEvent = event as WebviewFailEvent;
        if (failEvent.isMainFrame === false || failEvent.errorCode === -3) {
          return;
        }

        onError(tab.id, failEvent);
      };

      webview.addEventListener("did-start-loading", handleStartLoading);
      webview.addEventListener("did-stop-loading", handleStopLoading);
      webview.addEventListener("did-finish-load", handleStopLoading);
      webview.addEventListener("did-navigate", handleNavigate);
      webview.addEventListener("did-navigate-in-page", handleNavigate);
      webview.addEventListener("page-title-updated", handleTitleUpdated);
      webview.addEventListener("did-fail-load", handleFailLoad);

      return () => {
        webview.removeEventListener("did-start-loading", handleStartLoading);
        webview.removeEventListener("did-stop-loading", handleStopLoading);
        webview.removeEventListener("did-finish-load", handleStopLoading);
        webview.removeEventListener("did-navigate", handleNavigate);
        webview.removeEventListener("did-navigate-in-page", handleNavigate);
        webview.removeEventListener("page-title-updated", handleTitleUpdated);
        webview.removeEventListener("did-fail-load", handleFailLoad);
      };
    }, [onError, onLoadingChange, onStateChange, tab.id]);

    return (
      <webview
        allowpopups={true}
        className="absolute inset-0 h-full w-full bg-background"
        data-browser-tab-id={tab.id}
        key={tab.id}
        partition="persist:dream-browser"
        ref={setWebviewRef}
        src={tab.url || "about:blank"}
        style={{
          display: active ? "flex" : "none",
        }}
        webpreferences="contextIsolation=yes,sandbox=yes"
      />
    );
  },
);
BrowserWebview.displayName = "BrowserWebview";

const BrowserPanelImpl = ({ active = true, project }: BrowserPanelProps) => {
  const webviewRefs = useRef(new Map<string, ElectronWebviewElement>());
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
  const setBrowserLoading = useIdeStore((state) => state.setBrowserLoading);
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

  const getActiveWebview = useCallback(
    () => (activeTab ? (webviewRefs.current.get(activeTab.id) ?? null) : null),
    [activeTab],
  );

  const handleWebviewRef = useCallback(
    (tabId: string): RefCallback<ElectronWebviewElement> =>
      (node) => {
        if (node) {
          webviewRefs.current.set(tabId, node);
          return;
        }

        webviewRefs.current.delete(tabId);
      },
    [],
  );

  const updateProjectUrlIfActive = useCallback(
    (tabId: string, url: string) => {
      const state = useIdeStore.getState();
      const currentActiveTabId =
        state.activeBrowserTabIdByProject[projectId] ?? null;
      if (currentActiveTabId !== tabId || !url) {
        return;
      }

      const currentProject = state.projects.find(
        (item) => item.id === projectId,
      );
      if (!currentProject || currentProject.browserUrl === url) {
        return;
      }

      state.updateProject(projectId, (project) => ({
        ...project,
        browserUrl: url,
      }));
    },
    [projectId],
  );

  const handleWebviewStateChange = useCallback(
    (
      tabId: string,
      webview: ElectronWebviewElement,
      overrides: Partial<BrowserTabState> = {},
    ) => {
      const url = overrides.url ?? getWebviewUrl(webview);
      const title = overrides.title ?? getWebviewTitle(webview);
      const zoomFactor = overrides.zoomFactor ?? getWebviewZoomFactor(webview);

      updateBrowserTab(projectId, tabId, (tab) => ({
        ...tab,
        canGoBack: getWebviewCanGoBack(webview),
        canGoForward: getWebviewCanGoForward(webview),
        title: title || getBrowserTabTitle(url) || tab.title,
        url: url || tab.url,
        zoomFactor,
      }));
      updateProjectUrlIfActive(tabId, url);
    },
    [projectId, updateBrowserTab, updateProjectUrlIfActive],
  );

  const handleWebviewLoadingChange = useCallback(
    (tabId: string, loading: boolean) => {
      setBrowserLoading(tabId, loading);
      if (loading) {
        setBrowserError(null);
      }
    },
    [setBrowserError, setBrowserLoading],
  );

  const handleWebviewError = useCallback(
    (tabId: string, event: WebviewFailEvent) => {
      setBrowserLoading(tabId, false);
      setBrowserError(
        `${String(event.errorCode ?? "LOAD_FAILED")}${
          event.errorDescription ? `: ${event.errorDescription}` : ""
        }`,
      );
    },
    [setBrowserError, setBrowserLoading],
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
    },
    [projectId, setActiveBrowserTab, setBrowserError, tabs, updateProject],
  );

  const handleReorderTab = useCallback(
    (fromIndex: number, toIndex: number) => {
      reorderBrowserTabs(projectId, fromIndex, toIndex);
    },
    [projectId, reorderBrowserTabs],
  );

  const handleAddTab = useCallback(() => {
    createBrowserTab(projectId);
    setBrowserError(null);
    setBrowserUrlDraft("");
    updateProject(projectId, (project) => ({
      ...project,
      browserUrl: "",
    }));
  }, [createBrowserTab, projectId, setBrowserError, updateProject]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      if (tabs.length === 1) {
        webviewRefs.current.delete(tabId);
        closeBrowserTab(projectId, tabId);
        setProjectRightPanelOpen(projectId, false);
        setBrowserError(null);
        setBrowserUrlDraft("");
        updateProject(projectId, (project) => ({
          ...project,
          browserUrl: "",
        }));
        return;
      }

      const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
      const remainingTabs = tabs.filter((tab) => tab.id !== tabId);
      const fallbackTab =
        activeTabId === tabId
          ? (remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)] ??
            null)
          : activeTab;

      webviewRefs.current.delete(tabId);
      closeBrowserTab(projectId, tabId);
      setBrowserError(null);
      setBrowserUrlDraft(fallbackTab?.url ?? "");

      updateProject(projectId, (project) => ({
        ...project,
        browserUrl: fallbackTab?.url ?? "",
      }));
    },
    [
      activeTab,
      activeTabId,
      closeBrowserTab,
      projectId,
      setBrowserError,
      setProjectRightPanelOpen,
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
    setBrowserLoading(activeTab.id, true);
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

    try {
      getActiveWebview()?.loadURL(nextUrl);
    } catch {
      setBrowserLoading(activeTab.id, false);
    }
  }, [
    activeTab,
    browserUrlDraft,
    getActiveWebview,
    projectId,
    setBrowserError,
    setBrowserLoading,
    updateBrowserTab,
    updateProject,
  ]);

  const handleRefresh = useCallback(() => {
    if (!activeTab) {
      return;
    }

    const webview = getActiveWebview();
    if (!webview) {
      return;
    }

    try {
      if (isBrowserLoading) {
        webview.stop();
        setBrowserLoading(activeTab.id, false);
        return;
      }

      setBrowserError(null);
      webview.reload();
    } catch {
      setBrowserLoading(activeTab.id, false);
    }
  }, [
    activeTab,
    getActiveWebview,
    isBrowserLoading,
    setBrowserError,
    setBrowserLoading,
  ]);

  const handleForceReload = useCallback(() => {
    if (!activeTab?.url) {
      return;
    }

    setBrowserError(null);
    try {
      getActiveWebview()?.reloadIgnoringCache();
    } catch {
      // ignore reload failures; webview events will surface load errors
    }
  }, [activeTab?.url, getActiveWebview, setBrowserError]);

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
    try {
      getActiveWebview()?.goBack();
    } catch {
      // ignore history failures
    }
  }, [activeTab?.canGoBack, getActiveWebview, setBrowserError]);

  const handleGoForward = useCallback(() => {
    if (!activeTab?.canGoForward) {
      return;
    }

    setBrowserError(null);
    try {
      getActiveWebview()?.goForward();
    } catch {
      // ignore history failures
    }
  }, [activeTab?.canGoForward, getActiveWebview, setBrowserError]);

  const handleOpenDevTools = useCallback(() => {
    try {
      getActiveWebview()?.openDevTools();
    } catch {
      setBrowserError("Failed to open DevTools.");
    }
  }, [getActiveWebview, setBrowserError]);

  const updateActiveZoomFactor = useCallback(
    (updater: (current: number) => number) => {
      if (!activeTab) {
        return;
      }

      const webview = getActiveWebview();
      const nextZoomFactor = clampBrowserZoom(
        updater(activeTab.zoomFactor ?? 1),
      );
      try {
        webview?.setZoomFactor(nextZoomFactor);
      } catch {
        // Keep UI state consistent even if the guest is not ready yet.
      }

      updateBrowserTab(projectId, activeTab.id, (tab) => ({
        ...tab,
        zoomFactor: nextZoomFactor,
      }));
    },
    [activeTab, getActiveWebview, projectId, updateBrowserTab],
  );

  const handleZoomOut = useCallback(() => {
    updateActiveZoomFactor((current) => current - BROWSER_ZOOM_STEP);
  }, [updateActiveZoomFactor]);

  const handleZoomIn = useCallback(() => {
    updateActiveZoomFactor((current) => current + BROWSER_ZOOM_STEP);
  }, [updateActiveZoomFactor]);

  const handleResetZoom = useCallback(() => {
    updateActiveZoomFactor(() => 1);
  }, [updateActiveZoomFactor]);

  const handleBrowserUtilityAction = useCallback(
    (payload: {
      clearCache?: boolean;
      clearCookies?: boolean;
      takeScreenshot?: boolean;
    }) => {
      const webview = getActiveWebview();
      if (!activeTab || !webview) {
        return;
      }

      setBrowserError(null);
      getDesktopApi()?.updateBrowser({
        ...payload,
        projectId,
        tabId: activeTab.id,
        webContentsId: webview.getWebContentsId(),
      });
    },
    [activeTab, getActiveWebview, projectId, setBrowserError],
  );

  const handleClearCookies = useCallback(() => {
    handleBrowserUtilityAction({ clearCookies: true });
  }, [handleBrowserUtilityAction]);

  const handleClearCache = useCallback(() => {
    handleBrowserUtilityAction({ clearCache: true });
  }, [handleBrowserUtilityAction]);

  const handleTakeScreenshot = useCallback(() => {
    handleBrowserUtilityAction({ takeScreenshot: true });
  }, [handleBrowserUtilityAction]);

  return (
    <div
      id={`browser-panel-${projectId}`}
      className="flex h-full flex-col overflow-hidden"
    >
      <div className="flex items-center gap-2 bg-surface-50 px-3 py-1.5 dark:bg-surface-900">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <StandardTabs
          activeId={activeTab?.id ?? null}
          after={
            <button
              aria-label="New tab"
              className="mb-px flex h-8 w-8 shrink-0 items-center justify-center rounded-lg p-0 text-muted-foreground transition-colors hover:bg-surface-100 hover:text-foreground dark:hover:bg-surface-800"
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

      <div className="flex items-center gap-0.5 border-surface-200 border-b bg-surface-50 px-1.5 py-2 dark:border-surface-800 dark:bg-surface-900">
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
            className="h-7 rounded-full border-surface-200 bg-surface-100 px-3 pr-14 text-xs focus:border-surface-300 dark:border-surface-800 dark:bg-surface-950 dark:focus:border-surface-700"
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
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                aria-label="Browser actions"
                className={cn(
                  "rounded p-1 transition-colors",
                  activeTab?.url
                    ? "text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
                    : "text-surface-400 dark:text-surface-600",
                )}
                disabled={!activeTab?.url}
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
                <div className="min-w-14 border-surface-200 border-x px-2 text-center text-muted-foreground dark:border-surface-800">
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
        <div className="relative h-full">
          {tabs.map((tab) =>
            tab.url ? (
              <BrowserWebview
                active={tab.id === activeTab?.id}
                key={tab.id}
                onError={handleWebviewError}
                onLoadingChange={handleWebviewLoadingChange}
                onRef={handleWebviewRef(tab.id)}
                onStateChange={handleWebviewStateChange}
                tab={tab}
              />
            ) : null,
          )}
          {!browserVisible ? (
            <div className="flex h-full items-center justify-center bg-background px-6 text-center text-muted-foreground text-sm">
              Enter a URL to start browsing.
            </div>
          ) : null}
          {browserError ? (
            <div className="pointer-events-none absolute right-3 bottom-3 left-3 rounded-md border border-destructive-border bg-background px-3 py-2 text-destructive text-xs shadow-sm">
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
