"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Group,
  Panel,
  type PanelImperativeHandle,
} from "react-resizable-panels";
import { Spinner } from "@/components/ui/spinner";
import { getDesktopApi, hasDesktopApi } from "@/lib/electron";
import {
  getConnectedProviders,
  getDefaultModelForProvider,
  getModelsForProvider,
} from "@/lib/ide-defaults";
import {
  isModalPreviewHidden,
  useModalPreviewHidden,
} from "@/lib/modal-visibility";
import type { PreviewBounds } from "@/types/ide";
import { ChatPanel } from "./chat-panel";
import { IdeFooter, IdeHeader } from "./ide-header";
import { AppShellPlaceholder, ResizeHandle } from "./ide-helpers";
import { getThreadsForProject } from "./ide-state";
import { useIdeStore } from "./ide-store";
import {
  dedupeModels,
  getPreviewTerminalSessionId,
  TERMINAL_MIN_HEIGHT_PX,
} from "./ide-types";
import { PreviewPanel } from "./preview-panel";
import { ProjectSidebar } from "./projects-panel";
import { SettingsDialog } from "./settings-dialog";
import { ProjectTerminalTabsPanel } from "./terminal-panel";

const PROJECT_SIDEBAR_WIDTH_PX = 320;
const CHAT_PANEL_DEFAULT_WIDTH_PX = 760;
const CHAT_PANEL_MIN_WIDTH_PX = 400;
const PREVIEW_PANEL_DEFAULT_WIDTH_PX = 520;
const PREVIEW_PANEL_MIN_WIDTH_PX = 320;
const CHAT_PANEL_MIN_HEIGHT_PX = 180;
const EMPTY_TERMINAL_SESSION_IDS: string[] = [];

