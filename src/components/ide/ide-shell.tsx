import { useTranslations } from "next-intl";
import { lazy, Suspense, useDeferredValue, useEffect } from "react";
import { AppLoadingScreen } from "@/components/dream-loading-screen";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { dismissBootScreen } from "@/lib/boot-screen";
import { getDesktopApi, hasDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { getHostSocketClient } from "@/lib/host-socket";
import { terminalClient } from "@/lib/terminal-client";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import { ConnectionBanner } from "../remote/connection-banner";
import { startActivityNotifications } from "./activity-notifications";
import { AppScreenshotToast } from "./app-screenshot-toast";
import { ChatRuntimeHost } from "./chat/chat-runtime-host";
import { ChatSearchDialog } from "./chat-search-dialog";
import { EmptyProjectWorkspace } from "./empty-project-workspace";
import { IdeHeader } from "./ide-header";
import { useIdeStore } from "./ide-store";
import { OpenProjectDialog } from "./open-project/open-project-dialog";
import { flushProjectPanelRefresh } from "./project-panel-refresh";
import { ProjectWorkspace } from "./project-workspace";
import { watchRendererUnload } from "./renderer-unload-guard";
import { GlobalShortcuts } from "./shortcuts/global-shortcuts";
import { SshPromptDialog } from "./ssh/ssh-prompt-dialog";
import { watchHostBrowser } from "./store/host-browser-watch";
import { watchHostCatalog } from "./store/host-catalog-watch";
import {
  hasTerminalScrollback,
  publishTerminalOutput,
} from "./terminal-scrollback";
import { terminalSessions } from "./terminal-session";
import { useBrowserAgentCommands } from "./use-browser-agent-commands";
import { watchWindowReturn } from "./window-return";

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

  // Desktop notifications for chats that finish, fail or wait in the
  // background.
  const workspaceT = useTranslations("workspace");
  useEffect(
    () =>
      startActivityNotifications((kind, values) =>
        workspaceT(
          kind === "finished"
            ? "notificationFinished"
            : kind === "failed"
              ? "notificationFailed"
              : "notificationWaiting",
          values,
        ),
      ),
    [workspaceT],
  );

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
    dismissBootScreen();
  }, [appReady]);

  // Desktop-owned terminals stop on unload; a detached host's outlive the page.
  useEffect(() => {
    const desktop = getDesktopApi();
    if (!desktop || desktop.hostMode === "detached") return;
    return watchRendererUnload({
      getState: useIdeStore.getState,
      stopAll: () => terminalClient.stopAll({ keepalive: true }),
    });
  }, []);

  // Each host's catalog changes made elsewhere (another window, the host
  // itself): the home host's always, an SSH host's once it is loaded. A
  // browser client follows its home host the same way; it lends no browser
  // and has no SSH hosts, which are the desktop's.
  useEffect(() => {
    const desktop = getDesktopApi();
    const watching = new Map<string, () => void>();
    const routes = new Map<string, string | null | undefined>();
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
        const routeId = hosts[hostId]?.routeId;
        if (watching.has(hostId) && routes.get(hostId) === routeId) continue;
        watching.get(hostId)?.();
        routes.set(hostId, routeId);
        const stopCatalog = watchHostCatalog(hostId);
        const route = useIdeStore
          .getState()
          .hostConnections.find((host) => host.id === hostId)
          ?.routes.find((item) => item.id === routeId);
        // SSH and detached hosts' agents use this window's browser.
        const stopBrowser =
          !desktop ||
          route?.kind === "https" ||
          (hostId === LOCAL_HOST_ID && desktop.hostMode !== "detached")
            ? null
            : watchHostBrowser(hostId);
        watching.set(hostId, () => {
          stopCatalog();
          stopBrowser?.();
        });
      }
      for (const [hostId, stop] of watching) {
        if (!wanted.has(hostId)) {
          stop();
          watching.delete(hostId);
          routes.delete(hostId);
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
  // Terminal output and status, from every host's socket (a browser client
  // has terminals too); the webview browser's errors, on the desktop.
  useEffect(() => {
    const desktopApi = getDesktopApi();
    terminalSessions.setRefreshProject(flushProjectPanelRefresh);

    const removeTerminalData = terminalClient.onData((event) => {
      const { generation, sequence, sessionId } = event;
      terminalSessions.output(sessionId);
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
      if (
        desktopApi?.hostMode === "detached" &&
        event.status === "running" &&
        !hasTerminalScrollback(event.sessionId)
      ) {
        useIdeStore.getState().restoreHostTerminal(event.sessionId);
      }
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

    const removeBrowserError = desktopApi?.onBrowserError((event) => {
      setBrowserError(
        `${String(event.code)}${event.description ? `: ${event.description}` : ""}`,
      );
    });

    return () => {
      removeTerminalData();
      removeTerminalStatus();
      removeBrowserError?.();
    };
  }, [
    setTerminalStatus,
    setTerminalTransport,
    setTerminalShell,
    setBrowserError,
  ]);

  // Discover a detached host's terminals after the workspace knows their projects.
  useEffect(() => {
    if (getDesktopApi()?.hostMode !== "detached") return;
    let known = "";
    const discover = () => {
      const state = useIdeStore.getState();
      if (!state.stateHydrated) return;
      const key = JSON.stringify(state.projects.map((project) => project.id));
      if (key === known) return;
      known = key;
      getHostSocketClient(LOCAL_HOST_ID).send({
        channel: "terminal",
        type: "discover",
      });
    };
    discover();
    return useIdeStore.subscribe(discover);
  }, []);

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

  // Commits and branch switches made outside the app (another terminal or
  // editor) are noticed when the person comes back to this window: the
  // project in front reads git again. Only that one: reading every open
  // project's status on each return would cost a git call apiece.
  useEffect(
    () =>
      watchWindowReturn(() => {
        const { activeProjectId, bumpProjectGitRefreshKey } =
          useIdeStore.getState();
        if (activeProjectId) bumpProjectGitRefreshKey(activeProjectId);
      }),
    [],
  );

  // ── Render ──────────────────────────────────────────────────────────
  return (
    // The dynamic viewport height and the safe areas: a phone's browser bars
    // and keyboard (index.html resizes content for it) and its notch never
    // cover the header or the composer. Both are zero on the desktop.
    <div className="relative flex h-dvh flex-col overflow-hidden bg-surface-50 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-foreground dark:bg-surface-900">
      {!appReady && <AppLoadingScreen />}
      <ChatRuntimeHost />
      <GlobalShortcuts />
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
      <ConnectionBanner />
      <AppScreenshotToast />
      {stateHydrated ? <ChatSearchDialog /> : null}
      {stateHydrated ? <OpenProjectDialog /> : null}
      <SshPromptDialog />
      <Toaster />
    </div>
  );
};
