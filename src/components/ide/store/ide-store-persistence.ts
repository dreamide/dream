import type { UIMessage } from "ai";
import { apiClient, type CatalogResponse } from "@/lib/api-client";
import { getDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID, resolveRequestHost } from "@/lib/host-routing";
import type {
  ChatConfig,
  PersistedIdeState,
  PersistedWorkspace,
  ProjectConfig,
} from "@/types/ide";
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

// Where persisted state lives. The client's workspace (config, saved
// prompts, which projects are open on which host, their UI) is the main
// process's, over IPC. Projects, chats and transcripts are each host's
// catalog, over that host's API (catalog-sync.ts keeps them in step). The
// local host's catalog loads with the workspace; an SSH host's when it
// connects. Until then its projects show as their workspace rows cached
// them (codec mergeWorkspaceAndCatalog, snapshotHostIds).

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

const requireDesktopApi = () => {
  const desktopApi = getDesktopApi();
  if (!desktopApi) {
    throw new Error("Dream desktop API is unavailable.");
  }

  return desktopApi;
};

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

/** The workspace as loaded, for merging SSH hosts' catalogs later. */
let loadedWorkspace: PersistedWorkspace = { workspaceProjects: [] };
export const getLoadedWorkspace = () => loadedWorkspace;

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

/** The local host's link (kept for callers that predate SSH hosts). */
export const catalogSync = getCatalogSync(LOCAL_HOST_ID);

/** `hostId`'s catalog, raw. */
export const loadCatalog = (
  hostId: string = LOCAL_HOST_ID,
  timeoutMs: number = STATE_LOAD_TIMEOUT_MS,
): Promise<CatalogResponse> =>
  withTimeout(
    apiClient.catalog({}, { hostId }),
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

const loadOnce = async (): Promise<PersistedIdeState> => {
  const desktopApi = requireDesktopApi();
  {
    const workspace = await withTimeout(
      desktopApi.loadState(),
      STARTUP_LOAD_TIMEOUT_MS,
      "Timed out loading persisted Dream state.",
    );
    loadedWorkspace = workspace;
    const catalog = await loadCatalog(LOCAL_HOST_ID, STARTUP_LOAD_TIMEOUT_MS);
    loadedRunningChatIds = catalog.runningChatIds ?? [];
    // SSH hosts still in Settings show their projects from the snapshot.
    const snapshotHostIds = normalizeSshHosts(
      (workspace.settings as { sshHosts?: unknown } | undefined)?.sshHosts,
    ).map((host) => host.id);
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
 * Saves `encoded` (what deserves saving): its workspace part to the main
 * process, describing every loaded host completely, and what changed in
 * each loaded host's catalog to that host. `live` is the store's unencoded
 * state, which decides what was removed. A host not loaded yet (not
 * connected this session) is left alone on both sides.
 */
export const savePersistedIdeState = (
  encoded: PersistedIdeState,
  live: CatalogState,
) => {
  if (!workspaceLoaded) return;
  const describedHostIds = [...loadedHostIds];
  void requireDesktopApi().saveState({
    ...encoded,
    describedHostIds,
  } as PersistedIdeState);

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
  for (const hostId of describedHostIds) {
    void getCatalogSync(hostId).push(
      liveParts.get(hostId) ?? emptyCatalogState(),
      encodedParts.get(hostId) ?? emptyCatalogState(),
    );
  }
};

export const savePersistedChatMessages = async (
  chatId: string,
  messages: UIMessage[],
) => {
  await getCatalogSync(resolveRequestHost({ chatId })).saveTranscript(
    chatId,
    messages,
  );
};

export const savePersistedActiveProject = (
  activeProjectId: string | null,
  lastUsedAt: string | null,
) => {
  if (!workspaceLoaded) return;
  const desktopApi = requireDesktopApi();
  if (typeof desktopApi.saveActiveProject !== "function") {
    return;
  }

  void desktopApi
    .saveActiveProject({
      activeProjectId,
      lastUsedAt,
    })
    .catch((error: unknown) => {
      console.warn("Unable to persist the active Dream project.", error);
    });
};
