import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Globe,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { getDesktopApi } from "@/lib/electron";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { BrowserTabState, ProjectConfig } from "@/types/ide";
import { ChangesPanel } from "./changes-panel";
import { FileExplorerPanel } from "./file-explorer-panel";
import { AppShellPlaceholder } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import type { RightPanelView } from "./ide-types";
import { type StandardTabItem, StandardTabs } from "./standard-tabs";

const RIGHT_PANEL_SURFACE_CLASSES =
  "overflow-hidden rounded-lg border border-foreground/20 bg-background text-foreground shadow-md";
const EMPTY_BROWSER_TABS: BrowserTabState[] = [];

export interface BrowserPanelProps {
  active?: boolean;
  browserHostRef: RefObject<HTMLDivElement | null>;
  browserResizeHidden?: boolean;
  onSyncBrowserBounds: (reload?: boolean) => void;
  project: ProjectConfig;
  rightPanelView: RightPanelView;
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
  const updateProject = useIdeStore((state) => state.updateProject);
  const ensureBrowserTabs = useIdeStore((state) => state.ensureBrowserTabs);
  const createBrowserTab = useIdeStore((state) => state.createBrowserTab);
  const updateBrowserTab = useIdeStore((state) => state.updateBrowserTab);
  const closeBrowserTab = useIdeStore((state) => state.closeBrowserTab);
  const reorderBrowserTabs = useIdeStore((state) => state.reorderBrowserTabs);
  const setActiveBrowserTab = useIdeStore((state) => state.setActiveBrowserTab);

  const projectId = project.id;
  const resolvedActiveTabId = activeTabId ?? tabs[0]?.id ?? null;
  const activeTab =
    tabs.find((tab) => tab.id === resolvedActiveTabId) ?? tabs[0] ?? null;
  const isBrowserLoading = activeTab
    ? (browserLoading[activeTab.id] ?? false)
    : false;
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
      <div className="flex items-center gap-2 bg-muted/50 px-3 py-1.5">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <StandardTabs
          activeId={activeTab?.id ?? null}
          after={
            <button
              aria-label="New tab"
              className="mb-px flex h-8 w-8 shrink-0 items-center justify-center rounded-lg p-0 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
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

      <div className="flex items-center gap-0.5 border-b border-foreground/10 bg-muted/50 px-1.5 py-2">
        <button
          className={cn(
            "rounded p-1 transition-colors",
            activeTab?.canGoBack
              ? "text-muted-foreground hover:bg-muted hover:text-foreground"
              : "text-muted-foreground/40",
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
              : "text-muted-foreground/40",
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
              : "text-muted-foreground/40",
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

        <div className="relative mx-1.5 flex-1">
          <Input
            className="h-7 rounded-full border-foreground/10 bg-background px-3 text-xs focus:border-foreground/20"
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
          {!browserVisible ? (
            <div className="absolute inset-0 p-3">
              <AppShellPlaceholder message="Enter a URL to show the live browser." />
            </div>
          ) : null}
          {browserVisible && browserResizeHidden ? (
            <div className="absolute inset-0 bg-background" />
          ) : null}
          {browserError ? (
            <div className="pointer-events-none absolute right-3 bottom-3 left-3 rounded-md border border-destructive/20 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm">
              {browserError}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center justify-end border-t border-foreground/10 bg-muted/50 px-1.5">
        <button
          aria-label="Open DevTools"
          className={cn(
            "rounded p-1 transition-colors",
            activeTab?.url && !browserResizeHidden
              ? "text-muted-foreground hover:bg-muted hover:text-foreground"
              : "text-muted-foreground/40",
          )}
          disabled={!activeTab?.url || browserResizeHidden}
          onClick={handleOpenDevTools}
          title="Open DevTools"
          type="button"
        >
          <Code2 className="size-4" />
        </button>
      </div>
    </div>
  );
};

const MemoizedBrowserViewport = memo(BrowserViewport);
MemoizedBrowserViewport.displayName = "BrowserViewport";

const RightPanelViewSlot = ({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) => (
  <div
    aria-hidden={!active}
    className="absolute inset-0 min-h-0 overflow-hidden"
    inert={!active}
    style={{
      pointerEvents: active ? "auto" : "none",
      visibility: active ? "visible" : "hidden",
    }}
  >
    {children}
  </div>
);

export const BrowserPanel = (props: BrowserPanelProps) => {
  const baseColor = useUiStore((state) => state.baseColor);
  const rightPanelView = props.rightPanelView;

  return (
    <div className="flex h-full min-h-0 flex-col pt-2">
      <div
        className={cn(
          RIGHT_PANEL_SURFACE_CLASSES,
          "flex min-h-0 flex-1 flex-col",
        )}
        data-base-color={baseColor === "neutral" ? undefined : baseColor}
      >
        <div className="relative min-h-0 flex-1">
          <RightPanelViewSlot active={rightPanelView === "explorer"}>
            <FileExplorerPanel
              active={props.active && rightPanelView === "explorer"}
              projectId={props.project.id}
            />
          </RightPanelViewSlot>
          <RightPanelViewSlot active={rightPanelView === "changes"}>
            <ChangesPanel
              active={props.active && rightPanelView === "changes"}
              projectId={props.project.id}
            />
          </RightPanelViewSlot>
          <RightPanelViewSlot active={rightPanelView === "browser"}>
            <MemoizedBrowserViewport {...props} />
          </RightPanelViewSlot>
        </div>
      </div>
    </div>
  );
};
