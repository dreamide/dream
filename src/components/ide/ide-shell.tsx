import { useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";
import { getDesktopApi, hasDesktopApi } from "@/lib/electron";
import {
  getConnectedProviders,
  getDefaultModelSelection,
  getDefaultModelForProvider,
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

const PROJECT_SIDEBAR_WIDTH_PX = 240;
const PROJECT_SIDEBAR_MIN_WIDTH_PX = 200;
const PROJECT_SIDEBAR_MAX_WIDTH_PX = 600;
const CHAT_PANEL_MIN_WIDTH_PX = 400;
const PREVIEW_PANEL_DEFAULT_WIDTH_PX = 520;
const PREVIEW_PANEL_MIN_WIDTH_PX = 320;
const CHAT_PANEL_MIN_HEIGHT_PX = 180;
const TERMINAL_PANEL_DEFAULT_HEIGHT_PX = 260;
const TERMINAL_PANEL_MIN_HEIGHT_PX = TERMINAL_MIN_HEIGHT_PX + 16;
const PANEL_RESIZE_HANDLE_SIZE_PX = 1;
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
  const settings = useIdeStore((s) => s.settings);
  const settingsOpen = useIdeStore((s) => s.settingsOpen);
  const settingsSection = useIdeStore((s) => s.settingsSection);
  const projects = useIdeStore((s) => s.projects);
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const activeThread = useIdeStore((s) => s.getActiveThread());
  const threads = useIdeStore((s) => s.threads);
  const streamingThreadIds = useIdeStore((s) => s.streamingThreadIds);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  // Defer the active thread ID so the sidebar highlights immediately while
  // the expensive chat panel re-render happens as a low-priority transition.
  const deferredActiveThreadId = useDeferredValue(activeThread?.id ?? null);
  const deferredActiveProjectId = useDeferredValue(activeProject?.id ?? null);

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
  const setProviderSetupTarget = useIdeStore((s) => s.setProviderSetupTarget);
  const appendTerminalOutput = useIdeStore((s) => s.appendTerminalOutput);
  const setTerminalStatus = useIdeStore((s) => s.setTerminalStatus);
  const setTerminalTransport = useIdeStore((s) => s.setTerminalTransport);
  const setTerminalShell = useIdeStore((s) => s.setTerminalShell);
  const setPreviewError = useIdeStore((s) => s.setPreviewError);
  const setPreviewLoading = useIdeStore((s) => s.setPreviewLoading);
  const refreshCodexLoginStatus = useIdeStore((s) => s.refreshCodexLoginStatus);
  const refreshProviderModels = useIdeStore((s) => s.refreshProviderModels);

  // ── Refs ─────────────────────────────────────────────────────────────
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const providerCredentialsRef = useRef({
    anthropicAccessToken: settings.anthropicAccessToken,
    anthropicAccessTokenExpiresAt: settings.anthropicAccessTokenExpiresAt,
    anthropicAuthMode: settings.anthropicAuthMode,
    anthropicApiKey: settings.anthropicApiKey,
    anthropicRefreshToken: settings.anthropicRefreshToken,
    geminiApiKey: settings.geminiApiKey,
    openAiApiKey: settings.openAiApiKey,
    openAiAuthMode: settings.openAiAuthMode,
  });

  // ── Resize state ────────────────────────────────────────────────────
  // Widths live in refs so drag handlers can mutate the DOM directly
  // without triggering React re-renders on every pointer-move.
  const leftWidthRef = useRef(PROJECT_SIDEBAR_WIDTH_PX);
  const rightWidthRef = useRef(PREVIEW_PANEL_DEFAULT_WIDTH_PX);
  const terminalHeightRef = useRef(TERMINAL_PANEL_DEFAULT_HEIGHT_PX);
  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const middlePanelRef = useRef<HTMLDivElement | null>(null);
  const terminalPanelRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);

  // Snapshot the width at drag-start so delta is always relative to that.
  const widthAtDragStart = useRef(0);
  const heightAtDragStart = useRef(0);

  const handleLeftResizeStart = useCallback(() => {
    widthAtDragStart.current = leftWidthRef.current;
    isDraggingRef.current = true;
    const el = leftPanelRef.current;
    if (el) el.style.transition = "none";
  }, []);

  const handleLeftResize = useCallback((deltaX: number) => {
    const next = Math.min(
      PROJECT_SIDEBAR_MAX_WIDTH_PX,
      Math.max(PROJECT_SIDEBAR_MIN_WIDTH_PX, widthAtDragStart.current + deltaX),
    );
    leftWidthRef.current = next;
    const el = leftPanelRef.current;
    if (el) el.style.width = `${next}px`;
  }, []);

  const handleRightResizeStart = useCallback(() => {
    widthAtDragStart.current = rightWidthRef.current;
    isDraggingRef.current = true;
    const el = rightPanelRef.current;
    if (el) el.style.transition = "none";
  }, []);

  const handleRightResize = useCallback((deltaX: number) => {
    const next = Math.max(
      PREVIEW_PANEL_MIN_WIDTH_PX,
      widthAtDragStart.current + deltaX,
    );
    rightWidthRef.current = next;
    const el = rightPanelRef.current;
    if (el) el.style.width = `${next}px`;
  }, []);

  const handleResizeEnd = useCallback(() => {
    isDraggingRef.current = false;
    // Restore transitions (must match the React style prop exactly so that
    // React's reconciler stays in sync with the DOM).
    const left = leftPanelRef.current;
    if (left) left.style.transition = PANEL_TRANSITION;
    const right = rightPanelRef.current;
    if (right) right.style.transition = RIGHT_PANEL_TRANSITION;
  }, []);

  const handleTerminalResizeStart = useCallback(() => {
    heightAtDragStart.current =
      terminalPanelRef.current?.getBoundingClientRect().height ??
      terminalHeightRef.current;
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
        heightAtDragStart.current + deltaY,
      ),
    );

    terminalHeightRef.current = next;
    const el = terminalPanelRef.current;
    if (el) {
      el.style.height = `${next}px`;
    }
  }, []);

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
    const { settings: s } = useIdeStore.getState();
    void refreshProviderModels({
      anthropicAccessToken: s.anthropicAccessToken,
      anthropicAccessTokenExpiresAt: s.anthropicAccessTokenExpiresAt,
      anthropicAuthMode: s.anthropicAuthMode,
      anthropicApiKey: s.anthropicApiKey,
      anthropicRefreshToken: s.anthropicRefreshToken,
      geminiApiKey: s.geminiApiKey,
      openAiApiKey: s.openAiApiKey,
      openAiAuthMode: s.openAiAuthMode,
    });
    if (s.openAiAuthMode === "codex") {
      void refreshCodexLoginStatus();
    }
    setAppReady(true);
  }, [
    stateHydrated,
    setAppReady,
    refreshProviderModels,
    refreshCodexLoginStatus,
  ]);

  // Subscribe to persisted state changes for auto-persistence (debounced)
  useEffect(() => {
    let prev = {
      activeProjectId: useIdeStore.getState().activeProjectId,
      activeThreadIdByProject: useIdeStore.getState().activeThreadIdByProject,
      chats: useIdeStore.getState().chats,
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
      setPreviewLoading(event.projectId, event.loading);
      if (!event.loading) {
        return;
      }

      setPreviewError(null);
    });

    return () => {
      removeTerminalData();
      removeTerminalStatus();
      removePreviewError();
      removePreviewStatus();
    };
  }, [
    appendTerminalOutput,
    setTerminalStatus,
    setTerminalTransport,
    setTerminalShell,
    setPreviewError,
    setPreviewLoading,
  ]);

  // Preview bounds sync
  const syncPreviewBounds = useCallback((reload = false) => {
    const desktopApi = getDesktopApi();
    const project = useIdeStore.getState().getActiveProject();
    const pv = useIdeStore.getState().panelVisibility;
    const currentRightPanelView = useIdeStore.getState().rightPanelView;

    if (!desktopApi) return;

    if (
      !project ||
      !project.previewUrl ||
      !pv.right ||
      currentRightPanelView !== "preview" ||
      isModalPreviewHidden()
    ) {
      desktopApi.updatePreview({
        projectId: project?.id,
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

    desktopApi.updatePreview({
      bounds,
      projectId: project.id,
      reload,
      url: project.previewUrl,
      visible: true,
    });
  }, []);

  // Preview resize observer
  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    const update = () => syncPreviewBounds();
    const observer = new ResizeObserver(update);
    if (previewHostRef.current) {
      observer.observe(previewHostRef.current);
    }

    window.addEventListener("resize", update);
    const frame = window.requestAnimationFrame(update);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [syncPreviewBounds]);

  // Sync preview bounds when project or panel visibility changes
  useEffect(() => {
    if (!panelVisibility.right && !activeProject) {
      syncPreviewBounds();
      return;
    }

    syncPreviewBounds();
  }, [activeProject, panelVisibility.right, syncPreviewBounds]);

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

  // Keep credentials ref in sync
  useEffect(() => {
    providerCredentialsRef.current = {
      anthropicAccessToken: settings.anthropicAccessToken,
      anthropicAccessTokenExpiresAt: settings.anthropicAccessTokenExpiresAt,
      anthropicAuthMode: settings.anthropicAuthMode,
      anthropicApiKey: settings.anthropicApiKey,
      anthropicRefreshToken: settings.anthropicRefreshToken,
      geminiApiKey: settings.geminiApiKey,
      openAiApiKey: settings.openAiApiKey,
      openAiAuthMode: settings.openAiAuthMode,
    };
  }, [
    settings.anthropicAccessToken,
    settings.anthropicAccessTokenExpiresAt,
    settings.anthropicAuthMode,
    settings.anthropicApiKey,
    settings.anthropicRefreshToken,
    settings.geminiApiKey,
    settings.openAiApiKey,
    settings.openAiAuthMode,
  ]);

  // Auto-refresh models when settings panel opens
  useEffect(() => {
    if (
      !settingsOpen ||
      (settingsSection !== "providers" && settingsSection !== "models")
    ) {
      return;
    }
    const creds = providerCredentialsRef.current;
    void refreshProviderModels(creds);
    if (creds.openAiAuthMode === "codex") {
      void refreshCodexLoginStatus();
    }
  }, [
    refreshCodexLoginStatus,
    refreshProviderModels,
    settingsOpen,
    settingsSection,
  ]);

  // Reset provider setup target when leaving providers section
  useEffect(() => {
    if (!settingsOpen || settingsSection !== "providers") {
      setProviderSetupTarget(null);
    }
  }, [settingsOpen, settingsSection, setProviderSetupTarget]);

  // Sync settings integrity (dedupe models, fix connected providers)
  useEffect(() => {
    const store = useIdeStore.getState();
    const prev = settings;

    const safeConnectedProviders = getConnectedProviders(prev);
    const openAiSelectedModels = dedupeModels(prev.openAiSelectedModels);
    const anthropicSelectedModels = dedupeModels(
      prev.anthropicSelectedModels.map(normalizeClaudeCodeModelId),
    );
    const geminiSelectedModels = dedupeModels(prev.geminiSelectedModels);
    const nextSettings = {
      ...prev,
      anthropicSelectedModels,
      connectedProviders: safeConnectedProviders,
      geminiSelectedModels,
      openAiSelectedModels,
    };
    const defaultModel = getPreferredDefaultModel(nextSettings);

    const changed =
      safeConnectedProviders.length !== prev.connectedProviders.length ||
      !safeConnectedProviders.every(
        (p, i) => prev.connectedProviders[i] === p,
      ) ||
      defaultModel !== prev.defaultModel ||
      openAiSelectedModels.length !== prev.openAiSelectedModels.length ||
      anthropicSelectedModels.length !== prev.anthropicSelectedModels.length ||
      geminiSelectedModels.length !== prev.geminiSelectedModels.length ||
      !openAiSelectedModels.every(
        (m, i) => prev.openAiSelectedModels[i] === m,
      ) ||
      !anthropicSelectedModels.every(
        (m, i) => prev.anthropicSelectedModels[i] === m,
      ) ||
      !geminiSelectedModels.every((m, i) => prev.geminiSelectedModels[i] === m);

    if (changed) {
      store.setSettings({
        ...nextSettings,
        defaultModel,
      });
    }

    // Fix projects whose provider/model is no longer valid
    const connectedProviders = safeConnectedProviders;
    const effectiveSettings = { ...nextSettings, defaultModel };
    const defaultSelection = getDefaultModelSelection(effectiveSettings);
    const { projects, threads } = store;
    let projectsChanged = false;
    let threadsChanged = false;
    const nextProjects = projects.map((project) => {
      let next = project;

      if (!connectedProviders.includes(next.provider) && connectedProviders.length > 0) {
        next = {
          ...next,
          model:
            defaultSelection.model ||
            getDefaultModelForProvider(defaultSelection.provider, effectiveSettings),
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

      if (!connectedProviders.includes(next.provider) && connectedProviders.length > 0) {
        next = {
          ...next,
          model:
            defaultSelection.model ||
            getDefaultModelForProvider(defaultSelection.provider, effectiveSettings),
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

  // ── Derived values ──────────────────────────────────────────────────
  const leftVisible = panelVisibility.left;
  const middleVisible = panelVisibility.middle;
  const rightVisible = panelVisibility.right;
  const projectTerminalSessionIds = useIdeStore(
    (s) => s.projectTerminalSessionIds,
  );
  const activeProjectTerminalSessionIds = activeProject
    ? (projectTerminalSessionIds[activeProject.id] ??
      EMPTY_TERMINAL_SESSION_IDS)
    : EMPTY_TERMINAL_SESSION_IDS;
  const terminalPanelVisible = activeProjectTerminalSessionIds.length > 0;

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
          <div className="flex h-full">
            {/* ─── LEFT: Projects sidebar ─── */}
            <div
              className="shrink-0 overflow-hidden"
              ref={leftPanelRef}
              style={{
                width: leftVisible ? leftWidthRef.current : 0,
                minWidth: leftVisible ? PROJECT_SIDEBAR_MIN_WIDTH_PX : 0,
                maxWidth: leftVisible ? PROJECT_SIDEBAR_MAX_WIDTH_PX : 0,
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
