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

test("a project the host refused (it has one at that path) becomes the host's project, in place, with its chats", async () => {
  const localA = createProjectConfig("/local/a", DEFAULT_SETTINGS);
  const refused = onDevbox("/srv/app", "App (new)");
  const kept = onDevbox("/srv/app", "App");
  const refusedChat = {
    ...createChatConfig(refused, { title: "Started here" }),
    messageCount: 2,
  };
  hostState.workspaceProjects = [];
  hostState.catalog = {
    chats: [],
    projects: [{ ...kept, hostId: undefined }],
  };

  let saves = 0;
  const store = createStore<IdeState>(
    () =>
      ({
        activeProjectId: refused.id,
        chats: [refusedChat],
        closedProjects: [],
        draftChatIdByProject: {},
        hostRunningChatIds: {},
        messagesByChatId: {},
        persist: () => {
          saves += 1;
        },
        projects: [localA, refused],
        settings: DEFAULT_SETTINGS,
        stateHydrated: true,
        streamingChatIds: {},
      }) as unknown as IdeState,
  );
  store.setState(createCatalogActions(store.setState, store.getState));

  await store
    .getState()
    .adoptHostProjects("devbox", [{ existingId: kept.id, id: refused.id }]);

  const state = store.getState();
  expect(state.projects.map((project) => project.id)).toEqual([
    localA.id,
    kept.id,
  ]);
  expect(state.projects[1]?.hostId).toBe("devbox");
  expect(state.closedProjects.map((project) => project.id)).not.toContain(
    kept.id,
  );
  expect(state.activeProjectId).toBe(kept.id);
  expect(
    state.chats.find((chat) => chat.id === refusedChat.id)?.projectId,
  ).toBe(kept.id);
  expect(saves).toBe(1);
});

test("the local host's reload never removes an SSH host's project", async () => {
  const local = createProjectConfig("/local/a", DEFAULT_SETTINGS);
  const remote = onDevbox("/srv/app", "App");
  const remoteChat = {
    ...createChatConfig(remote, { title: "Remote chat" }),
    messageCount: 1,
  };
  const store = createStore<IdeState>(
    () =>
      ({
        activeProjectId: remote.id,
        chats: [remoteChat],
        closedProjects: [],
        draftChatIdByProject: {},
        hostRunningChatIds: {},
        messagesByChatId: {},
        projects: [local, remote],
        settings: DEFAULT_SETTINGS,
        stateHydrated: true,
        streamingChatIds: {},
      }) as unknown as IdeState,
  );
  store.setState(createCatalogActions(store.setState, store.getState));

  // The local host says these are gone: they were never its own.
  store.getState().applyCatalogChanges({
    removedChatIds: [remoteChat.id],
    removedProjectIds: [remote.id],
  });

  const state = store.getState();
  expect(state.projects.map((project) => project.id)).toEqual([
    local.id,
    remote.id,
  ]);
  expect(state.chats.map((chat) => chat.id)).toContain(remoteChat.id);
  expect(state.activeProjectId).toBe(remote.id);

  // Its own host can remove it.
  store
    .getState()
    .applyCatalogChanges({ removedProjectIds: [remote.id] }, "devbox");
  expect(store.getState().projects.map((project) => project.id)).not.toContain(
    remote.id,
  );
});
