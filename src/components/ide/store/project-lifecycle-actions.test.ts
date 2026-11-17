// Stopping a project's terminals: every session is asked, and a host that
// cannot answer is logged rather than failing the removal that asked.
import { afterEach, expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { IdeState } from "./ide-store-types";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";
import { createTerminalSessionOwner } from "./terminal-actions";

const terminals = vi.hoisted(() => ({
  stop: vi.fn(async (_sessionId: string) => true),
}));

vi.mock("@/lib/electron", () => ({ getDesktopApi: () => ({}) }));
vi.mock("@/lib/terminal-client", () => ({ terminalClient: terminals }));

afterEach(() => {
  terminals.stop.mockReset();
  vi.restoreAllMocks();
});

test("dropping a project's terminals asks every session to stop and settles when a host cannot answer", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  terminals.stop.mockImplementation(async (sessionId: string) => {
    if (sessionId === "gone") throw new Error("host unreachable");
    return true;
  });
  const store = createStore<IdeState>(
    () =>
      ({
        projectTerminalSessionIds: { project: ["gone", "here"] },
      }) as unknown as IdeState,
  );
  // What closing or removing a project asks of the Terminal session owner.
  const owner = createTerminalSessionOwner(store.setState, store.getState);

  await expect(owner.dropProject("project")).resolves.toBeUndefined();

  expect(terminals.stop.mock.calls.map((call) => call[0])).toEqual([
    "gone",
    "here",
  ]);
  expect(warn).toHaveBeenCalledTimes(1);
});

test("a cancelled open cannot add a Project after a delayed SSH connection", async () => {
  let finishConnection!: (connected: boolean) => void;
  const connectHost = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finishConnection = resolve;
      }),
  );
  const addProject = vi.fn();
  const store = createStore<IdeState>(
    () => ({ hosts: {}, connectHost }) as unknown as IdeState,
  );
  store.setState({
    ...createProjectLifecycleActions(store.setState, store.getState, {
      persist: () => {},
    }),
    addProject,
  });
  const controller = new AbortController();
  const opening = store
    .getState()
    .openProject("/work/app", { hostId: "remote", signal: controller.signal });
  controller.abort();
  finishConnection(true);
  expect(await opening).toBe(false);
  expect(addProject).not.toHaveBeenCalled();
});
