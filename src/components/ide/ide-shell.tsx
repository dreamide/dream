import { useEffect } from "react";
import dreamSvg from "@/assets/dream.svg";
import Sparkles from "@/components/ui/sparkles";
import { getDesktopApi, hasDesktopApi } from "@/lib/electron";
import {
  getConnectedProviders,
  getDefaultModelForProvider,
  getDefaultModelSelection,
  getModelsForProvider,
  getPreferredDefaultModel,
  normalizeClaudeCodeModelId,
} from "@/lib/ide-defaults";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import { EmptyProjectWorkspace } from "./empty-project-workspace";
import { IdeHeader } from "./ide-header";
import { useIdeStore } from "./ide-store";
import { dedupeModels } from "./ide-types";
import { ProjectWorkspace } from "./project-workspace";
import { SettingsDialog } from "./settings-dialog";

export const IdeShell = () => {
  // ── Store selectors ─────────────────────────────────────────────────
  const appReady = useIdeStore((s) => s.appReady);
  const setAppReady = useIdeStore((s) => s.setAppReady);
  const stateHydrated = useIdeStore((s) => s.stateHydrated);
  const projects = useIdeStore((s) => s.projects);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const settings = useIdeStore((s) => s.settings);
  const settingsOpen = useIdeStore((s) => s.settingsOpen);
  const settingsSection = useIdeStore((s) => s.settingsSection);

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
      activeBrowserTabIdByProject:
        useIdeStore.getState().activeBrowserTabIdByProject,
      browserTabsByProject: useIdeStore.getState().browserTabsByProject,
      chatSort: useIdeStore.getState().chatSort,
      chats: useIdeStore.getState().chats,
      closedProjects: useIdeStore.getState().closedProjects,
      messagesByChatId: useIdeStore.getState().messagesByChatId,
      projects: useIdeStore.getState().projects,
      settings: useIdeStore.getState().settings,
    };
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const unsub = useIdeStore.subscribe((state) => {
      const next = {
        activeProjectId: state.activeProjectId,
        activeBrowserTabIdByProject: state.activeBrowserTabIdByProject,
        browserTabsByProject: state.browserTabsByProject,
        chatSort: state.chatSort,
        chats: state.chats,
        closedProjects: state.closedProjects,
        messagesByChatId: state.messagesByChatId,
        projects: state.projects,
        settings: state.settings,
      };

      if (
        next.activeProjectId !== prev.activeProjectId ||
        next.activeBrowserTabIdByProject !== prev.activeBrowserTabIdByProject ||
        next.browserTabsByProject !== prev.browserTabsByProject ||
        next.chats !== prev.chats ||
        next.closedProjects !== prev.closedProjects ||
        next.messagesByChatId !== prev.messagesByChatId ||
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
        // Flush pending persist on unmount.
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

  // Auto-refresh models when settings panel opens
  useEffect(() => {
    if (!settingsOpen || settingsSection !== "providers") {
      return;
    }
    void refreshProviderModels();
  }, [refreshProviderModels, settingsOpen, settingsSection]);

  useEffect(() => {
    if (!stateHydrated || activeProjectId) {
      return;
    }

    getDesktopApi()?.updateBrowser({ visible: false });
  }, [activeProjectId, stateHydrated]);

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

    // Fix projects whose provider/model is no longer valid.
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
        <div className="fixed inset-0 z-50 grid place-items-center bg-background">
          <div className="relative">
            <img
              alt=""
              className="relative z-10 size-16 opacity-85"
              draggable={false}
              src={dreamSvg}
            />
            {/* Invisible anchor centered on the logo; sparkles rise from here */}
            <div className="absolute left-0 right-0 top-1/2 z-0">
              <Sparkles
                density={50}
                groundGlow={false}
                height={120}
                palette="mono"
                position="top"
                sizeMul={0.8}
                speed={0.6}
                syncKey="dream-loading-sparkles"
                clockSync
              >
                <div className="h-0 w-full" />
              </Sparkles>
            </div>
          </div>
        </div>
      )}
      <IdeHeader />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {!stateHydrated ? null : (
          <>
            {projects.map((project) => {
              const active = project.id === activeProjectId;

              return (
                <div
                  aria-hidden={!active}
                  className={cn(
                    "absolute inset-0 min-h-0",
                    active
                      ? "pointer-events-auto opacity-100"
                      : "pointer-events-none opacity-0",
                  )}
                  inert={!active}
                  key={project.id}
                >
                  <ProjectWorkspace active={active} project={project} />
                </div>
              );
            })}
            {!activeProjectId ? (
              <div className="absolute inset-0 p-3">
                <EmptyProjectWorkspace />
              </div>
            ) : null}
          </>
        )}
      </div>

      <SettingsDialog />
    </div>
  );
};
