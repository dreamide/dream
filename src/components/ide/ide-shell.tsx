import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { Spinner } from "@/components/ui/spinner";
import { getDesktopApi, hasDesktopApi } from "@/lib/electron";
import {
  DEFAULT_PANEL_SIZES,
  getConnectedProviders,
  getDefaultModelForProvider,
  getDefaultModelSelection,
  getModelsForProvider,
  getPreferredDefaultModel,
  normalizeClaudeCodeModelId,
} from "@/lib/ide-defaults";
import {
  isModalPreviewHidden,
  useModalPreviewHidden,
} from "@/lib/modal-visibility";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { PreviewBounds } from "@/types/ide";
import { ChatPanel } from "./chat-panel";
import { IdeFooter, IdeHeader } from "./ide-header";
import { AppShellPlaceholder, PanelResizeHandle } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { dedupeModels, TERMINAL_MIN_HEIGHT_PX } from "./ide-types";
import { PreviewPanel } from "./preview-panel";
import { ProjectSidebar } from "./projects-panel";
import { SettingsDialog } from "./settings-dialog";
import { ProjectTerminalTabsPanel } from "./terminal-panel";

const PROJECT_SIDEBAR_WIDTH_PX = DEFAULT_PANEL_SIZES.leftSidebarWidth;
const PROJECT_SIDEBAR_MIN_WIDTH_PX = 200;
const PROJECT_SIDEBAR_MAX_WIDTH_PX = 600;
const CHAT_PANEL_MIN_WIDTH_PX = 400;
const PREVIEW_PANEL_DEFAULT_WIDTH_PX = DEFAULT_PANEL_SIZES.rightPanelWidth;
const PREVIEW_PANEL_MIN_WIDTH_PX = 320;
const CHAT_PANEL_MIN_HEIGHT_PX = 180;
const TERMINAL_PANEL_DEFAULT_HEIGHT_PX = DEFAULT_PANEL_SIZES.terminalHeight;
const TERMINAL_PANEL_MIN_HEIGHT_PX = TERMINAL_MIN_HEIGHT_PX + 16;
const PANEL_RESIZE_HANDLE_SIZE_PX = 1;
const PANEL_EDGE_PADDING_PX = 8;
const EMPTY_TERMINAL_SESSION_IDS: string[] = [];

/** Duration (ms) for panel slide animations. */
const PANEL_TRANSITION_MS = 200;
const PANEL_TRANSITION = `width ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), min-width ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), max-width ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), padding ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
const RIGHT_PANEL_TRANSITION = `${PANEL_TRANSITION}, flex-basis ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), flex-grow ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), flex-shrink ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;

