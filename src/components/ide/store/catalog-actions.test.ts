import { expect, test } from "vitest";
import { createStore } from "zustand/vanilla";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { createChatConfig } from "../../../../electron/shared/persisted-state-codec.js";
import { createCatalogActions } from "./catalog-actions";
import type { IdeState } from "./ide-store-types";

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
  const store = createStore<IdeState>(
    () =>
      ({
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
  store.setState(createCatalogActions(store.setState, store.getState));
  return { closed, closedChat, open, openChat, store };
};

test("catalog fields change; this window's workspace fields stay", () => {
  const { open, store } = createTestStore();

  store.getState().applyCatalogChanges({
    projects: [{ ...open, runCommand: "pnpm start", ui: { multiChat: false } }],
  });

  const updated = store.getState().projects[0];
  expect(updated?.runCommand).toBe("pnpm start");
  expect(updated?.ui.multiChat).toBe(true);
});

test("a project another window added arrives closed", () => {
  const { store } = createTestStore();
  const added = project("/work/added");

  store.getState().applyCatalogChanges({ projects: [added] });

  expect(store.getState().projects.map((item) => item.id)).not.toContain(
    added.id,
  );
  expect(store.getState().closedProjects.map((item) => item.id)).toContain(
    added.id,
  );
});

test("chats are upserted and removed, with their transcripts", () => {
  const { open, openChat, closedChat, store } = createTestStore();
  const newChat = chat(open, "From elsewhere");

  store.getState().applyCatalogChanges({
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
  const { closed, closedChat, store } = createTestStore();

  store.getState().applyCatalogChanges({ removedProjectIds: [closed.id] });

  expect(store.getState().closedProjects).toEqual([]);
  expect(store.getState().chats.some((item) => item.id === closedChat.id)).toBe(
    false,
  );
});
