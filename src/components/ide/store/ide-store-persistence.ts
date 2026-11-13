import type { UIMessage } from "ai";
import { apiClient, type CatalogResponse } from "@/lib/api-client";
import { getClientPlatform } from "@/lib/connections/platform";
import { connectionSupervisor } from "@/lib/connections/runtime";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { PersistedIdeState, PersistedWorkspace } from "@/types/ide";
import {
  acceptHostDescriptor,
  normalizeHostConnections,
} from "../../../../electron/shared/host-connections.js";
import {
  createEmptyPersistedState,
  decodePersistedState,
  mergeWorkspaceAndCatalog,
  normalizeSshHosts,
} from "../../../../electron/shared/persisted-state-codec.js";
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
// (catalog-baselines.ts keeps them in step). The home host's catalog loads with
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

/** The workspace as loaded, for merging SSH hosts' catalogs later. */
let loadedWorkspace: PersistedWorkspace = { workspaceProjects: [] };
export const getLoadedWorkspace = () => loadedWorkspace;

/**
 * What the main process holds of the workspace, as of this window's last
 * save (the load at first): what the next save is compared against.
 */
let savedWorkspace: WorkspaceRecord | null = null;

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

/** What a window starts from. */
export interface StartupState {
  /** The workspace merged with the home host's catalog, decoded. */
  state: PersistedIdeState;
  /**
   * Whether the workspace was read. A window that could not read it holds
   * defaults and saves nothing, which would overwrite the user's settings
   * and projects with them.
   */
  workspaceLoaded: boolean;
  /**
   * The home host's catalog, when it loaded: `state` holds it, so it is the
   * home host's baseline (catalog-baselines.ts), and it says which chats
   * run or wait now. Null while only its snapshot shows.
   */
  homeCatalog: CatalogResponse | null;
}

/**
 * The workspace (from the main process) merged with the local host's
 * catalog, decoded once with the shared codec. The workspace loads first:
 * the main process answers it only after pending writes have landed, so
 * the catalog read that follows sees them too. SSH hosts' projects join
 * when their hosts connect (connectHost).
 */
export const loadPersistedIdeState = async (): Promise<StartupState> => {
  for (let attempt = 1; attempt <= STARTUP_LOAD_ATTEMPTS; attempt += 1) {
    try {
      const loaded = await loadOnce();
      workspaceLoaded = true;
      return { ...loaded, workspaceLoaded };
    } catch (error) {
      console.warn(
        `Unable to load persisted Dream state (attempt ${attempt} of ${STARTUP_LOAD_ATTEMPTS}).`,
        error,
      );
    }
  }
  // Shown empty, and never saved: the user's data is still on disk for the
  // next start.
  return {
    homeCatalog: null,
    state: createEmptyPersistedState(),
    workspaceLoaded: false,
  };
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

const loadOnce = async (): Promise<{
  homeCatalog: CatalogResponse | null;
  state: PersistedIdeState;
}> => {
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
    return { homeCatalog: loadedCatalog, state };
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

/**
 * Saves what changed in the workspace part of `encoded` to the main
 * process: config keys, saved prompts and, with `rows`, a row per project
 * (`encoded` must then hold the chats: a project's UI is checked against
 * them). Rows describe each of `hostIds` completely, the hosts with a
 * catalog baseline; any other host (not connected this session) only has
 * its rows moved.
 */
export const savePersistedWorkspace = (
  encoded: PersistedIdeState,
  { hostIds, rows }: { hostIds: ReadonlySet<string>; rows: boolean },
) => {
  if (!workspaceLoaded || !savedWorkspace) return;
  const record = savedWorkspace;
  const before = copyWorkspaceRecord(record);
  const changes = takeWorkspaceChanges(
    record,
    recordWorkspace(encoded, { rows }),
    new Set(hostIds),
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
