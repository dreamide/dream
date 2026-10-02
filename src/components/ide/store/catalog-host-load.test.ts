// An SSH host's catalog arriving after its projects showed from the
// workspace snapshot: the real projects replace the snapshot ones where the
// tabs are now.
import { expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { PersistedWorkspaceProject, ProjectConfig } from "@/types/ide";
import {
  createChatConfig,
  projectToWorkspaceRow,
} from "../../../../electron/shared/persisted-state-codec.js";
import { createCatalogActions } from "./catalog-actions";
import type { IdeState } from "./ide-store-types";

const hostState = vi.hoisted(() => ({
  catalog: { chats: [] as unknown[], projects: [] as unknown[] },
  workspaceProjects: [] as unknown[],
}));

vi.mock("./ide-store-persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ide-store-persistence")>()),
  getLoadedWorkspace: () => ({
    workspaceProjects: hostState.workspaceProjects,
  }),
  loadCatalog: async () => ({ ...hostState.catalog, runningChatIds: [] }),
}));

const onDevbox = (path: string, name: string): ProjectConfig => ({
  ...createProjectConfig(path, DEFAULT_SETTINGS),
  hostId: "devbox",
  name,
});

test("a host's catalog replaces its snapshot projects in place", async () => {
  const localA = createProjectConfig("/local/a", DEFAULT_SETTINGS);
  const remote = onDevbox("/srv/app", "App (snapshot)");
  const remoteClosed = onDevbox("/srv/old", "Old (snapshot)");
  const localB = createProjectConfig("/local/b", DEFAULT_SETTINGS);
  const remoteChat = {
    ...createChatConfig(remote, { title: "Remote chat" }),
    messageCount: 3,
  };

  // Saved by a window that had devbox: the remote project open between
  // the two local ones, its chat open.
  hostState.workspaceProjects = [
    projectToWorkspaceRow(
      {
        ...remote,
        ui: { ...remote.ui, activeChatId: remoteChat.id },
      },
      "open",
      1,
    ),
    projectToWorkspaceRow(remoteClosed, "open", 3),
  ] as PersistedWorkspaceProject[];
  hostState.catalog = {
    chats: [remoteChat],
    projects: [
      { ...remote, hostId: undefined, name: "App" },
      { ...remoteClosed, hostId: undefined, name: "Old" },
    ],
  };

  // Meanwhile, from the snapshot: the old one was closed while away.
  const store = createStore<IdeState>(
    () =>
      ({
        activeProjectId: remote.id,
        chats: [],
        closedProjects: [remoteClosed],
        draftChatIdByProject: {},
        hostRunningChatIds: {},
        messagesByChatId: {},
        projects: [localA, remote, localB],
        settings: DEFAULT_SETTINGS,
        stateHydrated: true,
        streamingChatIds: {},
      }) as unknown as IdeState,
  );
  store.setState(createCatalogActions(store.setState, store.getState));

  await store.getState().loadHostCatalog("devbox");

  const state = store.getState();
  expect(state.projects.map((project) => project.name)).toEqual([
    localA.name,
    "App",
    localB.name,
  ]);
  expect(state.projects[1]?.hostId).toBe("devbox");
  expect(state.projects[1]?.ui.activeChatId).toBe(remoteChat.id);
  expect(state.closedProjects.map((project) => project.name)).toEqual(["Old"]);
  expect(
    state.chats
      .filter((chat) => chat.projectId === remote.id)
      .map((chat) => chat.id),
  ).toEqual([remoteChat.id]);
  expect(state.activeProjectId).toBe(remote.id);
});
