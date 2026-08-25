import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type FileTabsAction,
  type FileTabsState,
  fileTabsReducer,
  getProjectFileTabs,
} from "./file-tabs";

const projectId = "project-1";

const reduce = (actions: FileTabsAction[], initial: FileTabsState = {}) =>
  getProjectFileTabs(actions.reduce(fileTabsReducer, initial), projectId);

test("preview opens a single unpinned tab and activates it", () => {
  const state = reduce([{ type: "preview", projectId, path: "a.ts" }]);
  assert.deepEqual(state, {
    activePath: "a.ts",
    tabs: [{ path: "a.ts", pinned: false }],
  });
});

test("previewing another file replaces the preview tab", () => {
  const state = reduce([
    { type: "preview", projectId, path: "a.ts" },
    { type: "preview", projectId, path: "b.ts" },
  ]);
  assert.deepEqual(state.tabs, [{ path: "b.ts", pinned: false }]);
  assert.equal(state.activePath, "b.ts");
});

test("pinning keeps the tab when the next file is previewed", () => {
  const state = reduce([
    { type: "pin", projectId, path: "a.ts" },
    { type: "preview", projectId, path: "b.ts" },
    { type: "preview", projectId, path: "c.ts" },
  ]);
  assert.deepEqual(state.tabs, [
    { path: "a.ts", pinned: true },
    { path: "c.ts", pinned: false },
  ]);
  assert.equal(state.activePath, "c.ts");
});

test("double-clicking a previewed file pins it in place", () => {
  const state = reduce([
    { type: "pin", projectId, path: "a.ts" },
    { type: "preview", projectId, path: "b.ts" },
    { type: "pin", projectId, path: "b.ts" },
    { type: "preview", projectId, path: "c.ts" },
  ]);
  assert.deepEqual(state.tabs, [
    { path: "a.ts", pinned: true },
    { path: "b.ts", pinned: true },
    { path: "c.ts", pinned: false },
  ]);
});

test("previewing an already pinned file activates it without opening a new tab", () => {
  const state = reduce([
    { type: "pin", projectId, path: "a.ts" },
    { type: "preview", projectId, path: "b.ts" },
    { type: "preview", projectId, path: "a.ts" },
  ]);
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activePath, "a.ts");
  assert.deepEqual(state.tabs[1], { path: "b.ts", pinned: false });
});

test("closing the active tab activates the tab to its right, then left", () => {
  const base: FileTabsAction[] = [
    { type: "pin", projectId, path: "a.ts" },
    { type: "pin", projectId, path: "b.ts" },
    { type: "pin", projectId, path: "c.ts" },
    { type: "activate", projectId, path: "b.ts" },
  ];

  const afterMiddle = reduce([
    ...base,
    { type: "close", projectId, path: "b.ts" },
  ]);
  assert.equal(afterMiddle.activePath, "c.ts");

  const afterLast = reduce([
    ...base,
    { type: "activate", projectId, path: "c.ts" },
    { type: "close", projectId, path: "c.ts" },
  ]);
  assert.equal(afterLast.activePath, "b.ts");
});

test("closing an inactive tab keeps the active tab", () => {
  const state = reduce([
    { type: "pin", projectId, path: "a.ts" },
    { type: "pin", projectId, path: "b.ts" },
    { type: "close", projectId, path: "a.ts" },
  ]);
  assert.equal(state.activePath, "b.ts");
  assert.deepEqual(state.tabs, [{ path: "b.ts", pinned: true }]);
});

test("closing the last tab clears the active path", () => {
  const state = reduce([
    { type: "preview", projectId, path: "a.ts" },
    { type: "close", projectId, path: "a.ts" },
  ]);
  assert.deepEqual(state, { activePath: null, tabs: [] });
});

test("reorder moves tabs without changing the active path", () => {
  const state = reduce([
    { type: "pin", projectId, path: "a.ts" },
    { type: "pin", projectId, path: "b.ts" },
    { type: "pin", projectId, path: "c.ts" },
    { type: "reorder", projectId, fromIndex: 0, toIndex: 2 },
  ]);
  assert.deepEqual(
    state.tabs.map((tab) => tab.path),
    ["b.ts", "c.ts", "a.ts"],
  );
  assert.equal(state.activePath, "c.ts");
});

test("no-op actions return the same state reference", () => {
  const initial = [{ type: "pin", projectId, path: "a.ts" } as const].reduce(
    fileTabsReducer,
    {},
  );
  assert.equal(
    fileTabsReducer(initial, { type: "pin", projectId, path: "a.ts" }),
    initial,
  );
  assert.equal(
    fileTabsReducer(initial, { type: "close", projectId, path: "zzz.ts" }),
    initial,
  );
  assert.equal(
    fileTabsReducer(initial, { type: "activate", projectId, path: "zzz.ts" }),
    initial,
  );
});

test("projects are tracked independently", () => {
  const state = [
    { type: "pin", projectId, path: "a.ts" } as const,
    { type: "pin", projectId: "project-2", path: "b.ts" } as const,
  ].reduce(fileTabsReducer, {});
  assert.equal(getProjectFileTabs(state, projectId).activePath, "a.ts");
  assert.equal(getProjectFileTabs(state, "project-2").activePath, "b.ts");
  assert.equal(getProjectFileTabs(state, "project-3").activePath, null);
});
