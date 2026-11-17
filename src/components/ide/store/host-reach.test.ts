// Reaching a Host through the owner's interface: the one readiness rule,
// reaching, and following host state with fake watchers.
import { expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { ConnectionStatus } from "@/lib/connections/supervisor";
import type { HostStatusEvent, SavedHostConnection } from "@/types/ide";
import {
  createHostReach,
  type HomeConnection,
  isHostConnected,
  isHostReady,
  recoverableHostIds,
} from "./host-reach";
import type { HostRuntimeState, IdeState } from "./ide-store-types";

const home = (status: ConnectionStatus): HomeConnection => ({
  error: null,
  status,
});
const host = (
  state: HostRuntimeState["state"],
  loaded: boolean,
  routeId?: string,
): HostRuntimeState => ({
  error: null,
  loaded,
  state,
  ...(routeId ? { routeId } : {}),
});

test("a host is ready when connected with its catalog loaded, the home host when ready and hydrated", () => {
  const hosts = {
    away: host("reconnecting", true),
    failed: host("failed", false),
    loading: host("connected", false),
    there: host("connected", true),
  };
  const rows: [string, boolean, ConnectionStatus, boolean][] = [
    // host, hydrated, home connection, ready
    ["local", true, "ready", true],
    ["local", false, "ready", false],
    ["local", true, "connecting", false],
    ["local", true, "reconnecting", false],
    ["local", true, "offline", false],
    ["local", true, "unauthorized", false],
    ["local", true, "incompatible", false],
    ["there", true, "ready", true],
    ["there", true, "offline", true],
    ["loading", true, "ready", false],
    ["away", true, "ready", false],
    ["failed", true, "ready", false],
    ["unknown", true, "ready", false],
  ];
  for (const [hostId, stateHydrated, status, ready] of rows) {
    expect(
      isHostReady({ hosts, stateHydrated }, hostId, home(status)),
      `${hostId} hydrated=${stateHydrated} home=${status}`,
    ).toBe(ready);
  }

  // Connected is the transport alone.
  expect(isHostConnected({ hosts }, "loading", home("offline"))).toBe(true);
  expect(isHostConnected({ hosts }, "away", home("ready"))).toBe(false);
  expect(isHostConnected({ hosts }, "local", home("ready"))).toBe(true);
  expect(isHostConnected({ hosts }, "local", home("reconnecting"))).toBe(false);
});

test("recovery may bring a catalog in for the home host and every connected host, once hydrated", () => {
  const hosts = {
    away: host("reconnecting", true),
    loading: host("connected", false),
    there: host("connected", true),
  };
  expect(recoverableHostIds({ hosts, stateHydrated: false })).toEqual([]);
  expect(recoverableHostIds({ hosts, stateHydrated: true })).toEqual([
    "local",
    "loading",
    "there",
  ]);
});

test("reach resolves at once for the home host and a ready host, and connects any other", async () => {
  const connect = vi.fn(async () => true);
  let status: ConnectionStatus = "offline";
  const state = {
    connectHost: connect,
    hosts: {
      loading: host("connected", false),
      there: host("connected", true),
    },
    stateHydrated: true,
  } as unknown as IdeState;
  const reach = createHostReach(() => state, {
    connect,
    home: () => home(status),
  });

  // The home host is not connected from here, ready or not.
  await expect(reach.reach("local")).resolves.toBe(true);
  status = "ready";
  await expect(reach.reach("local")).resolves.toBe(true);
  await expect(reach.reach("there")).resolves.toBe(true);
  expect(connect).not.toHaveBeenCalled();

  await expect(reach.reach("loading")).resolves.toBe(true);
  connect.mockResolvedValueOnce(false);
  await expect(reach.reach("never")).resolves.toBe(false);
  expect(connect.mock.calls).toEqual([["loading"], ["never"]]);

  expect(reach.isReady(state, "local")).toBe(true);
  status = "reconnecting";
  expect(reach.isReady(state, "local")).toBe(false);
});

/** A followed store with fake watchers and a fake desktop. */
const following = ({
  desktop = { hostMode: "in-process" as const },
  hosts = {},
  connections = [],
}: {
  desktop?: { hostMode?: "detached" | "in-process" } | null;
  hosts?: IdeState["hosts"];
  connections?: SavedHostConnection[];
}) => {
  const log: string[] = [];
  const statusListeners = new Set<(event: HostStatusEvent) => void>();
  const setHostStatus = vi.fn();
  const store = createStore<IdeState>(
    () =>
      ({
        hostConnections: connections,
        hosts,
        setHostStatus,
      }) as unknown as IdeState,
  );
  const reach = createHostReach(store.getState, {
    connect: async () => true,
    desktop: () =>
      desktop && {
        ...desktop,
        onHostStatus: (listener) => {
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
      },
    home: () => home("ready"),
    watchBrowser: (hostId, followed) => {
      expect(followed).toBe(store);
      log.push(`browser ${hostId}`);
      return () => log.push(`stop browser ${hostId}`);
    },
    watchCatalog: (hostId, followed) => {
      expect(followed).toBe(store);
      log.push(`catalog ${hostId}`);
      return () => log.push(`stop catalog ${hostId}`);
    },
  });
  const stop = reach.follow(store);
  const take = () => log.splice(0);
  return { setHostStatus, statusListeners, stop, store, take };
};

test("follows the home host always and other hosts once loaded, lending the browser to SSH hosts", () => {
  const { store, stop, take } = following({
    hosts: {
      devbox: host("connected", true, "ssh-1"),
      loading: host("connected", false),
    },
  });
  // An attached home host has the browser already; an SSH host borrows it.
  expect(take()).toEqual(["catalog local", "catalog devbox", "browser devbox"]);

  store.setState({
    hosts: {
      devbox: host("connected", true, "ssh-1"),
      loading: host("connected", true),
    },
  });
  expect(take()).toEqual(["catalog loading", "browser loading"]);

  // Losing its catalog stops a host's watchers; so does leaving the store.
  store.setState({ hosts: { devbox: host("reconnecting", false, "ssh-1") } });
  expect(take()).toEqual([
    "stop catalog devbox",
    "stop browser devbox",
    "stop catalog loading",
    "stop browser loading",
  ]);

  stop();
  expect(take()).toEqual(["stop catalog local"]);
  store.setState({ hosts: { devbox: host("connected", true) } });
  expect(take()).toEqual([]);
});

test("a host watched again when its route changes, and not lent the browser over HTTPS", () => {
  const { store, stop, take } = following({
    connections: [
      {
        id: "paired",
        routes: [
          { id: "ssh-1", kind: "ssh" },
          { id: "https-1", kind: "https" },
        ],
      } as unknown as SavedHostConnection,
    ],
    hosts: { paired: host("connected", true, "ssh-1") },
  });
  expect(take()).toEqual(["catalog local", "catalog paired", "browser paired"]);

  // Another change with the same route keeps its watchers.
  store.setState({
    hosts: { paired: { ...host("connected", true, "ssh-1"), error: "x" } },
  });
  expect(take()).toEqual([]);

  store.setState({ hosts: { paired: host("connected", true, "https-1") } });
  expect(take()).toEqual([
    "stop catalog paired",
    "stop browser paired",
    "catalog paired",
  ]);

  store.setState({ hosts: { paired: host("connected", true, "ssh-1") } });
  expect(take()).toEqual([
    "stop catalog paired",
    "catalog paired",
    "browser paired",
  ]);
  stop();
});

test("a detached home host borrows the browser; a browser client lends none", () => {
  const detached = following({ desktop: { hostMode: "detached" } });
  expect(detached.take()).toEqual(["catalog local", "browser local"]);
  detached.stop();
  expect(detached.take()).toEqual(["stop catalog local", "stop browser local"]);

  const web = following({
    desktop: null,
    hosts: { devbox: host("connected", true) },
  });
  expect(web.take()).toEqual(["catalog local", "catalog devbox"]);
  web.stop();
});

test("main's host status reports reach the store while following", () => {
  const { setHostStatus, statusListeners, stop } = following({});
  const event: HostStatusEvent = {
    error: null,
    hostId: "devbox",
    state: "connected",
    version: null,
  };
  for (const listener of statusListeners) listener(event);
  expect(setHostStatus).toHaveBeenCalledExactlyOnceWith(event);
  stop();
  expect(statusListeners.size).toBe(0);
});
