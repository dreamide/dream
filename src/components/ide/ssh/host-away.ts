import { getClientPlatform } from "@/lib/connections/platform";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { HostConnectionState, ProjectConfig } from "@/types/ide";
import { listHostChoices } from "../../../../electron/shared/host-connections.js";
import {
  HOME_HOST_STATE,
  type HomeConnection,
  homeConnection,
  isHostReady,
  type ReachState,
} from "../store/host-reach";
import type { IdeState } from "../store/ide-store-types";

/** A project's host while it is not there to work with. */
export interface HostAway {
  hostId: string;
  label: string;
  state: HostConnectionState;
  error: string | null;
}

/**
 * `hostId` while it is not ready (store/host-reach.ts), named by `labelOf`: not
 * connected, or connected with its catalog not loaded yet (its projects
 * show from their cached snapshot). Null while it is ready.
 */
export const awayHost = (
  state: ReachState,
  hostId: string,
  labelOf: () => string,
  home: HomeConnection = homeConnection(),
): HostAway | null => {
  if (isHostReady(state, hostId, home)) return null;
  if (hostId === LOCAL_HOST_ID)
    return {
      error: home.error,
      hostId,
      label: getClientPlatform().homeLabel,
      state: HOME_HOST_STATE[home.status],
    };
  const runtime = state.hosts[hostId];
  return {
    error: runtime?.error ?? null,
    hostId,
    label: labelOf(),
    state: runtime?.state ?? "idle",
  };
};

/** Whether `project`'s host is away (`awayHost`); null while it is ready. */
export const isHostAway = (
  state: ReachState &
    Pick<IdeState, "settings"> &
    Partial<Pick<IdeState, "hostConnections">>,
  project: Pick<ProjectConfig, "hostId"> | null | undefined,
  home: HomeConnection = homeConnection(),
): HostAway | null => {
  if (!project) return null;
  const hostId = project.hostId ?? LOCAL_HOST_ID;
  return awayHost(
    state,
    hostId,
    () =>
      listHostChoices(state.hostConnections, state.settings.sshHosts).find(
        (host) => host.id === hostId,
      )?.label ?? hostId,
    home,
  );
};
