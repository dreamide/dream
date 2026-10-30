import type { UIMessage } from "ai";
import { apiClient, type CatalogResponse } from "@/lib/api-client";
import { getClientPlatform } from "@/lib/connections/platform";
import { connectionSupervisor } from "@/lib/connections/runtime";
import { LOCAL_HOST_ID, resolveRequestHost } from "@/lib/host-routing";
import type {
  ChatConfig,
  PersistedIdeState,
  PersistedWorkspace,
  ProjectConfig,
} from "@/types/ide";
import {
  acceptHostDescriptor,
  normalizeHostConnections,
} from "../../../../electron/shared/host-connections.js";
import {
  createEmptyPersistedState,
  decodePersistedState,
  getProjectHostId,
  mergeWorkspaceAndCatalog,
  normalizeSshHosts,
} from "../../../../electron/shared/persisted-state-codec.js";
import {
  type CatalogConflict,
  type CatalogState,
  createCatalogSync,
} from "./catalog-sync";
import {
  copyWorkspaceRecord,
  recordLoadedWorkspace,
  recordWorkspace,
  restoreUnsent,
  takeWorkspaceChanges,
  type WorkspaceRecord,
} from "./workspace-save";

// Where persisted state lives. The client's workspace (config, saved
// prompts, which projects are open on which host, their UI) is the
// client's own: the main process's database on the desktop, IndexedDB in
// a browser (connections/workspace-storage.ts). Projects, chats and
// transcripts are each host's catalog, over that host's API
// (catalog-sync.ts keeps them in step). The home host's catalog loads with
// the workspace; an SSH host's when it connects. Until then its projects
// show as their workspace rows cached them (codec mergeWorkspaceAndCatalog,
// snapshotHostIds). A browser client whose home host cannot be reached at
// startup shows the home host's projects that way too, until it can.

const STATE_LOAD_TIMEOUT_MS = 8000;
/**
 * Loading at startup: the local API can be slow while the app starts, so
 * each part gets longer, and the whole load a few tries.
 */
const STARTUP_LOAD_TIMEOUT_MS = 30_000;
const STARTUP_LOAD_ATTEMPTS = 3;

/**
 * Whether this window loaded the workspace. Until it has, it saves nothing:
 * a window that could not load holds defaults, and saving them would
 * overwrite the user's settings and projects with them.
 */
let workspaceLoaded = false;
export const isWorkspaceLoaded = () => workspaceLoaded;

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
};

/** The chats with a turn running on the local host at its catalog load. */
let loadedRunningChatIds: string[] = [];
export const getLoadedRunningChatIds = () => loadedRunningChatIds;
let loadedAwaitingApprovalChatIds: string[] = [];
export const getLoadedAwaitingApprovalChatIds = () =>
  loadedAwaitingApprovalChatIds;

/**
 * The local host's descriptor from its startup catalog load, accepted once
 * the store has hydrated (so a newly saved connection is saved).
 */
let loadedLocalHost: CatalogResponse["host"];
export const getLoadedLocalHost = () => loadedLocalHost;

/** The workspace as loaded, for merging SSH hosts' catalogs later. */
let loadedWorkspace: PersistedWorkspace = { workspaceProjects: [] };
export const getLoadedWorkspace = () => loadedWorkspace;

/**
 * What the main process holds of the workspace, as of this window's last
 * save (the load at first): what the next save is compared against.
 */
let savedWorkspace: WorkspaceRecord | null = null;

/** Hosts whose catalog this window has loaded (and so saves for). */
const loadedHostIds = new Set<string>();
export const isHostLoaded = (hostId: string) => loadedHostIds.has(hostId);
export const markHostLoaded = (hostId: string) => {
  loadedHostIds.add(hostId);
};
export const forgetLoadedHost = (hostId: string) => {
  loadedHostIds.delete(hostId);
  catalogSyncs.delete(hostId);
};

const catalogSyncs = new Map<string, ReturnType<typeof createCatalogSync>>();

/** Who resolves projects a host refused (the store registers it). */
let conflictHandler: (hostId: string, conflicts: CatalogConflict[]) => void =
  () => {};
export const setCatalogConflictHandler = (
  handler: (hostId: string, conflicts: CatalogConflict[]) => void,
) => {
  conflictHandler = handler;
};

/** The store's link to `hostId`'s catalog. */
export const getCatalogSync = (hostId: string = LOCAL_HOST_ID) => {
  let sync = catalogSyncs.get(hostId);
  if (!sync) {
    const onHost = { hostId };
    sync = createCatalogSync({
      api: {
        catalogChanges: (changes, options) =>
          apiClient.catalogChanges(changes, { ...options, ...onHost }),
        saveCatalogTranscript: (payload, options) =>
          apiClient.saveCatalogTranscript(payload, { ...options, ...onHost }),
      },
      onConflicts: (conflicts) => conflictHandler(hostId, conflicts),
    });
    catalogSyncs.set(hostId, sync);
  }
  return sync;
};

