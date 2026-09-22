import { lazy, Suspense, useDeferredValue, useEffect, useState } from "react";
import { AppLoadingScreen } from "@/components/dream-loading-screen";
import { getDesktopApi, hasDesktopApi } from "@/lib/electron";
import {
  getConnectedProviders,
  getDefaultModelForProvider,
  getDefaultModelSelection,
  getModelsForProvider,
  normalizeClaudeCodeModelId,
  normalizeDefaultModelSettings,
} from "@/lib/ide-defaults";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import { ChatRuntimeHost } from "./chat/chat-runtime-host";
import { EmptyProjectWorkspace } from "./empty-project-workspace";
import { ActivityInbox } from "./header/activity-inbox";
import { IdeHeader } from "./ide-header";
import { areProjectListsEqualExceptLastUsedAt } from "./ide-state";
import { useIdeStore } from "./ide-store";
import { dedupeModels } from "./ide-types";
import { ProjectWorkspace } from "./project-workspace";
import { savePersistedActiveProject } from "./store/ide-store-persistence";
import {
  hasTerminalScrollback,
  publishTerminalOutput,
} from "./terminal-scrollback";

const TasksWorkspace = lazy(() =>
  import("./workspaces/tasks-workspace").then((module) => ({
    default: module.TasksWorkspace,
  })),
);

const SettingsDialog = lazy(() =>
  import("./settings-dialog").then((module) => ({
    default: module.SettingsDialog,
  })),
);

