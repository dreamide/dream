import type { HostConnectionState, ProjectConfig } from "@/types/ide";
import type { IdeState } from "../store/ide-store-types";

/** A project's SSH host while it is not there to work with. */
export interface HostAway {
  hostId: string;
  label: string;
  state: HostConnectionState;
  error: string | null;
}

/**
 * Whether `project`'s host is away: an SSH host not connected, or connected
 * but with its catalog not loaded yet (the project shows from its cached
 * snapshot). Null for a local project and for a host that is there.
 */
export const isHostAway = (
  state: Pick<IdeState, "hosts" | "settings">,
  project: Pick<ProjectConfig, "hostId"> | null | undefined,
): HostAway | null => {
  const hostId = project?.hostId;
  if (!hostId) return null;
  const runtime = state.hosts[hostId];
  if (runtime?.state === "connected" && runtime.loaded) return null;
  return {
    error: runtime?.error ?? null,
    hostId,
    label:
      state.settings.sshHosts.find((host) => host.id === hostId)?.label ??
      hostId,
    state: runtime?.state ?? "idle",
  };
};
