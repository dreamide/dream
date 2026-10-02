import { useTranslations } from "next-intl";
import { lazy, Suspense, useDeferredValue, useEffect } from "react";
import { AppLoadingScreen } from "@/components/dream-loading-screen";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { getDesktopApi, hasDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import {
  getConnectedProviders,
  getDefaultModelForProvider,
  getDefaultModelSelection,
  getModelsForProvider,
  normalizeClaudeCodeModelId,
  normalizeDefaultModelSettings,
} from "@/lib/ide-defaults";
import { terminalClient } from "@/lib/terminal-client";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import { AppScreenshotToast } from "./app-screenshot-toast";
import { ChatRuntimeHost } from "./chat/chat-runtime-host";
import { EmptyProjectWorkspace } from "./empty-project-workspace";
import { IdeHeader } from "./ide-header";
import { areProjectListsEqualExceptLastUsedAt } from "./ide-state";
import { useIdeStore } from "./ide-store";
import { dedupeModels } from "./ide-types";
import { ProjectWorkspace } from "./project-workspace";
import { SshPromptDialog } from "./ssh/ssh-prompt-dialog";
import { watchHostBrowser } from "./store/host-browser-watch";
import { watchHostCatalog } from "./store/host-catalog-watch";
import { savePersistedActiveProject } from "./store/ide-store-persistence";
import {
  hasTerminalScrollback,
  publishTerminalOutput,
} from "./terminal-scrollback";
import { useBrowserAgentCommands } from "./use-browser-agent-commands";

const SettingsWorkspace = lazy(() =>
  import("./settings-workspace").then((module) => ({
    default: module.SettingsWorkspace,
  })),
);

const CLI_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The workspace did not load: say so, and that nothing is being saved, so
 * the user restarts rather than rebuilding settings that are still on disk.
 */
const PersistenceBlockedBanner = () => {
  const t = useTranslations("app");
  const blocked = useIdeStore((state) => state.persistenceBlocked);
  if (!blocked) return null;
  return (
    <div
      className="fixed inset-x-0 top-12 z-50 mx-auto flex w-fit max-w-[90vw] items-center gap-3 rounded-md border border-destructive-border bg-destructive-surface px-4 py-2 text-destructive text-sm shadow-md"
      role="alert"
    >
      <span>{t("workspaceLoadFailed")}</span>
      <Button
        onClick={() => window.location.reload()}
        size="sm"
        variant="outline"
      >
        {t("reload")}
      </Button>
    </div>
  );
};

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
  const checkCliUpdates = useIdeStore((s) => s.checkCliUpdates);

  // ── Effects ─────────────────────────────────────────────────────────

  // Agent browser tools (main process) ask the renderer to open/show tabs.
  useBrowserAgentCommands();

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
      savedPrompts: useIdeStore.getState().savedPrompts,
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
        savedPrompts: state.savedPrompts,
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
        next.savedPrompts !== prev.savedPrompts
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
          next.appView === prev.appView &&
          next.savedPrompts === prev.savedPrompts &&
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

  // Best-effort: ask the host to stop PTYs on page hide/unload. Keyboard
  // reload and in-app navigations are intercepted in the main process so
  // sessions are closed before the renderer is torn down; this covers the
  // remaining unload paths.
  useEffect(() => {
    if (!getDesktopApi()) {
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

      void terminalClient.stopAll({ keepalive: true });
    };

    window.addEventListener("pagehide", stopActiveSessions);
    window.addEventListener("beforeunload", stopActiveSessions);

    return () => {
      window.removeEventListener("pagehide", stopActiveSessions);
      window.removeEventListener("beforeunload", stopActiveSessions);
    };
  }, []);

  // Each host's catalog changes made elsewhere (another window, the host
  // itself): the local host's always, an SSH host's once it is loaded.
  useEffect(() => {
    if (!getDesktopApi()) return;

    const watching = new Map<string, () => void>();
    const follow = (
      hosts: ReturnType<typeof useIdeStore.getState>["hosts"],
    ) => {
      const wanted = new Set([
        LOCAL_HOST_ID,
        ...Object.entries(hosts)
          .filter(([, host]) => host.loaded)
          .map(([hostId]) => hostId),
      ]);
      for (const hostId of wanted) {
        if (watching.has(hostId)) continue;
        const stopCatalog = watchHostCatalog(hostId);
        // An SSH host's agents use this window's browser.
        const stopBrowser =
          hostId === LOCAL_HOST_ID ? null : watchHostBrowser(hostId);
        watching.set(hostId, () => {
          stopCatalog();
          stopBrowser?.();
        });
      }
      for (const [hostId, stop] of watching) {
        if (!wanted.has(hostId)) {
          stop();
          watching.delete(hostId);
        }
      }
    };
    follow(useIdeStore.getState().hosts);
    const unsubscribe = useIdeStore.subscribe((state, previous) => {
      if (state.hosts !== previous.hosts) follow(state.hosts);
    });

    // What main says about SSH hosts' connections.
    const removeHostStatus = getDesktopApi()?.onHostStatus((event) =>
      useIdeStore.getState().setHostStatus(event),
    );

    return () => {
      unsubscribe();
      removeHostStatus?.();
      for (const stop of watching.values()) stop();
    };
  }, []);

  // Desktop event listeners
  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    const removeTerminalData = terminalClient.onData((event) => {
      const { generation, sequence, sessionId } = event;
      publishTerminalOutput(sessionId, event.chunk, () => {
        if (generation !== undefined && sequence !== undefined) {
          terminalClient.acknowledge({
            sessionId,
            generation,
            sequence,
          });
        }
      });
    });

    const removeTerminalStatus = terminalClient.onStatus((event) => {
      if (!hasTerminalScrollback(event.sessionId)) {
        return;
      }
      setTerminalStatus(event.sessionId, event.status);
      if (event.transport) {
        setTerminalTransport(event.sessionId, event.transport);
      }

      const shell = typeof event.shell === "string" ? event.shell.trim() : "";
      if (shell) {
        setTerminalShell(event.sessionId, shell);
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

  // Re-check for newer agent CLI releases while the app stays open. The first
  // check runs after the startup provider models refresh.
  useEffect(() => {
    if (!appReady) return;
    const interval = window.setInterval(
      () => void checkCliUpdates(),
      CLI_UPDATE_CHECK_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [appReady, checkCliUpdates]);

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
    <div className="relative flex h-screen flex-col overflow-hidden bg-surface-50 dark:bg-surface-900 text-foreground">
      {!appReady && <AppLoadingScreen />}
      <ChatRuntimeHost />
      <div className="contents" inert={settingsOpen}>
        <IdeHeader />
      </div>

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {!stateHydrated ? null : (
          <>
            {projects.map((project) => {
              // Keep the outgoing surface painted while React prepares the
              // incoming workspace, then reveal and activate it atomically.
              const selected = project.id === renderedActiveProjectId;
              // Project workspaces stay mounted so switching back is instant,
              // but only the visible surface owns shortcuts and native
              // webviews. (Chats run in the chat runtime, not in these
              // panels.)
              const active = selected && !settingsOpen;

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
                inert={settingsOpen}
              >
                <EmptyProjectWorkspace />
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Settings is a full-window workspace layered above the titlebar and
          every other surface; everything beneath stays mounted but inert. */}
      {stateHydrated && settingsOpen ? (
        <div
          className="absolute inset-0 z-40 min-h-0 bg-surface-50 dark:bg-surface-900"
          data-app-view="settings"
        >
          <Suspense fallback={null}>
            <SettingsWorkspace />
          </Suspense>
        </div>
      ) : null}

      <PersistenceBlockedBanner />
      <AppScreenshotToast />
      <SshPromptDialog />
      <Toaster />
    </div>
  );
};
