/**
 * SSH hosts in the store: connecting one (the main process runs ssh and
 * the host's daemon; this window then loads the host's catalog), its state
 * as main reports it, and opening a folder on it as a project. A host's
 * projects stay in the store while it is away, so its tabs do not vanish
 * with a dropped connection.
 */
import { getDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { HostConnectionState } from "@/types/ide";
import {
  ensureActiveProject,
  getProjectHostId,
} from "../../../../electron/shared/persisted-state-codec.js";
import { forgetLoadedHost, isHostLoaded } from "./ide-store-persistence";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

// Electron prefixes errors thrown across ipcRenderer.invoke with where they
// came from; the user wants only what went wrong.
const IPC_ERROR_PREFIX =
  /^Error invoking remote method '[^']*': (?:\w*Error: )?/;

const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    IPC_ERROR_PREFIX,
    "",
  );

export const createHostActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "connectHost"
  | "resumeHosts"
  | "updateSshHost"
  | "disconnectHost"
  | "setHostStatus"
  | "openProjectOnHost"
  | "removeSshHost"
> => {
  const setHost = (
    hostId: string,
    patch: Partial<{
      state: HostConnectionState;
      error: string | null;
      loaded: boolean;
    }>,
  ) =>
    set((state) => ({
      hosts: {
        ...state.hosts,
        [hostId]: {
          ...{ error: null, loaded: false, state: "idle" as const },
          ...state.hosts[hostId],
          ...patch,
        },
      },
    }));

  const connecting = new Map<string, Promise<boolean>>();

  // The host is back: what its open projects showed while it was away (git
  // status, branches) is stale or failed to load.
  const refreshHostProjects = (hostId: string) => {
    for (const project of get().projects) {
      if (getProjectHostId(project) === hostId) {
        get().bumpProjectGitRefreshKey(project.id);
      }
    }
  };

  const connectHost: IdeState["connectHost"] = (hostId) => {
    if (hostId === LOCAL_HOST_ID) return Promise.resolve(true);
    const pending = connecting.get(hostId);
    if (pending) return pending;

    const run = (async () => {
      const desktopApi = getDesktopApi();
      const config = get().settings.sshHosts.find((host) => host.id === hostId);
      if (!desktopApi || !config) {
        setHost(hostId, {
          error: "This SSH host is not in Settings.",
          state: "failed",
        });
        return false;
      }

      setHost(hostId, { error: null, state: "connecting" });
      try {
        await desktopApi.connectHost({
          hostCommand: config.hostCommand,
          hostId,
          target: config.target,
        });
        // Reconnecting reloads; the first connect brings the projects in.
        if (isHostLoaded(hostId)) await get().reloadCatalog(hostId);
        else await get().loadHostCatalog(hostId);
        setHost(hostId, { error: null, loaded: true, state: "connected" });
        refreshHostProjects(hostId);
        return true;
      } catch (error) {
        setHost(hostId, { error: errorMessage(error), state: "failed" });
        return false;
      }
    })().finally(() => connecting.delete(hostId));
    connecting.set(hostId, run);
    return run;
  };

  // The host's catalog, once it is connected: loaded the first time,
  // reloaded after that (it may have changed while away).
  const followConnectedHost = async (hostId: string) => {
    if (isHostLoaded(hostId)) {
      await get().reloadCatalog(hostId);
    } else {
      await get().loadHostCatalog(hostId);
      setHost(hostId, { loaded: true });
    }
    refreshHostProjects(hostId);
  };

  return {
    connectHost,

    resumeHosts: async (openHostIds) => {
      const desktopApi = getDesktopApi();
      const reopen = new Set(openHostIds);
      await Promise.all(
        get().settings.sshHosts.map(async (host) => {
          // Main keeps its connections across a reload of this window; ask
          // it rather than assume nothing is connected.
          const mainState = await desktopApi
            ?.getHostState(host.id)
            .catch(() => "idle" as const);
          if (mainState === "connected") {
            // Already there: connecting returns at once, without prompts.
            await connectHost(host.id);
          } else if (
            mainState === "connecting" ||
            mainState === "reconnecting"
          ) {
            // On its way: its status event brings the catalog in.
            setHost(host.id, { error: null, state: mainState });
          } else if (reopen.has(host.id)) {
            // Projects of it were open last time: connect again.
            await connectHost(host.id);
          }
        }),
      );
    },

    updateSshHost: async (hostId, patch) => {
      const previous = get().settings.sshHosts.find(
        (host) => host.id === hostId,
      );
      if (!previous) return;
      const next = { ...previous, ...patch, id: hostId };
      get().setSettings((settings) => ({
        ...settings,
        sshHosts: settings.sshHosts.map((host) =>
          host.id === hostId ? next : host,
        ),
      }));

      // Same host, reached differently: a live connection reconnects with
      // the new settings. Its projects stay (they are keyed by the host's
      // id, which does not change).
      const reachedDifferently =
        next.target !== previous.target ||
        next.hostCommand !== previous.hostCommand;
      const live = get().hosts[hostId]?.state;
      if (
        reachedDifferently &&
        (live === "connected" ||
          live === "connecting" ||
          live === "reconnecting")
      ) {
        await getDesktopApi()?.disconnectHost(hostId);
        await connectHost(hostId);
      }
    },

    removeSshHost: async (hostId) => {
      await getDesktopApi()?.disconnectHost(hostId);
      // Out of this window only: the host's catalog is not told.
      forgetLoadedHost(hostId);
      set((state) => {
        const onHost = new Set(
          [...state.projects, ...state.closedProjects]
            .filter((project) => getProjectHostId(project) === hostId)
            .map((project) => project.id),
        );
        const { [hostId]: _removed, ...hosts } = state.hosts;
        const projects = state.projects.filter(
          (project) => !onHost.has(project.id),
        );
        return {
          activeProjectId: ensureActiveProject(projects, state.activeProjectId),
          chats: state.chats.filter((chat) => !onHost.has(chat.projectId)),
          closedProjects: state.closedProjects.filter(
            (project) => !onHost.has(project.id),
          ),
          hosts,
          projects,
          settings: {
            ...state.settings,
            sshHosts: state.settings.sshHosts.filter(
              (host) => host.id !== hostId,
            ),
          },
        };
      });
      get().persist();
    },

    disconnectHost: async (hostId) => {
      await getDesktopApi()?.disconnectHost(hostId);
      setHost(hostId, { error: null, state: "disconnected" });
    },

    setHostStatus: ({ error, hostId, state }) => {
      const previous = get().hosts[hostId]?.state;
      setHost(hostId, { error, state });
      // Connected without this window asking (back after a drop, or a
      // connection main had before this window reloaded): bring the
      // catalog in. A connect this window started does that itself.
      if (
        state === "connected" &&
        previous !== "connected" &&
        !connecting.has(hostId)
      ) {
        void followConnectedHost(hostId).catch((failure: unknown) =>
          setHost(hostId, { error: errorMessage(failure) }),
        );
      }
    },

    openProjectOnHost: async (hostId, path) => {
      const trimmed = path.trim();
      if (!trimmed) return false;
      // The host's projects must be here first: one already at this path
      // opens as itself, not as a second project the host would refuse.
      const runtime = get().hosts[hostId];
      if (runtime?.state !== "connected" || !runtime.loaded) {
        if (!(await connectHost(hostId))) return false;
      }
      get().addProject(trimmed, { hostId });
      return true;
    },
  };
};
