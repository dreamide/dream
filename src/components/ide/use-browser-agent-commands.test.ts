// Agent browser commands work in the background: the tab an agent uses is
// held (kept mounted) while the user's project, panel and tab stay put. Only
// an explicit activate, or the user following the agent, changes the view.
import { beforeEach, expect, test, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import { createBrowserActions } from "./store/browser-actions";
import type { IdeState } from "./store/ide-store-types";

const harness = vi.hoisted(() => ({
  store: null as unknown as StoreApi<IdeState>,
}));

vi.mock("./ide-store", () => ({
  useIdeStore: {
    getState: () => harness.store.getState(),
  },
}));

const { runBrowserAgentCommand } = await import("./use-browser-agent-commands");

const userProject = createProjectConfig("/work/user", DEFAULT_SETTINGS);
const agentProject = createProjectConfig("/work/agent", DEFAULT_SETTINGS);
const setActiveProjectId = vi.fn();
const showRightPanelView = vi.fn();

const resetStore = ({ follow = false } = {}) => {
  setActiveProjectId.mockReset();
  showRightPanelView.mockReset();
  const store = createStore<IdeState>(
    () =>
      ({
        activeBrowserTabIdByProject: {},
        activeProjectId: userProject.id,
        agentBrowserTabIdsByProject: {},
        browserStatusByTab: {},
        browserTabsByProject: {},
        projects: [userProject, agentProject],
        setActiveProjectId,
        settings: { ...DEFAULT_SETTINGS, followAgentBrowser: follow },
        showRightPanelView,
      }) as unknown as IdeState,
  );
  store.setState(createBrowserActions(store.setState));
  harness.store = store;
  return store;
};

const command = (
  type: "close-tab" | "open-tab" | "show-tab",
  payload: { activate?: boolean; tabId?: string; url?: string },
) =>
  runBrowserAgentCommand({
    id: "command",
    payload,
    projectId: agentProject.id,
    type,
  });

beforeEach(() => {
  resetStore();
});

test("opens an agent tab without switching the project, panel or tab", () => {
  const store = harness.store;
  store.getState().createBrowserTab(agentProject.id, "https://user.test/");
  const userTabId = store.getState().activeBrowserTabIdByProject[
    agentProject.id
  ] as string;

  const result = command("open-tab", { url: "http://localhost:3000/" });

  const state = store.getState();
  expect(result.tabId).not.toBe(userTabId);
  expect(state.activeBrowserTabIdByProject[agentProject.id]).toBe(userTabId);
  expect(state.agentBrowserTabIdsByProject[agentProject.id]).toEqual([
    result.tabId,
  ]);
  expect(
    state.browserTabsByProject[agentProject.id]?.find(
      (tab) => tab.id === result.tabId,
    )?.url,
  ).toBe("http://localhost:3000/");
  expect(setActiveProjectId).not.toHaveBeenCalled();
  expect(showRightPanelView).not.toHaveBeenCalled();
});

test("navigating a background tab holds it and leaves the active tab alone", () => {
  const store = harness.store;
  const agentTabId = command("open-tab", { url: "https://a.test/" })
    .tabId as string;
  const userTabId = store
    .getState()
    .createBrowserTab(agentProject.id, "https://user.test/") as string;

  const result = command("show-tab", {
    tabId: agentTabId,
    url: "https://b.test/",
  });

  const state = store.getState();
  expect(result.active).toBe(false);
  expect(state.activeBrowserTabIdByProject[agentProject.id]).toBe(userTabId);
  expect(state.agentBrowserTabIdsByProject[agentProject.id]).toEqual([
    agentTabId,
  ]);
  expect(showRightPanelView).not.toHaveBeenCalled();
});

test("activate brings the tab to the front", () => {
  const store = harness.store;
  const agentTabId = command("open-tab", { url: "https://a.test/" })
    .tabId as string;
  store.getState().createBrowserTab(agentProject.id, "https://user.test/");

  const result = command("show-tab", { activate: true, tabId: agentTabId });

  expect(result.active).toBe(true);
  expect(store.getState().activeBrowserTabIdByProject[agentProject.id]).toBe(
    agentTabId,
  );
  expect(setActiveProjectId).toHaveBeenCalledWith(agentProject.id);
  expect(showRightPanelView).toHaveBeenCalledWith(agentProject.id, "browser");
});

test("a background navigation, failure and close affect only the agent's tab", () => {
  const store = harness.store;
  const { createBrowserTab, updateBrowserTabStatus } = store.getState();
  const userTab = createBrowserTab(
    userProject.id,
    "https://user.test/",
  ) as string;
  updateBrowserTabStatus(userProject.id, userTab, {
    error: "user load failed",
  });
  const agentTab = command("open-tab", { url: "https://agent.test/" })
    .tabId as string;
  updateBrowserTabStatus(agentProject.id, agentTab, {
    loading: false,
    error: "agent load failed",
  });
  command("show-tab", { tabId: agentTab });
  expect(store.getState().browserStatusByTab[agentTab].error).toBe(
    "agent load failed",
  );
  command("show-tab", { tabId: agentTab, url: "https://retry.test/" });
  expect(store.getState().browserStatusByTab[agentTab].error).toBeNull();
  command("close-tab", { tabId: agentTab });
  updateBrowserTabStatus(agentProject.id, agentTab, { error: "late failure" });
  expect(store.getState().browserStatusByTab[agentTab]).toBeUndefined();
  expect(store.getState().browserStatusByTab[userTab].error).toBe(
    "user load failed",
  );
  updateBrowserTabStatus(userProject.id, userTab, { loading: true });
  expect(store.getState().browserStatusByTab[userTab]).toEqual({
    loading: true,
    error: null,
  });
});

test("following the agent reveals every tab it opens", () => {
  const store = resetStore({ follow: true });
  store.getState().createBrowserTab(agentProject.id, "https://user.test/");

  const result = command("open-tab", { url: "https://a.test/" });

  expect(store.getState().activeBrowserTabIdByProject[agentProject.id]).toBe(
    result.tabId,
  );
  expect(showRightPanelView).toHaveBeenCalledWith(agentProject.id, "browser");
});

test("closing a held tab releases it", () => {
  const store = harness.store;
  store.getState().createBrowserTab(agentProject.id, "https://user.test/");
  const agentTabId = command("open-tab", { url: "https://a.test/" })
    .tabId as string;

  command("close-tab", { tabId: agentTabId });

  expect(store.getState().agentBrowserTabIdsByProject[agentProject.id]).toEqual(
    [],
  );
});

test("a command without a tab id means the agent's most recent tab", () => {
  const store = harness.store;
  const firstTabId = command("open-tab", { url: "https://a.test/" })
    .tabId as string;
  const secondTabId = command("open-tab", { url: "https://b.test/" })
    .tabId as string;
  command("show-tab", { tabId: firstTabId });
  store.getState().createBrowserTab(agentProject.id, "https://user.test/");

  const listed = runBrowserAgentCommand({
    id: "list",
    projectId: agentProject.id,
    type: "list-tabs",
  });
  const shown = command("show-tab", { url: "https://c.test/" });

  expect(listed.agentTabId).toBe(firstTabId);
  expect(shown.tabId).toBe(firstTabId);
  expect(store.getState().agentBrowserTabIdsByProject[agentProject.id]).toEqual(
    [secondTabId, firstTabId],
  );
});
