/** Binds existing store owners to the Connection runtime's recovery policy. */

import type { ConnectionRecovery } from "@/lib/connections/recovery";
import {
  connectionRecovery,
  connectionSupervisor,
} from "@/lib/connections/runtime";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { reattachChatStreams } from "../chat/chat-runtime";
import { catalogBaselines } from "./catalog-baselines";
import {
  HostIdentityError,
  hostCatalogLifecycle,
} from "./host-catalog-lifecycle";
import type { IdeState, IdeStoreSet } from "./ide-store-types";

export const followConnections = (
  store: {
    setState: IdeStoreSet;
    getState: () => IdeState;
  },
  recovery: ConnectionRecovery = connectionRecovery,
) => {
  const catalogs = hostCatalogLifecycle(store.setState, store.getState);
  return recovery.bindWorkspace({
    hosts: () =>
      store.getState().stateHydrated
        ? [
            LOCAL_HOST_ID,
            ...Object.entries(store.getState().hosts)
              .filter(([, host]) => host.state === "connected")
              .map(([id]) => id),
          ]
        : [],
    isLoaded: catalogBaselines.hasBaseline,
    catalogs: {
      suspend: catalogs.suspend,
      resume: catalogs.resume,
      async refresh(hostId) {
        try {
          await catalogs.refresh(hostId);
        } catch (error) {
          // Main reports its own refusals with the status (host-actions.ts).
          // This is the window's own catalog check, which main cannot make:
          // the home host, a host another connection already has, or ids
          // that collide with another host's.
          if (error instanceof HostIdentityError)
            connectionSupervisor.set(hostId, "incompatible", error.message);
          throw error;
        }
      },
    },
    reattach: reattachChatStreams,
  });
};
