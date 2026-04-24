import { useCallback, useEffect, useMemo, useRef } from "react";
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
  isModalBrowserHidden,
  useModalBrowserHidden,
} from "@/lib/modal-visibility";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { BrowserBounds } from "@/types/ide";
import { BrowserPanel } from "./browser-panel";
import { ChatPanel } from "./chat-panel";
import { IdeHeader } from "./ide-header";
import { AppShellPlaceholder, PanelResizeHandle } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { dedupeModels, TERMINAL_MIN_HEIGHT_PX } from "./ide-types";
import { SettingsDialog } from "./settings-dialog";
import { ProjectTerminalTabsPanel } from "./terminal-panel";

const CHAT_PANEL_MIN_WIDTH_PX = 400;
const BROWSER_PANEL_DEFAULT_WIDTH_PX = DEFAULT_PANEL_SIZES.rightPanelWidth;
const BROWSER_PANEL_MIN_WIDTH_PX = 320;
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
const TERMINAL_PANEL_TRANSITION = `height ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), min-height ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;

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
  const activeChat = useIdeStore((s) => s.getActiveChat());
  const chats = useIdeStore((s) => s.chats);
  const streamingChatIds = useIdeStore((s) => s.streamingChatIds);
  const browserTabsByProject = useIdeStore((s) => s.browserTabsByProject);
  const activeBrowserTabIdByProject = useIdeStore(
    (s) => s.activeBrowserTabIdByProject,
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const activeChatId = activeChat?.id ?? null;
  const activeProjectId = activeProject?.id ?? null;
  const activeBrowserTab =
    activeProject?.id != null
      ? ((browserTabsByProject[activeProject.id] ?? []).find(
          (tab) =>
            tab.id ===
            (activeBrowserTabIdByProject[activeProject.id] ??
              browserTabsByProject[activeProject.id]?.[0]?.id ??
              null),
        ) ??
        (browserTabsByProject[activeProject.id] ?? [])[0] ??
        null)
      : null;

  const mountedChats = useMemo(() => {
    const mountedChatIds = new Set<string>();
    const nextChats = [] as typeof chats;

    if (activeChatId) {
      const activeMountedChat = chats.find((chat) => chat.id === activeChatId);
      if (activeMountedChat) {
        mountedChatIds.add(activeMountedChat.id);
        nextChats.push(activeMountedChat);
      }
    }

    // Keep streaming chats mounted.
    for (const chat of chats) {
      if (!streamingChatIds[chat.id] || mountedChatIds.has(chat.id)) {
        continue;
      }

      mountedChatIds.add(chat.id);
      nextChats.push(chat);
    }

    return nextChats;
  }, [activeChatId, chats, streamingChatIds]);
  const modalBrowserHidden = useModalBrowserHidden();

  const hydrate = useIdeStore((s) => s.hydrate);
  const setIsMacOs = useIdeStore((s) => s.setIsMacOs);
  const setIsElectron = useIdeStore((s) => s.setIsElectron);
  const appendTerminalOutput = useIdeStore((s) => s.appendTerminalOutput);
  const setTerminalStatus = useIdeStore((s) => s.setTerminalStatus);
  const setTerminalTransport = useIdeStore((s) => s.setTerminalTransport);
  const setTerminalShell = useIdeStore((s) => s.setTerminalShell);
  const setBrowserError = useIdeStore((s) => s.setBrowserError);
  const setBrowserLoading = useIdeStore((s) => s.setBrowserLoading);
  const updateBrowserTab = useIdeStore((s) => s.updateBrowserTab);
  const refreshProviderModels = useIdeStore((s) => s.refreshProviderModels);
  const setPanelSizes = useIdeStore((s) => s.setPanelSizes);
  const projectTerminalSessionIds = useIdeStore(
    (s) => s.projectTerminalSessionIds,
  );
  const projectTerminalPanelOpen = useIdeStore(
    (s) => s.projectTerminalPanelOpen,
  );

  // ── Derived values ──────────────────────────────────────────────────
  const middleVisible = panelVisibility.middle;
  const rightVisible = panelVisibility.right;
  const activeProjectTerminalSessionIds = activeProject
    ? (projectTerminalSessionIds[activeProject.id] ??
      EMPTY_TERMINAL_SESSION_IDS)
    : EMPTY_TERMINAL_SESSION_IDS;
  const hasActiveProjectTerminalSessions =
    activeProjectTerminalSessionIds.length > 0;
  const terminalPanelVisible =
    projectTerminalPanelOpen && hasActiveProjectTerminalSessions;

  // ── Refs ─────────────────────────────────────────────────────────────
  const browserHostRef = useRef<HTMLDivElement | null>(null);
  // ── Resize state ────────────────────────────────────────────────────
  // Widths live in refs so drag handlers can mutate the DOM directly
  // without triggering React re-renders on every pointer-move.
  const rightWidthRef = useRef(BROWSER_PANEL_DEFAULT_WIDTH_PX);
  const terminalHeightRef = useRef(TERMINAL_PANEL_DEFAULT_HEIGHT_PX);
  const horizontalPanelsRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const middlePanelRef = useRef<HTMLDivElement | null>(null);
  const terminalPanelWrapperRef = useRef<HTMLDivElement | null>(null);
  const terminalPanelRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);

  if (!isDraggingRef.current) {
    rightWidthRef.current = panelSizes.rightPanelWidth;
    terminalHeightRef.current = panelSizes.terminalHeight;
  }

  const getHorizontalChromeWidth = useCallback(() => {
    const rightHandleWidth =
      rightVisible && middleVisible ? PANEL_RESIZE_HANDLE_SIZE_PX : 0;
    const rightPadding = rightVisible ? PANEL_EDGE_PADDING_PX : 0;

    return rightHandleWidth + rightPadding;
  }, [middleVisible, rightVisible]);

  const getRightPanelMaxWidth = useCallback(() => {
    if (!rightVisible || !middleVisible) {
      return Number.POSITIVE_INFINITY;
    }

    const containerWidth =
      horizontalPanelsRef.current?.getBoundingClientRect().width ?? 0;
    const availableWidth =
      containerWidth - getHorizontalChromeWidth() - CHAT_PANEL_MIN_WIDTH_PX;

    return Math.max(BROWSER_PANEL_MIN_WIDTH_PX, availableWidth);
  }, [getHorizontalChromeWidth, middleVisible, rightVisible]);

  const syncHorizontalPanelWidths = useCallback(() => {
    if (rightVisible && middleVisible) {
      const maxRightWidth = getRightPanelMaxWidth();
      const nextRightWidth = Math.min(
        maxRightWidth,
        Math.max(BROWSER_PANEL_MIN_WIDTH_PX, rightWidthRef.current),
      );
      rightWidthRef.current = nextRightWidth;

      const rightPanel = rightPanelRef.current;
      if (rightPanel) {
        rightPanel.style.width = `${nextRightWidth}px`;
        rightPanel.style.maxWidth = `${maxRightWidth}px`;
      }
    }
  }, [getRightPanelMaxWidth, middleVisible, rightVisible]);

  const handleRightResizeStart = useCallback(() => {
    isDraggingRef.current = true;
    const el = rightPanelRef.current;
    if (el) el.style.transition = "none";
  }, []);

  const handleRightResize = useCallback(
    (deltaX: number) => {
      const maxRightWidth = getRightPanelMaxWidth();
      const next = Math.max(
        BROWSER_PANEL_MIN_WIDTH_PX,
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
    const right = rightPanelRef.current;
    if (right) right.style.transition = RIGHT_PANEL_TRANSITION;
    setPanelSizes((current) => ({
      ...current,
      rightPanelWidth: rightWidthRef.current,
    }));
  }, [setPanelSizes]);

  const handleTerminalResizeStart = useCallback(() => {
    const wrapper = terminalPanelWrapperRef.current;
    if (wrapper) {
      wrapper.style.transition = "none";
    }

    const el = terminalPanelRef.current;
    if (!el) {
      return;
    }

    el.style.transition = "none";
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
    const wrapper = terminalPanelWrapperRef.current;
    if (wrapper) {
      wrapper.style.height = `${next + PANEL_RESIZE_HANDLE_SIZE_PX}px`;
    }

    const el = terminalPanelRef.current;
    if (el) {
      el.style.height = `${next}px`;
    }
  }, []);

  const handleTerminalResizeEnd = useCallback(() => {
    const wrapper = terminalPanelWrapperRef.current;
    if (wrapper) {
      wrapper.style.transition = TERMINAL_PANEL_TRANSITION;
    }

    const el = terminalPanelRef.current;
    if (el) {
      el.style.transition = TERMINAL_PANEL_TRANSITION;
    }

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
      activeChatIdByProject: useIdeStore.getState().activeChatIdByProject,
      chats: useIdeStore.getState().chats,
      closedProjects: useIdeStore.getState().closedProjects,
      messagesByChatId: useIdeStore.getState().messagesByChatId,
      panelSizes: useIdeStore.getState().panelSizes,
      panelVisibility: useIdeStore.getState().panelVisibility,
      projects: useIdeStore.getState().projects,
      settings: useIdeStore.getState().settings,
      chatSort: useIdeStore.getState().chatSort,
    };
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const unsub = useIdeStore.subscribe((state) => {
      const next = {
        activeProjectId: state.activeProjectId,
        activeChatIdByProject: state.activeChatIdByProject,
        chats: state.chats,
        closedProjects: state.closedProjects,
        messagesByChatId: state.messagesByChatId,
        panelSizes: state.panelSizes,
        panelVisibility: state.panelVisibility,
        projects: state.projects,
        settings: state.settings,
        chatSort: state.chatSort,
      };

      if (
        next.activeProjectId !== prev.activeProjectId ||
        next.activeChatIdByProject !== prev.activeChatIdByProject ||
        next.chats !== prev.chats ||
        next.closedProjects !== prev.closedProjects ||
        next.messagesByChatId !== prev.messagesByChatId ||
        next.panelSizes !== prev.panelSizes ||
        next.panelVisibility !== prev.panelVisibility ||
        next.projects !== prev.projects ||
        next.settings !== prev.settings ||
        next.chatSort !== prev.chatSort
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

    const removeBrowserError = desktopApi.onBrowserError((event) => {
      setBrowserError(
        `${String(event.code)}${event.description ? `: ${event.description}` : ""}`,
      );
    });

    const removeBrowserStatus = desktopApi.onBrowserStatus((event) => {
      setBrowserLoading(event.tabId ?? event.projectId, event.loading);
      if (!event.loading) {
        return;
      }

      setBrowserError(null);
    });

    const removeBrowserPageState = desktopApi.onBrowserPageState((event) => {
      updateBrowserTab(event.projectId, event.tabId, (tab) => ({
        ...tab,
        canGoBack: event.canGoBack,
        canGoForward: event.canGoForward,
        title: event.title || tab.title,
        url: event.url || tab.url,
      }));

      const state = useIdeStore.getState();
      const activeTabId =
        state.activeBrowserTabIdByProject[event.projectId] ?? null;
      if (activeTabId !== event.tabId || !event.url) {
        return;
      }

      const project = state.projects.find(
        (item) => item.id === event.projectId,
      );
      if (!project || project.browserUrl === event.url) {
        return;
      }

      state.updateProject(event.projectId, (currentProject) => ({
        ...currentProject,
        browserUrl: event.url,
      }));
    });

    return () => {
      removeTerminalData();
      removeTerminalStatus();
      removeBrowserError();
      removeBrowserPageState();
      removeBrowserStatus();
    };
  }, [
    appendTerminalOutput,
    setTerminalStatus,
    setTerminalTransport,
    setTerminalShell,
    setBrowserError,
    setBrowserLoading,
    updateBrowserTab,
  ]);

  // Browser bounds sync
  const lastSentBrowserUrlRef = useRef<string | null>(null);
  const lastSentBrowserTabIdRef = useRef<string | null>(null);
  const syncBrowserBounds = useCallback((reload = false) => {
    const desktopApi = getDesktopApi();
    const state = useIdeStore.getState();
    const project = state.getActiveProject();
    const pv = state.panelVisibility;
    const currentRightPanelView = state.rightPanelView;
    const activeTab = project ? state.getActiveBrowserTab(project.id) : null;

    if (!desktopApi) return;

    if (
      !project ||
      !activeTab?.url ||
      !pv.right ||
      currentRightPanelView !== "browser" ||
      isModalBrowserHidden()
    ) {
      lastSentBrowserUrlRef.current = null;
      lastSentBrowserTabIdRef.current = null;
      desktopApi.updateBrowser({
        projectId: project?.id,
        tabId: activeTab?.id,
        visible: false,
      });
      return;
    }

    const host = browserHostRef.current;
    if (!host) return;

    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      desktopApi.updateBrowser({
        projectId: project.id,
        tabId: activeTab.id,
        visible: false,
      });
      return;
    }

    const bounds: BrowserBounds = {
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };

    // Send the URL when it changed, when the tab changed, or on explicit
    // reload.  This prevents ResizeObserver / effect-driven calls from
    // causing redundant navigations in the Electron BrowserView.
    const urlChanged = activeTab.url !== lastSentBrowserUrlRef.current;
    const tabChanged = activeTab.id !== lastSentBrowserTabIdRef.current;
    const sendUrl = reload || urlChanged || tabChanged;
    if (sendUrl) {
      lastSentBrowserUrlRef.current = activeTab.url;
      lastSentBrowserTabIdRef.current = activeTab.id;
    }

    desktopApi.updateBrowser({
      bounds,
      projectId: project.id,
      tabId: activeTab.id,
      ...(reload ? { reload: true } : {}),
      ...(sendUrl ? { url: activeTab.url } : {}),
      visible: true,
    });
  }, []);

  // Browser resize observer
  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    const update = () => syncBrowserBounds();
    const observer = new ResizeObserver(update);
    const host = browserHostRef.current;
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
  }, [syncBrowserBounds]);

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

  // Sync browser bounds when project or panel visibility changes
  useEffect(() => {
    void activeProject;
    void panelVisibility.right;
    void rightPanelView;
    void activeBrowserTab?.id;
    void activeBrowserTab?.url;
    syncBrowserBounds();
  }, [
    activeBrowserTab?.id,
    activeBrowserTab?.url,
    activeProject,
    panelVisibility.right,
    rightPanelView,
    syncBrowserBounds,
  ]);

  // Keep the browser hidden while any modal is open or finishing its exit animation.
  useEffect(() => {
    if (modalBrowserHidden) {
      syncBrowserBounds();
      return;
    }

    syncBrowserBounds();
  }, [modalBrowserHidden, syncBrowserBounds]);

  // Browser cleanup on unmount
  useEffect(() => {
    return () => {
      const desktopApi = getDesktopApi();
      if (!desktopApi) return;
      desktopApi.updateBrowser({ visible: false });
    };
  }, []);

  // Auto-refresh models when settings panel opens
  useEffect(() => {
    if (!settingsOpen || settingsSection !== "providers") {
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
    const { chats, projects } = store;
    let projectsChanged = false;
    let chatsChanged = false;
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

    const nextChats = chats.map((chat) => {
      let next = chat;
      const project = nextProjects.find((item) => item.id === chat.projectId);

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
        chatsChanged = true;
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
        chatsChanged = true;
      }

      return next;
    });

    if (chatsChanged) {
      useIdeStore.setState({ chats: nextChats });
    }
  }, [settings]);

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-muted/50 text-foreground">
      {!appReady && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      )}
      <IdeHeader />

      <div className="min-h-0 flex-1 overflow-hidden">
        {!stateHydrated ? null : (
          <div className="flex h-full" ref={horizontalPanelsRef}>
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
                    mountedChats.length > 0 ? (
                      mountedChats.map((chat) => {
                        const project = projectsById.get(chat.projectId);
                        if (!project) {
                          return null;
                        }

                        const isVisible =
                          chat.id === activeChatId &&
                          chat.projectId === activeProjectId;

                        return (
                          <div
                            aria-hidden={!isVisible}
                            inert={!isVisible}
                            key={chat.id}
                            className={
                              isVisible
                                ? "flex h-full min-h-0 flex-col"
                                : "hidden"
                            }
                          >
                            <ChatPanel
                              isActive={isVisible}
                              project={project}
                              chat={chat}
                            />
                          </div>
                        );
                      })
                    ) : (
                      <div className="h-full p-3">
                        <AppShellPlaceholder message="Create a chat to start a separate conversation for this project." />
                      </div>
                    )
                  ) : (
                    <div className="h-full p-3">
                      <AppShellPlaceholder message="Select or add a project to start chatting with the AI assistant." />
                    </div>
                  )}
                </div>

                {/* Terminal area */}
                {activeProject && hasActiveProjectTerminalSessions ? (
                  <div
                    ref={terminalPanelWrapperRef}
                    className="shrink-0 overflow-hidden"
                    style={{
                      height: terminalPanelVisible
                        ? terminalHeightRef.current +
                          PANEL_RESIZE_HANDLE_SIZE_PX
                        : 0,
                      maxHeight: `calc(100% - ${CHAT_PANEL_MIN_HEIGHT_PX}px)`,
                      opacity: terminalPanelVisible ? 1 : 0,
                      pointerEvents: terminalPanelVisible ? "auto" : "none",
                      transition: TERMINAL_PANEL_TRANSITION,
                      willChange: "height, opacity",
                    }}
                  >
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
                        height: terminalPanelVisible
                          ? terminalHeightRef.current
                          : 0,
                        minHeight: terminalPanelVisible
                          ? TERMINAL_PANEL_MIN_HEIGHT_PX
                          : 0,
                        maxHeight: `calc(100% - ${PANEL_RESIZE_HANDLE_SIZE_PX}px)`,
                        transition: TERMINAL_PANEL_TRANSITION,
                        willChange: "height, opacity",
                      }}
                    >
                      <ProjectTerminalTabsPanel
                        key={activeProject.id}
                        projectId={activeProject.id}
                      />
                    </div>
                  </div>
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

            {/* ─── RIGHT: Browser / Explorer ─── */}
            <div
              className={cn(
                middleVisible ? "overflow-hidden" : "min-w-0 overflow-hidden",
              )}
              ref={rightPanelRef}
              style={{
                ...(middleVisible
                  ? {
                      width: rightVisible ? rightWidthRef.current : 0,
                      minWidth: rightVisible ? BROWSER_PANEL_MIN_WIDTH_PX : 0,
                      maxWidth: rightVisible ? getRightPanelMaxWidth() : 0,
                      flex: rightVisible ? "0 0 auto" : "0 0 0px",
                    }
                  : {
                      flex: rightVisible ? "1 1 0%" : "0 0 0px",
                      minWidth: rightVisible ? BROWSER_PANEL_MIN_WIDTH_PX : 0,
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
                style={{ minWidth: BROWSER_PANEL_MIN_WIDTH_PX }}
              >
                <BrowserPanel
                  onSyncBrowserBounds={syncBrowserBounds}
                  browserHostRef={browserHostRef}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <SettingsDialog />
    </div>
  );
};