/** `hostId`'s catalog, raw. */
export const loadCatalog = (
  hostId: string = LOCAL_HOST_ID,
  timeoutMs: number = STATE_LOAD_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CatalogResponse> =>
  withTimeout(
    apiClient.catalog({}, { hostId, signal }),
    timeoutMs,
    `Timed out loading the catalog of host ${hostId}.`,
  );

/**
 * The workspace (from the main process) merged with the local host's
 * catalog, decoded once with the shared codec. The workspace loads first:
 * the main process answers it only after pending writes have landed, so
 * the catalog read that follows sees them too. SSH hosts' projects join
 * when their hosts connect (connectHost).
 */
export const loadPersistedIdeState = async (): Promise<PersistedIdeState> => {
  for (let attempt = 1; attempt <= STARTUP_LOAD_ATTEMPTS; attempt += 1) {
    try {
      const state = await loadOnce();
      workspaceLoaded = true;
      return state;
    } catch (error) {
      console.warn(
        `Unable to load persisted Dream state (attempt ${attempt} of ${STARTUP_LOAD_ATTEMPTS}).`,
        error,
      );
    }
  }
  // Shown empty, and never saved (isWorkspaceLoaded): the user's data is
  // still on disk for the next start.
  return createEmptyPersistedState();
};

/**
 * The home host's projects as its workspace rows cached them, as a catalog
 * with no chats: what a browser client shows while its home host is away.
 */
const snapshotCatalog = (workspace: PersistedWorkspace): CatalogResponse => ({
  chats: [],
  projects: workspace.workspaceProjects
    .filter(
      (entry) =>
        entry.hostId === LOCAL_HOST_ID &&
        typeof entry.snapshot?.path === "string" &&
        entry.snapshot.path.trim() !== "",
    )
    .map((entry) => ({ ...entry.snapshot, id: entry.projectId })),
});

/**
 * The home host's catalog at startup. On the desktop it is this app's own
 * host, so the load waits for it (and is retried). A browser client's is
 * across the network: when it cannot be had (offline, not paired) the
 * workspace still opens, from the snapshot, and `null` says the catalog
 * is still to come.
 */
const loadHomeCatalog = async (
  workspace: PersistedWorkspace,
): Promise<CatalogResponse | null> => {
  const platform = getClientPlatform();
  if (!platform.hasHomeHost) return null;
  if (platform.kind === "desktop") {
    return loadCatalog(LOCAL_HOST_ID, STARTUP_LOAD_TIMEOUT_MS);
  }
  let catalog: CatalogResponse;
  try {
    catalog = await loadCatalog(LOCAL_HOST_ID, STATE_LOAD_TIMEOUT_MS);
  } catch (error) {
    console.warn("The home host's catalog is not available yet.", error);
    return null;
  }
  // Whose catalog this is, before any of it is shown: the origin may now
  // serve another host than the one this client paired with.
  const { error } = acceptHostDescriptor(
    normalizeHostConnections(workspace.hostConnections),
    {
      connectionId: LOCAL_HOST_ID,
      descriptor: catalog.host,
      homeRoute: platform.homeRoute,
      labelOf: () => platform.homeLabel,
    },
  );
  if (error) {
    connectionSupervisor.set(LOCAL_HOST_ID, "incompatible", error);
    return null;
  }
  return catalog;
};

const loadOnce = async (): Promise<PersistedIdeState> => {
  const storage = getClientPlatform().workspace;
  {
    const workspace = await withTimeout(
      storage.load(),
      STARTUP_LOAD_TIMEOUT_MS,
      "Timed out loading persisted Dream state.",
    );
    loadedWorkspace = workspace;
    savedWorkspace = recordLoadedWorkspace(workspace);
    const loadedCatalog = await loadHomeCatalog(workspace);
    const catalog = loadedCatalog ?? snapshotCatalog(workspace);
    loadedRunningChatIds = catalog.runningChatIds ?? [];
    loadedAwaitingApprovalChatIds = catalog.awaitingApprovalChatIds ?? [];
    loadedLocalHost = loadedCatalog?.host;
    // SSH hosts still in Settings show their projects from the snapshot.
    const snapshotHostIds = [
      ...normalizeHostConnections(workspace.hostConnections).map(
        (host) => host.id,
      ),
      ...normalizeSshHosts(
        (workspace.settings as { sshHosts?: unknown } | undefined)?.sshHosts,
      ).map((host) => host.id),
    ];
    const state = decodePersistedState(
      mergeWorkspaceAndCatalog({
        catalog,
        hostId: LOCAL_HOST_ID,
        snapshotHostIds,
        workspace,
      }),
    );
    // The local host's baseline is its own projects and their chats only:
    // an SSH host's projects shown from the snapshot are not the local
    // host's, and counting them as synced here would have its next reload
    // remove them (and the next save delete them on their host).
    const localProjectIds = new Set(
      [...state.projects, ...state.closedProjects]
        .filter((project) => getProjectHostId(project) === LOCAL_HOST_ID)
        .map((project) => project.id),
    );
    // A catalog shown from the snapshot is not the host's: nothing of it
    // is synced or saved there until the real one has loaded.
    if (!loadedCatalog) return state;
    getCatalogSync(LOCAL_HOST_ID).reset({
      chats: state.chats.filter((chat) => localProjectIds.has(chat.projectId)),
      closedProjects: state.closedProjects.filter((project) =>
        localProjectIds.has(project.id),
      ),
      projects: state.projects.filter((project) =>
        localProjectIds.has(project.id),
      ),
    });
    markHostLoaded(LOCAL_HOST_ID);
    return state;
  }
};

export const loadPersistedChatMessages = async (
  chatId: string,
): Promise<UIMessage[]> => {
  try {
    // The route client sends it to the host of the chat's project.
    return await withTimeout(
      apiClient.catalogTranscript({ chatId }),
      STATE_LOAD_TIMEOUT_MS,
      `Timed out loading messages for chat ${chatId}.`,
    );
  } catch (error) {
    console.warn(`Unable to load messages for chat ${chatId}.`, error);
    throw error;
  }
};

/** `state` split by host: each project, and each chat by its project. */
const partitionByHost = (
  state: CatalogState,
  hostOf: (projectId: string) => string,
) => {
  const parts = new Map<string, CatalogState>();
  const part = (hostId: string) => {
    let entry = parts.get(hostId);
    if (!entry) {
      entry = { chats: [], closedProjects: [], projects: [] };
      parts.set(hostId, entry);
    }
    return entry;
  };
  for (const project of state.projects) {
    part(getProjectHostId(project)).projects.push(project);
  }
  for (const project of state.closedProjects) {
    part(getProjectHostId(project)).closedProjects.push(project);
  }
  for (const chat of state.chats) {
    part(hostOf(chat.projectId)).chats.push(chat);
  }
  return parts;
};

const emptyCatalogState = (): CatalogState => ({
  chats: [],
  closedProjects: [],
  projects: [],
});

/**
 * Saves what changed in the workspace part of `encoded` to the main
 * process: config keys, saved prompts and, with `rows`, a row per project
 * (`encoded` must then hold the chats: a project's UI is checked against
 * them). Rows describe every loaded host completely; a host not loaded yet
 * (not connected this session) only has its rows moved.
 */
export const savePersistedWorkspace = (
  encoded: PersistedIdeState,
  { rows }: { rows: boolean },
) => {
  if (!workspaceLoaded || !savedWorkspace) return;
  const record = savedWorkspace;
  const before = copyWorkspaceRecord(record);
  const changes = takeWorkspaceChanges(
    record,
    recordWorkspace(encoded, { rows }),
    new Set(loadedHostIds),
  );
  if (!changes) return;
  void getClientPlatform()
    .workspace.saveChanges(changes)
    .catch((error: unknown) => {
      console.warn("Unable to save the Dream workspace.", error);
      // Sent again with the next save.
      restoreUnsent(record, changes, before);
    });
};

/**
 * Sends what changed in each loaded host's catalog to that host. `live` is
 * the store's unencoded state, which decides what was removed; `encoded`
 * what deserves saving. A host not loaded yet is left alone.
 */
export const pushPersistedCatalogs = (
  encoded: PersistedIdeState,
  live: CatalogState,
) => {
  if (!workspaceLoaded) return;
  const hostByProjectId = new Map<string, string>();
  for (const project of [
    ...live.projects,
    ...live.closedProjects,
  ] as ProjectConfig[]) {
    hostByProjectId.set(project.id, getProjectHostId(project));
  }
  const hostOf = (projectId: string) =>
    hostByProjectId.get(projectId) ?? LOCAL_HOST_ID;
  const liveParts = partitionByHost(live, hostOf);
  const encodedParts = partitionByHost(
    {
      chats: encoded.chats as ChatConfig[],
      closedProjects: encoded.closedProjects,
      projects: encoded.projects,
    },
    hostOf,
  );
  for (const hostId of loadedHostIds) {
    void getCatalogSync(hostId).push(
      liveParts.get(hostId) ?? emptyCatalogState(),
      encodedParts.get(hostId) ?? emptyCatalogState(),
    );
  }
};

export const savePersistedChatMessages = async (
  chatId: string,
  messages: UIMessage[],
  mergeOnly = false,
) => {
  await getCatalogSync(resolveRequestHost({ chatId })).saveTranscript(
    chatId,
    messages,
    mergeOnly,
  );
};

export const ensureHostChat = (project: ProjectConfig, chat: ChatConfig) =>
  getCatalogSync(getProjectHostId(project)).ensureChat(project, chat);
