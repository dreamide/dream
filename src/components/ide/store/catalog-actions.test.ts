import { expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { createChatConfig } from "../../../../electron/shared/persisted-state-codec.js";
import { createCatalogActions } from "./catalog-actions";
import type { IdeState } from "./ide-store-types";
import {
  BROWSER_TAB_KEYED_STATE,
  CHAT_KEYED_STATE,
  PROJECT_KEYED_PERSISTED_STATE,
  PROJECT_KEYED_RUNTIME_STATE,
  TERMINAL_SESSION_KEYED_STATE,
} from "./project-runtime-state";

/** Every map the store registers per project, chat, terminal or tab. */
const registeredMaps = Object.fromEntries(
  [
    ...BROWSER_TAB_KEYED_STATE,
    ...CHAT_KEYED_STATE,
    ...PROJECT_KEYED_PERSISTED_STATE,
    ...PROJECT_KEYED_RUNTIME_STATE,
    ...TERMINAL_SESSION_KEYED_STATE,
  ].map((key) => [key, {}]),
);

const project = (path: string): ProjectConfig => ({
  ...createProjectConfig(path, DEFAULT_SETTINGS),
  ui: {
    ...createProjectConfig(path, DEFAULT_SETTINGS).ui,
    multiChat: true,
  },
});

const chat = (owner: ProjectConfig, title: string): ChatConfig =>
  ({ ...createChatConfig(owner, { title }), messageCount: 1 }) as ChatConfig;

const createTestStore = () => {
  const open = project("/work/open");
  const closed = project("/work/closed");
  const openChat = chat(open, "Open chat");
  const closedChat = chat(closed, "Closed chat");
  const stoppedSessions: string[] = [];
  const store = createStore<IdeState>(
    () =>
      ({
        ...registeredMaps,
        activeProjectId: open.id,
        chats: [openChat, closedChat],
        closedProjects: [closed],
        draftChatIdByProject: {},
        messagesByChatId: { [openChat.id]: [] },
        projects: [{ ...open, ui: { ...open.ui, activeChatId: openChat.id } }],
        settings: DEFAULT_SETTINGS,
        stateHydrated: true,
        streamingChatIds: {},
      }) as unknown as IdeState,
  );
  const catalog = createCatalogActions(store.setState, store.getState, {
    persist: () => {},
    terminals: {
      dropProject: vi.fn(async (projectId: string) => {
        stoppedSessions.push(
          ...(store.getState().projectTerminalSessionIds[projectId] ?? []),
        );
      }),
    },
  });
  store.setState(catalog.actions);
  return {
    catalog,
    closed,
    closedChat,
    open,
    openChat,
    stoppedSessions,
    store,
  };
};

test("catalog fields change; this window's workspace fields stay", () => {
  const { catalog, open, store } = createTestStore();

  catalog.applyCatalogChanges({
    projects: [{ ...open, runCommand: "pnpm start", ui: { multiChat: false } }],
  });

  const updated = store.getState().projects[0];
  expect(updated?.runCommand).toBe("pnpm start");
  expect(updated?.ui.multiChat).toBe(true);
});

test("a project another window added arrives closed", () => {
  const { catalog, store } = createTestStore();
  const added = project("/work/added");

  catalog.applyCatalogChanges({ projects: [added] });

  expect(store.getState().projects.map((item) => item.id)).not.toContain(
    added.id,
  );
  expect(store.getState().closedProjects.map((item) => item.id)).toContain(
    added.id,
  );
});

test("chats are upserted and removed, with their transcripts", () => {
  const { catalog, open, openChat, closedChat, store } = createTestStore();
  const newChat = chat(open, "From elsewhere");

  catalog.applyCatalogChanges({
    chats: [{ ...closedChat, title: "Renamed" }, newChat],
    removedChatIds: [openChat.id],
  });

  const { chats, messagesByChatId } = store.getState();
  expect(chats.find((item) => item.id === closedChat.id)?.title).toBe(
    "Renamed",
  );
  expect(chats.some((item) => item.id === newChat.id)).toBe(true);
  expect(chats.some((item) => item.id === openChat.id)).toBe(false);
  expect(Object.hasOwn(messagesByChatId, openChat.id)).toBe(false);
});

test("a removed project takes its chats with it", () => {
  const { catalog, closed, closedChat, store } = createTestStore();

  catalog.applyCatalogChanges({ removedProjectIds: [closed.id] });

  expect(store.getState().closedProjects).toEqual([]);
  expect(store.getState().chats.some((item) => item.id === closedChat.id)).toBe(
    false,
  );
});

test("a project its host removed has its terminals stopped and leaves no runtime state behind", () => {
  const { catalog, open, stoppedSessions, store } = createTestStore();
  store.setState({
    projectGitRefreshKeys: { [open.id]: 3 },
    projectTerminalSessionIds: { [open.id]: ["session-1"] },
    terminalStatus: { "session-1": "running" },
  } as Partial<IdeState>);

  catalog.applyCatalogChanges({ removedProjectIds: [open.id] });

  // Stopped while its session ids were still in the store.
  expect(stoppedSessions).toEqual(["session-1"]);
  const state = store.getState();
  expect(state.projects).toEqual([]);
  expect(state.projectGitRefreshKeys).toEqual({});
  expect(state.projectTerminalSessionIds).toEqual({});
  expect(state.terminalStatus).toEqual({});
});