export const IdeShell = () => {
  // ── Store selectors ─────────────────────────────────────────────────
  const appReady = useIdeStore((s) => s.appReady);
  const setAppReady = useIdeStore((s) => s.setAppReady);
  const stateHydrated = useIdeStore((s) => s.stateHydrated);
  const panelVisibility = useIdeStore((s) => s.panelVisibility);
  const panelSizes = useIdeStore((s) => s.panelSizes);
  const rightPanelView = useIdeStore((s) => s.rightPanelView);
  const settings = useIdeStore((s) => s.settings);
  const settingsOpen = useIdeStore((s) => s.settingsOpen);
  const settingsSection = useIdeStore((s) => s.settingsSection);
  const projects = useIdeStore((s) => s.projects);
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const activeThread = useIdeStore((s) => s.getActiveThread());
  const threads = useIdeStore((s) => s.threads);
  const streamingThreadIds = useIdeStore((s) => s.streamingThreadIds);
  const previewTabsByProject = useIdeStore((s) => s.previewTabsByProject);
  const activePreviewTabIdByProject = useIdeStore(
    (s) => s.activePreviewTabIdByProject,
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  // Defer the active thread ID so the sidebar highlights immediately while
  // the expensive chat panel re-render happens as a low-priority transition.
  const deferredActiveThreadId = useDeferredValue(activeThread?.id ?? null);
  const deferredActiveProjectId = useDeferredValue(activeProject?.id ?? null);
  const activePreviewTab =
    activeProject?.id != null
      ? ((previewTabsByProject[activeProject.id] ?? []).find(
          (tab) =>
            tab.id ===
            (activePreviewTabIdByProject[activeProject.id] ??
              previewTabsByProject[activeProject.id]?.[0]?.id ??
              null),
        ) ??
        (previewTabsByProject[activeProject.id] ?? [])[0] ??
        null)
      : null;

  // Track the last N visited threads so they stay mounted for instant switching.
  const recentThreadIdsRef = useRef<string[]>([]);
  const recentThreadIds = useMemo(() => {
    if (
      !deferredActiveThreadId ||
      recentThreadIdsRef.current[0] === deferredActiveThreadId
    ) {
      return recentThreadIdsRef.current;
    }

    const next = [
      deferredActiveThreadId,
      ...recentThreadIdsRef.current.filter(
        (id) => id !== deferredActiveThreadId,
      ),
    ].slice(0, 10);
    recentThreadIdsRef.current = next;
    return next;
  }, [deferredActiveThreadId]);

  const mountedThreads = useMemo(() => {
    const mountedThreadIds = new Set<string>();
    const nextThreads = [] as typeof threads;

    // Mount recently visited threads (capped at 10).
    for (const id of recentThreadIds) {
      const thread = threads.find((t) => t.id === id);
      if (thread && !mountedThreadIds.has(thread.id)) {
        mountedThreadIds.add(thread.id);
        nextThreads.push(thread);
      }
    }

    // Keep streaming threads mounted.
    for (const thread of threads) {
      if (!streamingThreadIds[thread.id] || mountedThreadIds.has(thread.id)) {
        continue;
      }

      mountedThreadIds.add(thread.id);
      nextThreads.push(thread);
    }

    return nextThreads;
  }, [recentThreadIds, streamingThreadIds, threads]);
  const modalPreviewHidden = useModalPreviewHidden();

  const hydrate = useIdeStore((s) => s.hydrate);
  const setIsMacOs = useIdeStore((s) => s.setIsMacOs);
  const setIsElectron = useIdeStore((s) => s.setIsElectron);
  const appendTerminalOutput = useIdeStore((s) => s.appendTerminalOutput);
  const setTerminalStatus = useIdeStore((s) => s.setTerminalStatus);
  const setTerminalTransport = useIdeStore((s) => s.setTerminalTransport);
  const setTerminalShell = useIdeStore((s) => s.setTerminalShell);
  const setPreviewError = useIdeStore((s) => s.setPreviewError);
  const setPreviewLoading = useIdeStore((s) => s.setPreviewLoading);
  const updatePreviewTab = useIdeStore((s) => s.updatePreviewTab);
  const refreshProviderModels = useIdeStore((s) => s.refreshProviderModels);
  const setPanelSizes = useIdeStore((s) => s.setPanelSizes);
  const projectTerminalSessionIds = useIdeStore(
    (s) => s.projectTerminalSessionIds,
  );

  // ── Derived values ──────────────────────────────────────────────────
  const leftVisible = panelVisibility.left;
  const middleVisible = panelVisibility.middle;
  const rightVisible = panelVisibility.right;
  const activeProjectTerminalSessionIds = activeProject
    ? (projectTerminalSessionIds[activeProject.id] ??
      EMPTY_TERMINAL_SESSION_IDS)
    : EMPTY_TERMINAL_SESSION_IDS;
  const terminalPanelVisible = activeProjectTerminalSessionIds.length > 0;

  // ── Refs ─────────────────────────────────────────────────────────────
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  // ── Resize state ────────────────────────────────────────────────────
  // Widths live in refs so drag handlers can mutate the DOM directly
  // without triggering React re-renders on every pointer-move.
  const leftWidthRef = useRef(PROJECT_SIDEBAR_WIDTH_PX);
  const rightWidthRef = useRef(PREVIEW_PANEL_DEFAULT_WIDTH_PX);
  const terminalHeightRef = useRef(TERMINAL_PANEL_DEFAULT_HEIGHT_PX);
  const horizontalPanelsRef = useRef<HTMLDivElement | null>(null);
  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const middlePanelRef = useRef<HTMLDivElement | null>(null);
  const terminalPanelRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);

  if (!isDraggingRef.current) {
    leftWidthRef.current = panelSizes.leftSidebarWidth;
    rightWidthRef.current = panelSizes.rightPanelWidth;
    terminalHeightRef.current = panelSizes.terminalHeight;
  }

  const getHorizontalChromeWidth = useCallback(() => {
    const leftHandleWidth =
      leftVisible && (middleVisible || rightVisible)
        ? PANEL_RESIZE_HANDLE_SIZE_PX
        : 0;
    const rightHandleWidth =
      rightVisible && middleVisible ? PANEL_RESIZE_HANDLE_SIZE_PX : 0;
    const leftPadding = leftVisible ? PANEL_EDGE_PADDING_PX : 0;
    const rightPadding = rightVisible ? PANEL_EDGE_PADDING_PX : 0;

    return leftHandleWidth + rightHandleWidth + leftPadding + rightPadding;
  }, [leftVisible, middleVisible, rightVisible]);

  const getRightPanelMaxWidth = useCallback(() => {
    if (!rightVisible || !middleVisible) {
      return Number.POSITIVE_INFINITY;
    }

    const containerWidth =
      horizontalPanelsRef.current?.getBoundingClientRect().width ?? 0;
    const availableWidth =
      containerWidth -
      getHorizontalChromeWidth() -
      (leftVisible ? leftWidthRef.current : 0) -
      CHAT_PANEL_MIN_WIDTH_PX;

    return Math.max(PREVIEW_PANEL_MIN_WIDTH_PX, availableWidth);
  }, [getHorizontalChromeWidth, leftVisible, middleVisible, rightVisible]);

  const getLeftPanelMaxWidth = useCallback(() => {
    if (!leftVisible) {
      return 0;
    }

    const containerWidth =
      horizontalPanelsRef.current?.getBoundingClientRect().width ?? 0;
    const rightWidth =
      rightVisible && middleVisible
        ? rightWidthRef.current
        : rightVisible
          ? PREVIEW_PANEL_MIN_WIDTH_PX
          : 0;
    const middleMinWidth = middleVisible ? CHAT_PANEL_MIN_WIDTH_PX : 0;
    const availableWidth =
      containerWidth - getHorizontalChromeWidth() - rightWidth - middleMinWidth;

    return Math.max(
      PROJECT_SIDEBAR_MIN_WIDTH_PX,
      Math.min(PROJECT_SIDEBAR_MAX_WIDTH_PX, availableWidth),
    );
  }, [getHorizontalChromeWidth, leftVisible, middleVisible, rightVisible]);

  const syncHorizontalPanelWidths = useCallback(() => {
    if (rightVisible && middleVisible) {
      const maxRightWidth = getRightPanelMaxWidth();
      const nextRightWidth = Math.min(
        maxRightWidth,
        Math.max(PREVIEW_PANEL_MIN_WIDTH_PX, rightWidthRef.current),
      );
      rightWidthRef.current = nextRightWidth;

      const rightPanel = rightPanelRef.current;
      if (rightPanel) {
        rightPanel.style.width = `${nextRightWidth}px`;
        rightPanel.style.maxWidth = `${maxRightWidth}px`;
      }
    }

    if (leftVisible) {
      const maxLeftWidth = getLeftPanelMaxWidth();
      const nextLeftWidth = Math.min(
        maxLeftWidth,
        Math.max(PROJECT_SIDEBAR_MIN_WIDTH_PX, leftWidthRef.current),
      );
      leftWidthRef.current = nextLeftWidth;

      const leftPanel = leftPanelRef.current;
      if (leftPanel) {
        leftPanel.style.width = `${nextLeftWidth}px`;
        leftPanel.style.maxWidth = `${maxLeftWidth}px`;
      }
    }
  }, [
    getLeftPanelMaxWidth,
    getRightPanelMaxWidth,
    leftVisible,
    middleVisible,
    rightVisible,
  ]);

  const handleLeftResizeStart = useCallback(() => {
    isDraggingRef.current = true;
    const el = leftPanelRef.current;
    if (el) el.style.transition = "none";
  }, []);

  const handleLeftResize = useCallback(
    (deltaX: number) => {
      const maxLeftWidth = getLeftPanelMaxWidth();
      const next = Math.min(
        maxLeftWidth,
        Math.max(PROJECT_SIDEBAR_MIN_WIDTH_PX, leftWidthRef.current + deltaX),
      );
      leftWidthRef.current = next;
      const el = leftPanelRef.current;
      if (el) {
        el.style.width = `${next}px`;
        el.style.maxWidth = `${maxLeftWidth}px`;
      }
    },
    [getLeftPanelMaxWidth],
  );

  const handleRightResizeStart = useCallback(() => {
    isDraggingRef.current = true;
    const el = rightPanelRef.current;
    if (el) el.style.transition = "none";
  }, []);

  const handleRightResize = useCallback(
    (deltaX: number) => {
      const maxRightWidth = getRightPanelMaxWidth();
      const next = Math.max(
        PREVIEW_PANEL_MIN_WIDTH_PX,
        Math.min(maxRightWidth, rightWidthRef.current + deltaX),
      );
      rightWidthRef.current = next;
      const el = rightPanelRef.current;
      if (el) {
        el.style.width = `${next}px`;
        el.style.maxWidth = `${maxRightWidth}px`;
      }
    },
    [getRightPanelMaxWidth],
  );

  const handleResizeEnd = useCallback(() => {
    isDraggingRef.current = false;
    // Restore transitions (must match the React style prop exactly so that
    // React's reconciler stays in sync with the DOM).
    const left = leftPanelRef.current;
    if (left) left.style.transition = PANEL_TRANSITION;
    const right = rightPanelRef.current;
    if (right) right.style.transition = RIGHT_PANEL_TRANSITION;
    setPanelSizes((current) => ({
      ...current,
      leftSidebarWidth: leftWidthRef.current,
      rightPanelWidth: rightWidthRef.current,
    }));
  }, [setPanelSizes]);

  const handleTerminalResizeStart = useCallback(() => {
    const el = terminalPanelRef.current;
    if (!el) {
      return;
    }

    terminalHeightRef.current = el.getBoundingClientRect().height;
  }, []);

  const handleTerminalResize = useCallback((deltaY: number) => {
    const containerHeight =
      middlePanelRef.current?.getBoundingClientRect().height ?? 0;
    const maxHeight = Math.max(
      TERMINAL_PANEL_MIN_HEIGHT_PX,
      containerHeight - CHAT_PANEL_MIN_HEIGHT_PX - PANEL_RESIZE_HANDLE_SIZE_PX,
    );
    const next = Math.min(
      maxHeight,
      Math.max(
        TERMINAL_PANEL_MIN_HEIGHT_PX,
        terminalHeightRef.current + deltaY,
      ),
    );

    terminalHeightRef.current = next;
    const el = terminalPanelRef.current;
    if (el) {
      el.style.height = `${next}px`;
    }
  }, []);

  const handleTerminalResizeEnd = useCallback(() => {
    setPanelSizes((current) => ({
      ...current,
      terminalHeight: terminalHeightRef.current,
    }));
  }, [setPanelSizes]);

  // ── Effects ──────────────────────────────────────────────────────────

  // Detect macOS and Electron
  useEffect(() => {
    setIsMacOs(/mac/i.test(window.navigator.userAgent));
    setIsElectron(hasDesktopApi());
  }, [setIsMacOs, setIsElectron]);

  // Hydrate state from storage
  useEffect(() => {
    void hydrate();
    useUiStore.getState().hydrateUi();
  }, [hydrate]);

  // Mark app ready once hydration completes, and auto-refresh models
  useEffect(() => {
    if (!stateHydrated) return;
    void refreshProviderModels();
    setAppReady(true);
  }, [stateHydrated, setAppReady, refreshProviderModels]);

  // Subscribe to persisted state changes for auto-persistence (debounced)
  useEffect(() => {
    let prev = {
      activeProjectId: useIdeStore.getState().activeProjectId,
      activeThreadIdByProject: useIdeStore.getState().activeThreadIdByProject,
      chats: useIdeStore.getState().chats,
      panelSizes: useIdeStore.getState().panelSizes,
      panelVisibility: useIdeStore.getState().panelVisibility,
      projects: useIdeStore.getState().projects,
      settings: useIdeStore.getState().settings,
      threadSort: useIdeStore.getState().threadSort,
      threads: useIdeStore.getState().threads,
    };
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const unsub = useIdeStore.subscribe((state) => {
      const next = {
        activeProjectId: state.activeProjectId,
        activeThreadIdByProject: state.activeThreadIdByProject,
        chats: state.chats,
        panelSizes: state.panelSizes,
        panelVisibility: state.panelVisibility,
        projects: state.projects,
        settings: state.settings,
        threadSort: state.threadSort,
        threads: state.threads,
      };

      if (
        next.activeProjectId !== prev.activeProjectId ||
        next.activeThreadIdByProject !== prev.activeThreadIdByProject ||
        next.chats !== prev.chats ||
        next.panelSizes !== prev.panelSizes ||
        next.panelVisibility !== prev.panelVisibility ||
        next.projects !== prev.projects ||
        next.settings !== prev.settings ||
        next.threadSort !== prev.threadSort ||
        next.threads !== prev.threads
      ) {
        prev = next;
        if (state.stateHydrated) {
          if (persistTimer !== null) clearTimeout(persistTimer);
          persistTimer = setTimeout(() => {
            persistTimer = null;
            useIdeStore.getState().persist();
          }, 300);
        }
      }
    });

    return () => {
      unsub();
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        // Flush pending persist on unmount
        useIdeStore.getState().persist();
      }
    };
  }, []);

  // Desktop event listeners
  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    const removeTerminalData = desktopApi.onTerminalData((event) => {
      appendTerminalOutput(event.projectId, event.chunk);
    });

    const removeTerminalStatus = desktopApi.onTerminalStatus((event) => {
      setTerminalStatus(event.projectId, event.status);
      if (event.transport) {
        setTerminalTransport(event.projectId, event.transport);
      }

      const shell = typeof event.shell === "string" ? event.shell.trim() : "";
      if (shell) {
        setTerminalShell(event.projectId, shell);
      }
    });

    const removePreviewError = desktopApi.onPreviewError((event) => {
      setPreviewError(
        `${String(event.code)}${event.description ? `: ${event.description}` : ""}`,
      );
    });

    const removePreviewStatus = desktopApi.onPreviewStatus((event) => {
      setPreviewLoading(event.tabId ?? event.projectId, event.loading);
      if (!event.loading) {
        return;
      }

      setPreviewError(null);
    });

    const removePreviewPageState = desktopApi.onPreviewPageState((event) => {
      updatePreviewTab(event.projectId, event.tabId, (tab) => ({
        ...tab,
        canGoBack: event.canGoBack,
        canGoForward: event.canGoForward,
        title: event.title || tab.title,
        url: event.url || tab.url,
      }));

      const state = useIdeStore.getState();
      const activeTabId =
        state.activePreviewTabIdByProject[event.projectId] ?? null;
      if (activeTabId !== event.tabId || !event.url) {
        return;
      }

      const project = state.projects.find(
        (item) => item.id === event.projectId,
      );
      if (!project || project.previewUrl === event.url) {
        return;
      }

      state.updateProject(event.projectId, (currentProject) => ({
        ...currentProject,
        previewUrl: event.url,
      }));
    });

    return () => {
      removeTerminalData();
      removeTerminalStatus();
      removePreviewError();
      removePreviewPageState();
      removePreviewStatus();
    };
  }, [
    appendTerminalOutput,
    setTerminalStatus,
    setTerminalTransport,
    setTerminalShell,
    setPreviewError,
    setPreviewLoading,
    updatePreviewTab,
  ]);

  // Preview bounds sync
  const lastSentPreviewUrlRef = useRef<string | null>(null);
  const lastSentPreviewTabIdRef = useRef<string | null>(null);
  const syncPreviewBounds = useCallback((reload = false) => {
    const desktopApi = getDesktopApi();
    const state = useIdeStore.getState();
    const project = state.getActiveProject();
    const pv = state.panelVisibility;
    const currentRightPanelView = state.rightPanelView;
    const activeTab = project ? state.getActivePreviewTab(project.id) : null;

    if (!desktopApi) return;

    if (
      !project ||
      !activeTab?.url ||
      !pv.right ||
      currentRightPanelView !== "preview" ||
      isModalPreviewHidden()
    ) {
      lastSentPreviewUrlRef.current = null;
      lastSentPreviewTabIdRef.current = null;
      desktopApi.updatePreview({
        projectId: project?.id,
        tabId: activeTab?.id,
        visible: false,
      });
      return;
    }

    const host = previewHostRef.current;
    if (!host) return;

    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      desktopApi.updatePreview({
        projectId: project.id,
        tabId: activeTab.id,
        visible: false,
      });
      return;
    }

    const bounds: PreviewBounds = {
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };

    // Send the URL when it changed, when the tab changed, or on explicit
    // reload.  This prevents ResizeObserver / effect-driven calls from
    // causing redundant navigations in the Electron BrowserView.
    const urlChanged = activeTab.url !== lastSentPreviewUrlRef.current;
    const tabChanged = activeTab.id !== lastSentPreviewTabIdRef.current;
    const sendUrl = reload || urlChanged || tabChanged;
    if (sendUrl) {
      lastSentPreviewUrlRef.current = activeTab.url;
      lastSentPreviewTabIdRef.current = activeTab.id;
    }

    desktopApi.updatePreview({
      bounds,
      projectId: project.id,
      tabId: activeTab.id,
      ...(reload ? { reload: true } : {}),
      ...(sendUrl ? { url: activeTab.url } : {}),
      visible: true,
    });
  }, []);

  // Preview resize observer
  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    const update = () => syncPreviewBounds();
    const observer = new ResizeObserver(update);
    const host = previewHostRef.current;
    if (host) {
      observer.observe(host);
    }

    window.addEventListener("resize", update);
    const frame = window.requestAnimationFrame(update);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [syncPreviewBounds]);

  useEffect(() => {
    const update = () => syncHorizontalPanelWidths();
    const observer = new ResizeObserver(update);
    const host = horizontalPanelsRef.current;
    if (host) {
      observer.observe(host);
    }

    window.addEventListener("resize", update);
    const frame = window.requestAnimationFrame(update);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [syncHorizontalPanelWidths]);

  // Sync preview bounds when project or panel visibility changes
  useEffect(() => {
    void activeProject;
    void panelVisibility.right;
    void rightPanelView;
    void activePreviewTab?.id;
    void activePreviewTab?.url;
    syncPreviewBounds();
  }, [
    activePreviewTab?.id,
    activePreviewTab?.url,
    activeProject,
    panelVisibility.right,
    rightPanelView,
    syncPreviewBounds,
  ]);

  // Keep the preview hidden while any modal is open or finishing its exit animation.
  useEffect(() => {
    if (modalPreviewHidden) {
      syncPreviewBounds();
      return;
    }

    syncPreviewBounds();
  }, [modalPreviewHidden, syncPreviewBounds]);

  // Preview cleanup on unmount
  useEffect(() => {
    return () => {
      const desktopApi = getDesktopApi();
      if (!desktopApi) return;
      desktopApi.updatePreview({ visible: false });
    };
  }, []);

  // Auto-refresh models when settings panel opens
  useEffect(() => {
    if (
      !settingsOpen ||
      settingsSection !== "providers"
    ) {
      return;
    }
    void refreshProviderModels();
  }, [refreshProviderModels, settingsOpen, settingsSection]);

  // Sync settings integrity (dedupe models, fix connected providers)
  useEffect(() => {
    const store = useIdeStore.getState();
    const prev = settings;

    const openAiSelectedModels = dedupeModels(prev.openAiSelectedModels);
    const anthropicSelectedModels = dedupeModels(
      prev.anthropicSelectedModels.map(normalizeClaudeCodeModelId),
    );
    const nextSettings = {
      ...prev,
      anthropicSelectedModels,
      openAiSelectedModels,
    };
    const defaultModel = getPreferredDefaultModel(nextSettings);
    const enabledProviders = getConnectedProviders(nextSettings);

    const changed =
      defaultModel !== prev.defaultModel ||
      openAiSelectedModels.length !== prev.openAiSelectedModels.length ||
      anthropicSelectedModels.length !== prev.anthropicSelectedModels.length ||
      !openAiSelectedModels.every(
        (m, i) => prev.openAiSelectedModels[i] === m,
      ) ||
      !anthropicSelectedModels.every(
        (m, i) => prev.anthropicSelectedModels[i] === m,
      );

    if (changed) {
      store.setSettings({
        ...nextSettings,
        defaultModel,
      });
    }

    // Fix projects whose provider/model is no longer valid
    const effectiveSettings = { ...nextSettings, defaultModel };
    const defaultSelection = getDefaultModelSelection(effectiveSettings);
    const { projects, threads } = store;
    let projectsChanged = false;
    let threadsChanged = false;
    const nextProjects = projects.map((project) => {
      let next = project;

      if (
        !enabledProviders.includes(next.provider) &&
        enabledProviders.length > 0
      ) {
        next = {
          ...next,
          model:
            defaultSelection.model ||
            getDefaultModelForProvider(
              defaultSelection.provider,
              effectiveSettings,
            ),
          provider: defaultSelection.provider,
        };
        projectsChanged = true;
      }

      const providerModels = getModelsForProvider(
        next.provider,
        effectiveSettings,
      );
      const fallbackModel = getDefaultModelForProvider(
        next.provider,
        effectiveSettings,
      );

      if (
        !providerModels.includes(next.model) &&
        next.model !== fallbackModel
      ) {
        next = { ...next, model: fallbackModel };
        projectsChanged = true;
      }

      return next;
    });

    if (projectsChanged) {
      store.setProjects(nextProjects);
    }

    const nextThreads = threads.map((thread) => {
      let next = thread;
      const project = nextProjects.find((item) => item.id === thread.projectId);

      if (!project) {
        return next;
      }

      if (
        !enabledProviders.includes(next.provider) &&
        enabledProviders.length > 0
      ) {
        next = {
          ...next,
          model:
            defaultSelection.model ||
            getDefaultModelForProvider(
              defaultSelection.provider,
              effectiveSettings,
            ),
          provider: defaultSelection.provider,
        };
        threadsChanged = true;
      }

      const providerModels = getModelsForProvider(
        next.provider,
        effectiveSettings,
      );
      const fallbackModel = getDefaultModelForProvider(
        next.provider,
        effectiveSettings,
      );

      if (
        !providerModels.includes(next.model) &&
        next.model !== fallbackModel
      ) {
        next = { ...next, model: fallbackModel };
        threadsChanged = true;
      }

      return next;
    });

    if (threadsChanged) {
      useIdeStore.setState({ threads: nextThreads });
    }
  }, [settings]);

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="h-screen overflow-hidden text-foreground">
      {!appReady && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      )}
      <IdeHeader />

      <div className="h-[calc(100vh-88px)] overflow-hidden">
        {!stateHydrated ? null : (
          <div className="flex h-full" ref={horizontalPanelsRef}>
            {/* ─── LEFT: Projects sidebar ─── */}
            <div
              className="shrink-0 overflow-hidden"
              ref={leftPanelRef}
              style={{
                width: leftVisible ? leftWidthRef.current : 0,
                minWidth: leftVisible ? PROJECT_SIDEBAR_MIN_WIDTH_PX : 0,
                maxWidth: leftVisible ? getLeftPanelMaxWidth() : 0,
                opacity: leftVisible ? 1 : 0,
                paddingLeft: leftVisible ? 8 : 0,
                pointerEvents: leftVisible ? "auto" : "none",
                transition: PANEL_TRANSITION,
                willChange: "width, opacity, padding",
              }}
            >
              <div className="h-full pb-2">
                <ProjectSidebar />
              </div>
            </div>

            {/* Left resize handle */}
            {leftVisible && (middleVisible || rightVisible) && (
              <PanelResizeHandle
                side="right"
                onResizeStart={handleLeftResizeStart}
                onResize={handleLeftResize}
                onResizeEnd={handleResizeEnd}
              />
            )}

            {/* ─── MIDDLE: Chat + Terminal ─── */}
            <div
              className="min-w-0 flex-1"
              style={{
                minWidth: middleVisible ? CHAT_PANEL_MIN_WIDTH_PX : 0,
                display: middleVisible ? undefined : "none",
              }}
            >
              <div
                ref={middlePanelRef}
                className="flex h-full w-full flex-col rounded-lg"
              >
                {/* Chat area */}
                <div
                  className="min-h-0 flex-1"
                  style={{ minHeight: CHAT_PANEL_MIN_HEIGHT_PX }}
                >
                  {activeProject ? (
                    mountedThreads.length > 0 ? (
                      mountedThreads.map((thread) => {
                        const project = projectsById.get(thread.projectId);
                        if (!project) {
                          return null;
                        }

                        const isVisible =
                          thread.id === deferredActiveThreadId &&
                          thread.projectId === deferredActiveProjectId;

                        return (
                          <div
                            key={thread.id}
                            className={
                              isVisible
                                ? "flex h-full min-h-0 flex-col"
                                : "hidden"
                            }
                          >
                            <ChatPanel
                              isActive={isVisible}
                              project={project}
                              thread={thread}
                            />
                          </div>
                        );
                      })
                    ) : (
                      <div className="h-full p-3">
                        <AppShellPlaceholder message="Create a thread to start a separate conversation for this project." />
                      </div>
                    )
                  ) : (
                    <div className="h-full p-3">
                      <AppShellPlaceholder message="Select or add a project to start chatting with the AI assistant." />
                    </div>
                  )}
                </div>

                {/* Terminal area */}
                {terminalPanelVisible && activeProject ? (
                  <>
                    <PanelResizeHandle
                      onResize={handleTerminalResize}
                      onResizeEnd={handleTerminalResizeEnd}
                      onResizeStart={handleTerminalResizeStart}
                      side="top"
                    />
                    <div
                      ref={terminalPanelRef}
                      className="shrink-0 overflow-hidden"
                      style={{
                        height: terminalHeightRef.current,
                        minHeight: TERMINAL_PANEL_MIN_HEIGHT_PX,
                        maxHeight: `calc(100% - ${CHAT_PANEL_MIN_HEIGHT_PX + PANEL_RESIZE_HANDLE_SIZE_PX}px)`,
                      }}
                    >
                      <ProjectTerminalTabsPanel
                        key={activeProject.id}
                        projectId={activeProject.id}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </div>

            {/* Right resize handle — only when middle panel separates them */}
            {rightVisible && middleVisible && (
              <PanelResizeHandle
                side="left"
                onResizeStart={handleRightResizeStart}
                onResize={handleRightResize}
                onResizeEnd={handleResizeEnd}
              />
            )}

            {/* ─── RIGHT: Preview / Explorer ─── */}
            <div
              className={cn(
                middleVisible ? "overflow-hidden" : "min-w-0 overflow-hidden",
              )}
              ref={rightPanelRef}
              style={{
                ...(middleVisible
                  ? {
                      width: rightVisible ? rightWidthRef.current : 0,
                      minWidth: rightVisible ? PREVIEW_PANEL_MIN_WIDTH_PX : 0,
                      maxWidth: rightVisible ? getRightPanelMaxWidth() : 0,
                      flex: rightVisible ? "0 0 auto" : "0 0 0px",
                    }
                  : {
                      flex: rightVisible ? "1 1 0%" : "0 0 0px",
                      minWidth: rightVisible ? PREVIEW_PANEL_MIN_WIDTH_PX : 0,
                    }),
                opacity: rightVisible ? 1 : 0,
                paddingRight: rightVisible ? 8 : 0,
                paddingLeft: rightVisible && !middleVisible ? 8 : 0,
                pointerEvents: rightVisible ? "auto" : "none",
                transition: RIGHT_PANEL_TRANSITION,
                willChange: middleVisible
                  ? "width, opacity, padding"
                  : "flex-basis, opacity, padding",
              }}
            >
              <div
                className="h-full pb-2"
                style={{ minWidth: PREVIEW_PANEL_MIN_WIDTH_PX }}
              >
                <PreviewPanel
                  onSyncPreviewBounds={syncPreviewBounds}
                  previewHostRef={previewHostRef}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <IdeFooter />
      <SettingsDialog />
    </div>
  );
};