export const IdeShell = () => {
  // ── Store selectors ─────────────────────────────────────────────────
  const appReady = useIdeStore((s) => s.appReady);
  const setAppReady = useIdeStore((s) => s.setAppReady);
  const stateHydrated = useIdeStore((s) => s.stateHydrated);
  const projects = useIdeStore((s) => s.projects);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const deferredActiveProjectId = useDeferredValue(activeProjectId);
  const renderedActiveProjectId =
    activeProjectId !== null &&
    projects.some((project) => project.id === deferredActiveProjectId)
      ? deferredActiveProjectId
      : activeProjectId;
  const tasksSelected = useIdeStore((s) => s.appView === "tasks");
  const [tasksVisited, setTasksVisited] = useState(false);
  if (tasksSelected && !tasksVisited) {
    setTasksVisited(true);
  }
  const settings = useIdeStore((s) => s.settings);
  const settingsOpen = useIdeStore((s) => s.settingsOpen);
  const settingsSection = useIdeStore((s) => s.settingsSection);

  const hydrate = useIdeStore((s) => s.hydrate);
  const setIsMacOs = useIdeStore((s) => s.setIsMacOs);
  const setIsElectron = useIdeStore((s) => s.setIsElectron);
  const setTerminalStatus = useIdeStore((s) => s.setTerminalStatus);
  const setTerminalTransport = useIdeStore((s) => s.setTerminalTransport);
  const setTerminalShell = useIdeStore((s) => s.setTerminalShell);
  const setBrowserError = useIdeStore((s) => s.setBrowserError);
  const refreshProviderModels = useIdeStore((s) => s.refreshProviderModels);

  // ── Effects ─────────────────────────────────────────────────────────

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

  // Dev-only: log main-thread stalls (>=100ms) so interaction delays (e.g.
  // slow tab switches) can be attributed instead of guessed at.
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (typeof PerformanceObserver === "undefined") return;

    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 100) {
            console.warn(
              `[perf] main thread blocked for ${Math.round(entry.duration)}ms`,
            );
          }
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // longtask entries unsupported — nothing to observe.
    }

    return () => observer?.disconnect();
  }, []);

  // Mark app ready once hydration completes, and auto-refresh models
  useEffect(() => {
    if (!stateHydrated) return;
    void refreshProviderModels();
    setAppReady(true);
  }, [stateHydrated, setAppReady, refreshProviderModels]);

  useEffect(() => {
    if (!appReady) return;
    document.querySelector(".boot-loading")?.remove();
  }, [appReady]);

  // Subscribe to persisted state changes for auto-persistence (debounced)
  useEffect(() => {
    let prev = {
      activeProjectId: useIdeStore.getState().activeProjectId,
      activeBrowserTabIdByProject:
        useIdeStore.getState().activeBrowserTabIdByProject,
      appView: useIdeStore.getState().appView,
      tasks: useIdeStore.getState().tasks,
      tasksProjectId: useIdeStore.getState().tasksProjectId,
      tasksChatPanelWidth: useIdeStore.getState().tasksChatPanelWidth,
      taskConfig: useIdeStore.getState().taskConfig,
      browserTabsByProject: useIdeStore.getState().browserTabsByProject,
      chatSort: useIdeStore.getState().chatSort,
      chats: useIdeStore.getState().chats,
      closedProjects: useIdeStore.getState().closedProjects,
      projects: useIdeStore.getState().projects,
      settings: useIdeStore.getState().settings,
    };
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let persistIdleCallback: number | null = null;
    let persistPending = false;
    let observedStateHydrated = useIdeStore.getState().stateHydrated;

    const cancelScheduledPersist = () => {
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (persistIdleCallback !== null) {
        cancelIdleCallback(persistIdleCallback);
        persistIdleCallback = null;
      }
    };
    const flushPendingPersist = () => {
      cancelScheduledPersist();
      if (persistPending) {
        persistPending = false;
        useIdeStore.getState().persist();
      }
    };

    // Reload tears down the document without running React effect cleanup.
    window.addEventListener("beforeunload", flushPendingPersist);
    window.addEventListener("pagehide", flushPendingPersist);

    const unsub = useIdeStore.subscribe((state) => {
      const next = {
        activeProjectId: state.activeProjectId,
        activeBrowserTabIdByProject: state.activeBrowserTabIdByProject,
        appView: state.appView,
        tasks: state.tasks,
        tasksProjectId: state.tasksProjectId,
        tasksChatPanelWidth: state.tasksChatPanelWidth,
        taskConfig: state.taskConfig,
        browserTabsByProject: state.browserTabsByProject,
        chatSort: state.chatSort,
        chats: state.chats,
        closedProjects: state.closedProjects,
        projects: state.projects,
        settings: state.settings,
      };

      if (!observedStateHydrated && state.stateHydrated) {
        observedStateHydrated = true;
        prev = next;
        return;
      }

      if (
        next.activeProjectId !== prev.activeProjectId ||
        next.activeBrowserTabIdByProject !== prev.activeBrowserTabIdByProject ||
        next.browserTabsByProject !== prev.browserTabsByProject ||
        next.chats !== prev.chats ||
        next.closedProjects !== prev.closedProjects ||
        next.projects !== prev.projects ||
        next.settings !== prev.settings ||
        next.chatSort !== prev.chatSort ||
        next.appView !== prev.appView ||
        next.tasks !== prev.tasks ||
        next.tasksProjectId !== prev.tasksProjectId ||
        next.tasksChatPanelWidth !== prev.tasksChatPanelWidth ||
        next.taskConfig !== prev.taskConfig
      ) {
        const isActiveProjectSelectionOnly =
          next.activeProjectId !== prev.activeProjectId &&
          next.activeBrowserTabIdByProject ===
            prev.activeBrowserTabIdByProject &&
          next.browserTabsByProject === prev.browserTabsByProject &&
          next.chats === prev.chats &&
          next.closedProjects === prev.closedProjects &&
          next.settings === prev.settings &&
          next.chatSort === prev.chatSort &&
          // Opening a step chat from Tasks switches project *and* view;
          // the active-project fast path would drop the view change.
          next.appView === prev.appView &&
          next.tasks === prev.tasks &&
          next.tasksProjectId === prev.tasksProjectId &&
          next.tasksChatPanelWidth === prev.tasksChatPanelWidth &&
          next.taskConfig === prev.taskConfig &&
          areProjectListsEqualExceptLastUsedAt(prev.projects, next.projects);
        prev = next;
        if (state.stateHydrated) {
          if (isActiveProjectSelectionOnly) {
            const lastUsedAt =
              state.projects.find(
                (project) => project.id === state.activeProjectId,
              )?.lastUsedAt ?? null;
            savePersistedActiveProject(state.activeProjectId, lastUsedAt);
            return;
          }

          cancelScheduledPersist();
          persistPending = true;
          persistTimer = setTimeout(() => {
            persistTimer = null;
            // Serializing the full state for IPC blocks the renderer thread;
            // run it during an idle period so it never lands in the middle of
            // a click-driven animation frame. The timeout still guarantees a
            // save within ~2s even if the thread stays busy.
            if (typeof requestIdleCallback === "function") {
              persistIdleCallback = requestIdleCallback(
                () => {
                  persistIdleCallback = null;
                  flushPendingPersist();
                },
                { timeout: 2000 },
              );
            } else {
              flushPendingPersist();
            }
          }, 300);
        }
      }
    });

    return () => {
      unsub();
      window.removeEventListener("beforeunload", flushPendingPersist);
      window.removeEventListener("pagehide", flushPendingPersist);
      flushPendingPersist();
    };
  }, []);

  // Best-effort: ask main to stop PTYs on page hide/unload. Keyboard reload and
  // in-app navigations are intercepted in the main process so sessions are
  // closed before the renderer is torn down; this covers remaining unload paths.
  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi || typeof desktopApi.stopAllTerminals !== "function") {
      return;
    }

    const hasActiveTerminalSessions = () => {
      const state = useIdeStore.getState();
      if (
        Object.values(state.terminalStatus).some(
          (status) => status === "running",
        )
      ) {
        return true;
      }

      return Object.values(state.projectTerminalSessionIds).some(
        (sessionIds) => sessionIds.length > 0,
      );
    };

    const stopActiveSessions = () => {
      if (!hasActiveTerminalSessions()) {
        return;
      }

      void desktopApi.stopAllTerminals();
    };

    window.addEventListener("pagehide", stopActiveSessions);
    window.addEventListener("beforeunload", stopActiveSessions);

    return () => {
      window.removeEventListener("pagehide", stopActiveSessions);
      window.removeEventListener("beforeunload", stopActiveSessions);
    };
  }, []);

  // Desktop event listeners
  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    const removeTerminalData = desktopApi.onTerminalData((event) => {
      const { projectId, generation, sequence } = event;
      publishTerminalOutput(projectId, event.chunk, () => {
        if (generation !== undefined && sequence !== undefined) {
          desktopApi.acknowledgeTerminalOutput({
            projectId,
            generation,
            sequence,
          });
        }
      });
    });

    const removeTerminalStatus = desktopApi.onTerminalStatus((event) => {
      if (!hasTerminalScrollback(event.projectId)) {
        return;
      }
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

    return () => {
      removeTerminalData();
      removeTerminalStatus();
      removeBrowserError();
    };
  }, [
    setTerminalStatus,
    setTerminalTransport,
    setTerminalShell,
    setBrowserError,
  ]);

  // Auto-refresh models when settings panel opens
  useEffect(() => {
    if (!settingsOpen || settingsSection !== "providers") {
      return;
    }
    void refreshProviderModels();
  }, [refreshProviderModels, settingsOpen, settingsSection]);

  // Check for updates whenever the settings panel opens
  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    void getDesktopApi()?.checkForUpdates();
  }, [settingsOpen]);

  // Sync settings integrity (dedupe models, fix connected providers)
  useEffect(() => {
    const store = useIdeStore.getState();
    const prev = settings;

    const openAiSelectedModels = dedupeModels(prev.openAiSelectedModels);
    const anthropicSelectedModels = dedupeModels(
      prev.anthropicSelectedModels.map(normalizeClaudeCodeModelId),
    );
    const openCodeSelectedModels = dedupeModels(prev.openCodeSelectedModels);
    const cursorSelectedModels = dedupeModels(prev.cursorSelectedModels);
    const grokSelectedModels = dedupeModels(prev.grokSelectedModels);
    const nextSettings = {
      ...prev,
      anthropicSelectedModels,
      cursorSelectedModels,
      grokSelectedModels,
      openCodeSelectedModels,
      openAiSelectedModels,
    };
    const normalizedDefaultSettings =
      normalizeDefaultModelSettings(nextSettings);
    const enabledProviders = getConnectedProviders(nextSettings);

    const changed =
      normalizedDefaultSettings.defaultModel !== prev.defaultModel ||
      normalizedDefaultSettings.defaultGitGenerationModel !==
        prev.defaultGitGenerationModel ||
      normalizedDefaultSettings.defaultModelSpeed !== prev.defaultModelSpeed ||
      normalizedDefaultSettings.defaultReasoningEffort !==
        prev.defaultReasoningEffort ||
      openAiSelectedModels.length !== prev.openAiSelectedModels.length ||
      anthropicSelectedModels.length !== prev.anthropicSelectedModels.length ||
      openCodeSelectedModels.length !== prev.openCodeSelectedModels.length ||
      cursorSelectedModels.length !== prev.cursorSelectedModels.length ||
      grokSelectedModels.length !== prev.grokSelectedModels.length ||
      !openAiSelectedModels.every(
        (m, i) => prev.openAiSelectedModels[i] === m,
      ) ||
      !anthropicSelectedModels.every(
        (m, i) => prev.anthropicSelectedModels[i] === m,
      ) ||
      !openCodeSelectedModels.every(
        (m, i) => prev.openCodeSelectedModels[i] === m,
      ) ||
      !cursorSelectedModels.every(
        (m, i) => prev.cursorSelectedModels[i] === m,
      ) ||
      !grokSelectedModels.every((m, i) => prev.grokSelectedModels[i] === m);

    if (changed) {
      store.setSettings(normalizedDefaultSettings);
    }

    // Fix projects whose provider/model is no longer valid.
    const effectiveSettings = normalizedDefaultSettings;
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
    <div className="flex h-screen flex-col overflow-hidden bg-surface-50 dark:bg-surface-900 text-foreground">
      {!appReady && <AppLoadingScreen />}
      <ChatRuntimeHost />
      <IdeHeader />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ActivityInbox />
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {!stateHydrated ? null : (
            <>
              {projects.map((project) => {
                // Keep the outgoing surface painted while React prepares the
                // incoming workspace, then reveal and activate it atomically.
                const selected = project.id === renderedActiveProjectId;
                // Project workspaces stay mounted beneath Tasks so switching
                // back is instant, but only the visible surface owns shortcuts
                // and native webviews. (Chats run in the chat runtime, not in
                // these panels.)
                const active = selected && !tasksSelected;

                return (
                  <div
                    aria-hidden={!active}
                    className={cn(
                      "absolute inset-0 min-h-0 bg-surface-50 dark:bg-surface-900",
                      selected
                        ? "z-10 pointer-events-auto"
                        : // Keep inactive workspaces painted beneath the active
                          // one. Hiding or moving them offscreen makes Chromium
                          // rebuild the layer when a project is selected, which
                          // produces a blank frame during the tab switch.
                          "z-0 pointer-events-none",
                    )}
                    inert={!active}
                    key={project.id}
                  >
                    <ProjectWorkspace active={active} project={project} />
                  </div>
                );
              })}
              {!renderedActiveProjectId ? (
                <div
                  className="absolute inset-0 z-20 bg-surface-50 p-3 dark:bg-surface-900"
                  inert={tasksSelected}
                >
                  <EmptyProjectWorkspace />
                </div>
              ) : null}
              {/* Tasks is app-level: mounted once on first visit, above
                  every project (and the empty state), then kept alive so board
                  state survives switching back and forth. */}
              {tasksVisited ? (
                <div
                  aria-hidden={!tasksSelected}
                  className={cn(
                    "absolute inset-0 z-30 min-h-0 bg-surface-50 dark:bg-surface-900",
                    tasksSelected
                      ? "visible opacity-100 pointer-events-auto"
                      : "invisible opacity-0 pointer-events-none",
                  )}
                  data-app-view="tasks"
                  inert={!tasksSelected}
                >
                  <Suspense fallback={null}>
                    <TasksWorkspace active={tasksSelected} />
                  </Suspense>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsDialog />
        </Suspense>
      ) : null}
    </div>
  );
};
