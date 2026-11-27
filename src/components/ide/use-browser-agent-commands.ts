import { useEffect } from "react";
import { getDesktopApi } from "@/lib/electron";
import type {
  BrowserAgentCommand,
  BrowserAgentCommandResult,
  BrowserAgentTabInfo,
} from "@/types/ide";
import { useIdeStore } from "./ide-store";

/**
 * Answers browser commands issued by agent tools running in the main process.
 *
 * Tab state and the `<webview>` elements live in the renderer, so anything
 * that changes which tab exists or is visible has to happen here. Once a tab
 * is mounted, the main process drives it directly through its webContents.
 *
 * Agents work in the background: a tab they use is held (its webview stays
 * mounted, hidden unless it is the tab on screen) and the user's project,
 * panel and tab stay as they are. A tab comes to the front only when the
 * agent asks for it (browser_activate_tab) or the user follows the agent.
 */

const getProject = (projectId: string) =>
  useIdeStore.getState().projects.find((project) => project.id === projectId) ??
  null;

/** The tab the agent used last, if it is still open. */
const getAgentTab = (projectId: string) => {
  const state = useIdeStore.getState();
  const tabs = state.browserTabsByProject[projectId] ?? [];
  const held = state.agentBrowserTabIdsByProject[projectId] ?? [];
  return tabs.find((tab) => tab.id === held.at(-1)) ?? null;
};

const listTabs = (projectId: string): BrowserAgentCommandResult => {
  const state = useIdeStore.getState();
  const project = getProject(projectId);
  const tabs = state.browserTabsByProject[projectId] ?? [];
  const activeTabId = state.activeBrowserTabIdByProject[projectId] ?? null;
  const held = state.agentBrowserTabIdsByProject[projectId] ?? [];
  const panelOpen = Boolean(
    project?.ui.rightPanelOpen && project.ui.rightPanelView === "browser",
  );

  return {
    agentTabId: getAgentTab(projectId)?.id ?? null,
    panelOpen,
    projectPath: project?.path ?? null,
    tabs: tabs.map<BrowserAgentTabInfo>((tab) => ({
      active: tab.id === activeTabId,
      agent: held.includes(tab.id),
      id: tab.id,
      title: tab.title,
      url: tab.url,
    })),
  };
};

const followsAgent = (payload: { activate?: boolean }) =>
  payload.activate === true ||
  useIdeStore.getState().settings.followAgentBrowser;

/** Make the browser panel visible for the project and bring it to front. */
const revealBrowserPanel = (projectId: string) => {
  const state = useIdeStore.getState();
  if (state.activeProjectId !== projectId) {
    state.setActiveProjectId(projectId);
  }
  state.showRightPanelView(projectId, "browser");
};

const showTab = (
  projectId: string,
  payload: { activate?: boolean; tabId?: string; url?: string },
): BrowserAgentCommandResult => {
  const state = useIdeStore.getState();
  state.ensureBrowserTabs(projectId, getProject(projectId)?.browserUrl ?? "");
  const tabs = useIdeStore.getState().browserTabsByProject[projectId] ?? [];
  const tab = payload.tabId
    ? tabs.find((item) => item.id === payload.tabId)
    : (getAgentTab(projectId) ??
      tabs.find(
        (item) =>
          item.id ===
          useIdeStore.getState().activeBrowserTabIdByProject[projectId],
      ) ??
      tabs[0]);
  if (!tab) {
    throw new Error(`No browser tab with id ${payload.tabId ?? "(active)"}.`);
  }

  state.holdAgentBrowserTab(projectId, tab.id);
  if (followsAgent(payload)) {
    revealBrowserPanel(projectId);
    state.setActiveBrowserTab(projectId, tab.id);
  }
  const nextUrl = payload.url ?? tab.url;
  if (payload.url) {
    state.navigateBrowserTab(projectId, tab.id, nextUrl);
  }

  return {
    active:
      useIdeStore.getState().activeBrowserTabIdByProject[projectId] === tab.id,
    id: tab.id,
    tabId: tab.id,
    title: tab.title,
    url: nextUrl,
  };
};

const openTab = (
  projectId: string,
  payload: { activate?: boolean; url?: string },
): BrowserAgentCommandResult => {
  const url = payload.url ?? "";
  const state = useIdeStore.getState();
  state.ensureBrowserTabs(projectId, getProject(projectId)?.browserUrl ?? "");

  // Reuse a blank tab instead of stacking empty ones next to it.
  const tabs = useIdeStore.getState().browserTabsByProject[projectId] ?? [];
  const activeTabId =
    useIdeStore.getState().activeBrowserTabIdByProject[projectId] ?? null;
  const blankTab =
    tabs.find((tab) => tab.id === activeTabId && !tab.url) ??
    (tabs.length === 1 && !tabs[0].url ? tabs[0] : null);

  const follow = followsAgent(payload);
  const tabId = blankTab
    ? blankTab.id
    : state.createBrowserTab(projectId, url, { activate: follow });
  if (!tabId) {
    throw new Error("Could not create a browser tab.");
  }

  state.holdAgentBrowserTab(projectId, tabId);
  if (follow) {
    revealBrowserPanel(projectId);
    state.setActiveBrowserTab(projectId, tabId);
  }
  if (url && blankTab) {
    state.navigateBrowserTab(projectId, tabId, url);
  }

  return { reused: Boolean(blankTab), tabId, url };
};

const closeTab = (
  projectId: string,
  payload: { tabId?: string },
): BrowserAgentCommandResult => {
  if (!payload.tabId) {
    throw new Error("tabId is required.");
  }
  const state = useIdeStore.getState();
  const tabs = state.browserTabsByProject[projectId] ?? [];
  if (!tabs.some((tab) => tab.id === payload.tabId)) {
    throw new Error(`No browser tab with id ${payload.tabId}.`);
  }
  const nextActiveTabId = state.closeBrowserTab(projectId, payload.tabId);
  return { activeTabId: nextActiveTabId, closed: payload.tabId };
};

export const runBrowserAgentCommand = (
  command: BrowserAgentCommand,
): BrowserAgentCommandResult => {
  const { payload = {}, projectId, type } = command;
  if (!getProject(projectId)) {
    throw new Error(
      "The project for this chat is not open in Dream, so its browser cannot be used.",
    );
  }

  switch (type) {
    case "list-tabs":
      return listTabs(projectId);
    case "show-tab":
      return showTab(projectId, payload);
    case "open-tab":
      return openTab(projectId, payload);
    case "close-tab":
      return closeTab(projectId, payload);
    default:
      throw new Error(`Unknown browser command "${String(type)}".`);
  }
};

export const useBrowserAgentCommands = () => {
  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi?.onBrowserCommand) {
      return;
    }

    return desktopApi.onBrowserCommand((command) => {
      try {
        const result = runBrowserAgentCommand(command);
        desktopApi.sendBrowserCommandResult({
          id: command.id,
          ok: true,
          result,
        });
      } catch (error) {
        desktopApi.sendBrowserCommandResult({
          error: error instanceof Error ? error.message : String(error),
          id: command.id,
          ok: false,
        });
      }
    });
  }, []);
};
