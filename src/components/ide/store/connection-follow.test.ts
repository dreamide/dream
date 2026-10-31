import { expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createConnectionRecovery } from "@/lib/connections/recovery";
import { createConnectionSupervisor } from "@/lib/connections/supervisor";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import { reattachChatStreams } from "../chat/chat-runtime";
import { followConnections } from "./connection-follow";
import { hostCatalogLifecycle } from "./host-catalog-lifecycle";
import { loadCatalog } from "./ide-store-persistence";
import type { IdeState } from "./ide-store-types";

vi.mock("../chat/chat-runtime", () => ({ reattachChatStreams: vi.fn() }));
vi.mock("./ide-store-persistence", () => ({
  isHostLoaded: () => false,
  loadCatalog: vi.fn(),
}));
vi.mock("@/lib/connections/platform", () => ({
  getClientPlatform: () => ({
    homeRoute: { id: "local", kind: "local" },
    homeLabel: "Local",
  }),
}));

test("recovery rejects a delayed old catalog through the production catalog lifecycle", async () => {
  const reads: Array<(value: Awaited<ReturnType<typeof loadCatalog>>) => void> =
    [];
  vi.mocked(loadCatalog).mockImplementation(
    () =>
      new Promise((resolve) => {
        reads.push(resolve);
      }),
  );
  const accepted: string[] = [];
  const store = createStore<IdeState>(
    () =>
      ({
        stateHydrated: true,
        hosts: {},
        hostConnections: [],
        settings: DEFAULT_SETTINGS,
        projects: [],
        closedProjects: [],
        chats: [],
      }) as unknown as IdeState,
  );
  const catalogs = hostCatalogLifecycle(store.setState, store.getState);
  store.setState({
    loadHostCatalog: (hostId) =>
      catalogs.read(hostId, (catalog) => {
        accepted.push(String(catalog.projects[0].name));
      }),
  });
  const recovery = createConnectionRecovery(createConnectionSupervisor());
  const stop = followConnections(store, recovery);
  try {
    const event = { reason: "online" as const, hiddenMs: 0 };
    const old = recovery.resume(event);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    const fresh = recovery.resume(event);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    const catalog = (name: string) =>
      ({
        projects: [{ id: "p", name }],
        chats: [],
        runningChatIds: [],
      }) as unknown as Awaited<ReturnType<typeof loadCatalog>>;
    reads[1](catalog("Fresh"));
    await fresh;
    reads[0](catalog("Old"));
    await old;
    expect(accepted).toEqual(["Fresh"]);
    expect(reattachChatStreams).toHaveBeenCalledExactlyOnceWith("local");
  } finally {
    stop();
    recovery.dispose();
  }
});