export const IdeShell = () => {
  // ── Store selectors ─────────────────────────────────────────────────
  const appReady = useIdeStore((s) => s.appReady);
  const setAppReady = useIdeStore((s) => s.setAppReady);
  const stateHydrated = useIdeStore((s) => s.stateHydrated);
  const panelVisibility = useIdeStore((s) => s.panelVisibility);
  const settings = useIdeStore((s) => s.settings);
  const settingsOpen = useIdeStore((s) => s.settingsOpen);
  const settingsSection = useIdeStore((s) => s.settingsSection);
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const activeThread = useIdeStore((s) => s.getActiveThread());
  const threads = useIdeStore((s) => s.threads);
  const threadSort = useIdeStore((s) => s.threadSort);
  const projectThreads = useMemo(
    () =>
      activeProject
        ? getThreadsForProject(threads, activeProject.id, threadSort)
        : [],
    [threads, activeProject, threadSort],
  );
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
  const middlePanelRef = useRef<PanelImperativeHandle | null>(null);
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

  // ── Effects ──────────────────────────────────────────────────────────

  // Detect macOS and Electron
  useEffect(() => {
    setIsMacOs(/mac/i.test(window.navigator.userAgent));
    setIsElectron(hasDesktopApi());
  }, [setIsMacOs, setIsElectron]);

  // Hydrate state from storage
  useEffect(() => {
    void hydrate();
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
    const terminalStatus = useIdeStore.getState().terminalStatus;

    if (!desktopApi) return;

    const isPreviewRunnerRunning = project
      ? terminalStatus[getPreviewTerminalSessionId(project.id)] === "running"
      : false;

    if (
      !project ||
      !pv.right ||
      !isPreviewRunnerRunning ||
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
    const anthropicSelectedModels = dedupeModels(prev.anthropicSelectedModels);
    const geminiSelectedModels = dedupeModels(prev.geminiSelectedModels);
    const defaultOpenAiModel = openAiSelectedModels.includes(
      prev.defaultOpenAiModel,
    )
      ? prev.defaultOpenAiModel
      : (openAiSelectedModels[0] ?? "");
    const defaultAnthropicModel = anthropicSelectedModels.includes(
      prev.defaultAnthropicModel,
    )
      ? prev.defaultAnthropicModel
      : (anthropicSelectedModels[0] ?? "");
    const defaultGeminiModel = geminiSelectedModels.includes(
      prev.defaultGeminiModel,
    )
      ? prev.defaultGeminiModel
      : (geminiSelectedModels[0] ?? "");

    const changed =
      safeConnectedProviders.length !== prev.connectedProviders.length ||
      !safeConnectedProviders.every(
        (p, i) => prev.connectedProviders[i] === p,
      ) ||
      defaultOpenAiModel !== prev.defaultOpenAiModel ||
      defaultAnthropicModel !== prev.defaultAnthropicModel ||
      defaultGeminiModel !== prev.defaultGeminiModel ||
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
        ...prev,
        anthropicSelectedModels,
        connectedProviders: safeConnectedProviders,
        defaultAnthropicModel,
        defaultGeminiModel,
        defaultOpenAiModel,
        geminiSelectedModels,
        openAiSelectedModels,
      });
    }

    // Fix projects whose provider/model is no longer valid
    const connectedProviders = safeConnectedProviders;
    const fallbackProvider = connectedProviders[0] ?? null;
    const { projects, threads } = store;
    let projectsChanged = false;
    let threadsChanged = false;
    const nextProjects = projects.map((project) => {
      let next = project;

      if (!connectedProviders.includes(next.provider) && fallbackProvider) {
        next = {
          ...next,
          model: getDefaultModelForProvider(fallbackProvider, store.settings),
          provider: fallbackProvider,
        };
        projectsChanged = true;
      }

      const providerModels = getModelsForProvider(
        next.provider,
        store.settings,
      );
      const fallbackModel = getDefaultModelForProvider(
        next.provider,
        store.settings,
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
      const project = projects.find((item) => item.id === thread.projectId);

      if (!project) {
        return next;
      }

      if (!connectedProviders.includes(next.provider) && fallbackProvider) {
        next = {
          ...next,
          model: getDefaultModelForProvider(fallbackProvider, store.settings),
          provider: fallbackProvider,
        };
        threadsChanged = true;
      }

      const providerModels = getModelsForProvider(
        next.provider,
        store.settings,
      );
      const fallbackModel = getDefaultModelForProvider(
        next.provider,
        store.settings,
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
  const mainWorkspaceVisible = panelVisibility.middle || panelVisibility.right;
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

  // Sync middle panel collapsed state with visibility toggle
  useEffect(() => {
    const panel = middlePanelRef.current;
    if (!panel) return;
    if (middleVisible) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [middleVisible]);

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
          <Group
            className="h-full"
            id="ide-root"
            orientation="horizontal"
            resizeTargetMinimumSize={{ coarse: 28, fine: 16 }}
          >
            {leftVisible ? (
              <Panel
                className="min-w-[100px] pl-2"
                defaultSize={PROJECT_SIDEBAR_WIDTH_PX}
                disabled
                id="ide-left"
                maxSize={PROJECT_SIDEBAR_WIDTH_PX}
                minSize={PROJECT_SIDEBAR_WIDTH_PX}
              >
                <ProjectSidebar />
              </Panel>
            ) : null}

            <Panel
              className="min-w-0"
              collapsedSize={0}
              collapsible
              defaultSize={middleVisible ? CHAT_PANEL_DEFAULT_WIDTH_PX : 0}
              id="ide-middle"
              minSize={CHAT_PANEL_MIN_WIDTH_PX}
              panelRef={middlePanelRef}
            >
              <div className="h-full">
                <div className="flex h-full w-full flex-col rounded-lg">
                  <Group
                    className="h-full"
                    id="ide-chat-term"
                    orientation="vertical"
                  >
                    <Panel
                      defaultSize={terminalPanelVisible ? 74 : 100}
                      id="ide-chat"
                      minSize={`${CHAT_PANEL_MIN_HEIGHT_PX}px`}
                    >
                      {activeProject ? (
                        projectThreads.length > 0 ? (
                          projectThreads.map((thread) => (
                            <div
                              key={thread.id}
                              className={
                                thread.id === activeThread?.id
                                  ? "flex h-full min-h-0 flex-col"
                                  : "hidden"
                              }
                            >
                              <ChatPanel
                                project={activeProject}
                                thread={thread}
                              />
                            </div>
                          ))
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
                    </Panel>

                    {terminalPanelVisible && activeProject ? (
                      <>
                        <ResizeHandle className="h-2" id="ide-term-handle" />
                        <Panel
                          defaultSize={26}
                          id="ide-terminal"
                          minSize={`${TERMINAL_MIN_HEIGHT_PX + 16}px`}
                        >
                          <ProjectTerminalTabsPanel
                            key={activeProject.id}
                            projectId={activeProject.id}
                          />
                        </Panel>
                      </>
                    ) : null}
                  </Group>
                </div>
              </div>
            </Panel>

            {middleVisible && rightVisible ? (
              <ResizeHandle className="w-px" id="ide-middle-handle" />
            ) : null}

            {rightVisible ? (
              <Panel
                className="min-w-0"
                defaultSize={PREVIEW_PANEL_DEFAULT_WIDTH_PX}
                id="ide-right"
                minSize={PREVIEW_PANEL_MIN_WIDTH_PX}
              >
                <div className="h-full pr-2 pb-4">
                  <PreviewPanel
                    onSyncPreviewBounds={syncPreviewBounds}
                    previewHostRef={previewHostRef}
                  />
                </div>
              </Panel>
            ) : null}

            {!mainWorkspaceVisible ? (
              <Panel defaultSize={100} id="ide-fallback" minSize={40}>
                <AppShellPlaceholder message="Enable the chat or preview panel from the top-right controls." />
              </Panel>
            ) : null}
          </Group>
        )}
      </div>

      <IdeFooter />
      <SettingsDialog />
    </div>
  );
};
