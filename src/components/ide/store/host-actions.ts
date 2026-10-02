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

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const createHostActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "connectHost"
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

  return {
    connectHost,

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
      // Back after a drop: catch up with what changed meanwhile.
      if (
        state === "connected" &&
        previous === "reconnecting" &&
        isHostLoaded(hostId)
      ) {
        void get()
          .reloadCatalog(hostId)
          .then(() => refreshHostProjects(hostId));
      }
    },

    openProjectOnHost: async (hostId, path) => {
      const trimmed = path.trim();
      if (!trimmed) return false;
      if (get().hosts[hostId]?.state !== "connected") {
        if (!(await connectHost(hostId))) return false;
      }
      get().addProject(trimmed, { hostId });
      return true;
    },
  };
};
