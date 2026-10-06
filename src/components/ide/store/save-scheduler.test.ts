// The save scheduler over fake timers: which slices a change marks, when
// it saves, and that the load itself saves nothing.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSaveScheduler,
  type SaveSlice,
  type SchedulerState,
} from "./save-scheduler";

const baseState = (): SchedulerState => ({
  activeBrowserTabIdByProject: {},
  activeProjectId: "p1",
  appView: "code",
  browserTabsByProject: {},
  chatSort: "recent",
  chats: [],
  closedProjects: [],
  projects: [],
  savedPrompts: [],
  settings: {},
  stateHydrated: true,
});

const setup = ({ idle = false } = {}) => {
  const saves: SaveSlice[][] = [];
  const timeouts: Array<{ callback: () => void; ms: number } | null> = [];
  const idles: Array<(() => void) | null> = [];
  const scheduler = createSaveScheduler({
    save: (dirty) => saves.push([...dirty].sort()),
    timers: {
      clearTimeout: (handle) => {
        timeouts[handle as number] = null;
      },
      setTimeout: (callback, ms) => timeouts.push({ callback, ms }) - 1,
      ...(idle
        ? {
            cancelIdle: (handle: unknown) => {
              idles[handle as number] = null;
            },
            whenIdle: (callback: () => void) => idles.push(callback) - 1,
          }
        : {}),
    },
  });
  let state = baseState();
  const change = (patch: Partial<SchedulerState>) => {
    const previous = state;
    state = { ...state, ...patch };
    scheduler.observe(state, previous);
  };
  const runTimers = () => {
    for (const [index, entry] of timeouts.entries()) {
      if (!entry) continue;
      timeouts[index] = null;
      entry.callback();
    }
  };
  const runIdle = () => {
    for (const [index, callback] of idles.entries()) {
      if (!callback) continue;
      idles[index] = null;
      callback();
    }
  };
  return { change, runIdle, runTimers, saves, scheduler, timeouts };
};

test("a change marks only its slice, and saves once after the last change", () => {
  const { change, runTimers, saves } = setup();

  change({ settings: { theme: "dark" } });
  change({ activeProjectId: "p2" });
  assert.deepEqual(saves, []);
  runTimers();

  assert.deepEqual(saves, [["config"]]);
});

test("a project's view state saves the projects slice, not the chats", () => {
  const { change, runTimers, saves } = setup();

  change({ projects: [{ id: "p1", ui: { stashItems: ["draft"] } }] });
  runTimers();

  assert.deepEqual(saves, [["projects"]]);
});

test("slices changed together save together", () => {
  const { change, runTimers, saves } = setup();

  change({ chats: [{ id: "c1" }] });
  change({ savedPrompts: [{ id: "s1" }] });
  runTimers();

  assert.deepEqual(saves, [["chats", "savedPrompts"]]);
});

test("the load itself saves nothing", () => {
  const { runTimers, saves, scheduler } = setup();
  const loading = { ...baseState(), stateHydrated: false };

  scheduler.observe({ ...loading, chats: [{ id: "c1" }] }, loading);
  scheduler.observe(
    { ...baseState(), chats: [{ id: "c1" }], settings: { a: 1 } },
    { ...loading, chats: [{ id: "c1" }] },
  );
  runTimers();

  assert.deepEqual(saves, []);
});

test("with an idle callback the save waits for idle", () => {
  const { change, runIdle, runTimers, saves } = setup({ idle: true });

  change({ appView: "chat" });
  runTimers();
  assert.deepEqual(saves, []);
  runIdle();

  assert.deepEqual(saves, [["config"]]);
});

test("flush saves now and cancels the scheduled save", () => {
  const { change, runTimers, saves, scheduler } = setup();

  change({ chatSort: "name" });
  scheduler.flush();
  runTimers();
  scheduler.flush();

  assert.deepEqual(saves, [["config"]]);
});

test("saveAll saves every slice now", () => {
  const { saves, scheduler } = setup();

  scheduler.saveAll();

  assert.deepEqual(saves, [["chats", "config", "projects", "savedPrompts"]]);
});
