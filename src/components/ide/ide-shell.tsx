"use client";

import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel } from "react-resizable-panels";
import { getDesktopApi, hasDesktopApi } from "@/lib/electron";
import {
  getConnectedProviders,
  getDefaultModelForProvider,
  getModelsForProvider,
} from "@/lib/ide-defaults";
import type { PreviewBounds } from "@/types/ide";
import { ChatPanel } from "./chat-panel";
import { AppShellPlaceholder, ResizeHandle, echoPipeFallbackInput } from "./ide-helpers";
import { IdeHeader } from "./ide-header";
import { useIdeStore } from "./ide-store";
import {
  GLOBAL_TERMINAL_SESSION_ID,
  TERMINAL_MIN_HEIGHT_PX,
  type TerminalTransport,
  dedupeModels,
} from "./ide-types";
import { PreviewPanel } from "./preview-panel";
import { ProjectSidebar } from "./project-sidebar";
import { SettingsDialog } from "./settings-dialog";
import { Spinner } from "@/components/ui/spinner";
import { TerminalPanel } from "./terminal-panel";

export const IdeShell = () => {
  // ── Store selectors ─────────────────────────────────────────────────
  const appReady = useIdeStore((s) => s.appReady);
  const setAppReady = useIdeStore((s) => s.setAppReady);
  const stateHydrated = useIdeStore((s) => s.stateHydrated);
  const panelVisibility = useIdeStore((s) => s.panelVisibility);
  const settings = useIdeStore((s) => s.settings);
  const terminalPanelOpen = useIdeStore((s) => s.terminalPanelOpen);
  const settingsOpen = useIdeStore((s) => s.settingsOpen);
  const settingsSection = useIdeStore((s) => s.settingsSection);
  const runnerStatus = useIdeStore((s) => s.runnerStatus);
  const activeProject = useIdeStore((s) => s.getActiveProject());

  const hydrate = useIdeStore((s) => s.hydrate);
  const setIsMacOs = useIdeStore((s) => s.setIsMacOs);
  const setIsElectron = useIdeStore((s) => s.setIsElectron);
  const setProviderSetupTarget = useIdeStore((s) => s.setProviderSetupTarget);
  const appendRunLog = useIdeStore((s) => s.appendRunLog);
  const setRunnerStatus = useIdeStore((s) => s.setRunnerStatus);
  const setTerminalStatus = useIdeStore((s) => s.setTerminalStatus);
  const setTerminalShell = useIdeStore((s) => s.setTerminalShell);
  const setPreviewError = useIdeStore((s) => s.setPreviewError);
  const refreshCodexLoginStatus = useIdeStore((s) => s.refreshCodexLoginStatus);
  const refreshProviderModels = useIdeStore((s) => s.refreshProviderModels);

  // ── Refs ─────────────────────────────────────────────────────────────
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const [terminalHost, setTerminalHost] = useState<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalFitRef = useRef<FitAddon | null>(null);
  const terminalTransportRef = useRef<TerminalTransport>("pty");
  const providerCredentialsRef = useRef({
    anthropicApiKey: settings.anthropicApiKey,
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
      anthropicApiKey: s.anthropicApiKey,
      openAiApiKey: s.openAiApiKey,
      openAiAuthMode: s.openAiAuthMode,
    });
    if (s.openAiAuthMode === "codex") {
      void refreshCodexLoginStatus();
    }
    setAppReady(true);
  }, [stateHydrated, setAppReady, refreshProviderModels, refreshCodexLoginStatus]);

  // Subscribe to persisted state changes for auto-persistence
  useEffect(() => {
    let prev = {
      activeProjectId: useIdeStore.getState().activeProjectId,
      chats: useIdeStore.getState().chats,
      panelVisibility: useIdeStore.getState().panelVisibility,
      projects: useIdeStore.getState().projects,
      settings: useIdeStore.getState().settings,
    };

    const unsub = useIdeStore.subscribe((state) => {
      const next = {
        activeProjectId: state.activeProjectId,
        chats: state.chats,
        panelVisibility: state.panelVisibility,
        projects: state.projects,
        settings: state.settings,
      };

      if (
        next.activeProjectId !== prev.activeProjectId ||
        next.chats !== prev.chats ||
        next.panelVisibility !== prev.panelVisibility ||
        next.projects !== prev.projects ||
        next.settings !== prev.settings
      ) {
        prev = next;
        if (state.stateHydrated) state.persist();
      }
    });

    return unsub;
  }, []);

  // Desktop event listeners
  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    const removeRunnerData = desktopApi.onRunnerData((event) => {
      appendRunLog(event.projectId, event.chunk);
    });

    const removeRunnerStatus = desktopApi.onRunnerStatus((event) => {
      setRunnerStatus(event.projectId, event.status);
    });

    const removeTerminalData = desktopApi.onTerminalData((event) => {
      if (event.projectId !== GLOBAL_TERMINAL_SESSION_ID) return;
      terminalRef.current?.write(event.chunk);
    });

    const removeTerminalStatus = desktopApi.onTerminalStatus((event) => {
      if (event.projectId !== GLOBAL_TERMINAL_SESSION_ID) return;

      if (event.transport) {
        terminalTransportRef.current = event.transport;
      }

      setTerminalStatus(event.projectId, event.status);

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

    return () => {
      removeRunnerData();
      removeRunnerStatus();
      removeTerminalData();
      removeTerminalStatus();
      removePreviewError();
    };
  }, [appendRunLog, setRunnerStatus, setTerminalStatus, setTerminalShell, setPreviewError]);

  // Terminal xterm setup
  useEffect(() => {
    const host = terminalHost;
    if (!host) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      theme: {
        background: "#ffffff",
        cursor: "#111827",
        foreground: "#1f2937",
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(host);

    terminalRef.current = terminal;
    terminalFitRef.current = fitAddon;

    const fit = () => {
      fitAddon.fit();
    };

    fit();
    terminal.focus();

    // Auto-start pty if not already running
    const ts = useIdeStore.getState().terminalStatus;
    if ((ts[GLOBAL_TERMINAL_SESSION_ID] ?? "stopped") !== "running") {
      void useIdeStore.getState().startActiveTerminal(terminalRef);
    }

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);

    const inputSubscription = terminal.onData((data) => {
      const desktopApi = getDesktopApi();
      if (!desktopApi) return;

      if (terminalTransportRef.current === "pipe") {
        echoPipeFallbackInput(terminal, data);
      }

      desktopApi.sendTerminalInput({
        data,
        projectId: GLOBAL_TERMINAL_SESSION_ID,
      });
    });

    window.addEventListener("resize", fit);

    return () => {
      inputSubscription.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", fit);
      terminal.dispose();
      terminalRef.current = null;
      terminalFitRef.current = null;
    };
  }, [terminalHost]);

  // Preview bounds sync
  const syncPreviewBounds = useCallback(() => {
    const desktopApi = getDesktopApi();
    const project = useIdeStore.getState().getActiveProject();
    const rs = useIdeStore.getState().runnerStatus;
    const pv = useIdeStore.getState().panelVisibility;
    const activeProjectRunnerStatus = project
      ? (rs[project.id] ?? "stopped")
      : "stopped";

    if (!desktopApi) return;

    if (!project || !pv.right || activeProjectRunnerStatus !== "running") {
      desktopApi.updatePreview({ visible: false });
      return;
    }

    const host = previewHostRef.current;
    if (!host) return;

    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      desktopApi.updatePreview({ visible: false });
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

  // Sync preview bounds when runner status or visibility changes
  useEffect(() => {
    syncPreviewBounds();
  }, [activeProject, panelVisibility.right, runnerStatus, syncPreviewBounds]);

  // Terminal fit on panel open
  useEffect(() => {
    if (!panelVisibility.middle || !terminalPanelOpen) return;
    terminalFitRef.current?.fit();
    terminalRef.current?.focus();
  }, [panelVisibility.middle, terminalPanelOpen]);

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
      anthropicApiKey: settings.anthropicApiKey,
      openAiApiKey: settings.openAiApiKey,
      openAiAuthMode: settings.openAiAuthMode,
    };
  }, [settings.anthropicApiKey, settings.openAiApiKey, settings.openAiAuthMode]);

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
  }, [refreshCodexLoginStatus, refreshProviderModels, settingsOpen, settingsSection]);

  // Reset provider setup target when leaving providers section
  useEffect(() => {
    if (!settingsOpen || settingsSection !== "providers") {
      setProviderSetupTarget(null);
    }
  }, [settingsOpen, settingsSection, setProviderSetupTarget]);

  // Sync settings integrity (dedupe models, fix connected providers)
  useEffect(() => {
    const store = useIdeStore.getState();
    const prev = store.settings;

    const safeConnectedProviders = getConnectedProviders(prev);
    const openAiSelectedModels = dedupeModels(prev.openAiSelectedModels);
    const anthropicSelectedModels = dedupeModels(prev.anthropicSelectedModels);
    const defaultOpenAiModel = openAiSelectedModels.includes(prev.defaultOpenAiModel)
      ? prev.defaultOpenAiModel
      : (openAiSelectedModels[0] ?? "");
    const defaultAnthropicModel = anthropicSelectedModels.includes(prev.defaultAnthropicModel)
      ? prev.defaultAnthropicModel
      : (anthropicSelectedModels[0] ?? "");

    const changed =
      safeConnectedProviders.length !== prev.connectedProviders.length ||
      !safeConnectedProviders.every((p, i) => prev.connectedProviders[i] === p) ||
      defaultOpenAiModel !== prev.defaultOpenAiModel ||
      defaultAnthropicModel !== prev.defaultAnthropicModel ||
      openAiSelectedModels.length !== prev.openAiSelectedModels.length ||
      anthropicSelectedModels.length !== prev.anthropicSelectedModels.length ||
      !openAiSelectedModels.every((m, i) => prev.openAiSelectedModels[i] === m) ||
      !anthropicSelectedModels.every((m, i) => prev.anthropicSelectedModels[i] === m);

    if (changed) {
      store.setSettings({
        ...prev,
        anthropicSelectedModels,
        connectedProviders: safeConnectedProviders,
        defaultAnthropicModel,
        defaultOpenAiModel,
        openAiSelectedModels,
      });
    }

    // Fix projects whose provider/model is no longer valid
    const connectedProviders = safeConnectedProviders;
    const fallbackProvider = connectedProviders[0] ?? null;
    const { projects } = store;
    let projectsChanged = false;
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

      const providerModels = getModelsForProvider(next.provider, store.settings);
      const fallbackModel = getDefaultModelForProvider(next.provider, store.settings);

      if (!providerModels.includes(next.model) && next.model !== fallbackModel) {
        next = { ...next, model: fallbackModel };
        projectsChanged = true;
      }

      return next;
    });

    if (projectsChanged) {
      store.setProjects(nextProjects);
    }
  }, [settings]);

  // ── Derived values ──────────────────────────────────────────────────
  const mainWorkspaceVisible = panelVisibility.middle || panelVisibility.right;

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      {!appReady && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      )}
      <IdeHeader />

      <div className="h-[calc(100vh-44px)] overflow-hidden">
        {!stateHydrated ? null : (
        <Group className="h-full" id="ide-root" orientation="horizontal">
          {panelVisibility.left ? (
            <>
              <Panel
                className="min-w-[230px]"
                defaultSize={18}
                id="ide-left"
                minSize={14}
              >
                <ProjectSidebar />
              </Panel>
              <ResizeHandle className="w-1" id="ide-left-handle" />
            </>
          ) : null}

          <Panel
            defaultSize={panelVisibility.left ? 82 : 100}
            id="ide-main"
            minSize={20}
          >
            <Group id="ide-workspace" orientation="horizontal">
              {panelVisibility.middle ? (
                <Panel
                  defaultSize={panelVisibility.right ? 54 : 100}
                  id="ide-middle"
                  minSize={30}
                >
                  <div className="flex h-full flex-col border-r">
                    <Group className="h-full" id="ide-chat-term" orientation="vertical">
                      <Panel
                        defaultSize={terminalPanelOpen ? 74 : 100}
                        id="ide-chat"
                        minSize={30}
                      >
                        {activeProject ? (
                          <ChatPanel project={activeProject} />
                        ) : (
                          <div className="h-full p-3">
                            <AppShellPlaceholder message="Select or add a project to start chatting with the AI assistant." />
                          </div>
                        )}
                      </Panel>

                      {terminalPanelOpen ? (
                        <>
                          <ResizeHandle className="h-1" id="ide-term-handle" />
                          <Panel
                            defaultSize={26}
                            id="ide-terminal"
                            minSize={`${TERMINAL_MIN_HEIGHT_PX}px`}
                          >
                            <TerminalPanel terminalHostRef={setTerminalHost} />
                          </Panel>
                        </>
                      ) : null}
                    </Group>
                  </div>
                </Panel>
              ) : null}

              {panelVisibility.middle && panelVisibility.right ? (
                <ResizeHandle className="w-1" id="ide-middle-handle" />
              ) : null}

              {panelVisibility.right ? (
                <Panel
                  defaultSize={panelVisibility.middle ? 46 : 100}
                  id="ide-right"
                  minSize={26}
                >
                  <PreviewPanel
                    onSyncPreviewBounds={syncPreviewBounds}
                    previewHostRef={previewHostRef}
                  />
                </Panel>
              ) : null}

              {!mainWorkspaceVisible ? (
                <Panel defaultSize={100} id="ide-fallback" minSize={20}>
                  <AppShellPlaceholder message="Enable the chat or preview panel from the top-right controls." />
                </Panel>
              ) : null}
            </Group>
          </Panel>
        </Group>
        )}
      </div>

      <SettingsDialog />
    </div>
  );
};
