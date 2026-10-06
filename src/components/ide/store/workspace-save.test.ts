// Saving the workspace a change at a time, against the real database: a
// workspace saved whole and loaded back is already saved, a change sends
// only its own rows and keys, and the main process applies them so the
// next load says the same as the store.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type {
  PersistedIdeState,
  PersistedWorkspace,
  ProjectConfig,
} from "@/types/ide";
import {
  closePersistedStateDatabase,
  loadPersistedState,
  savePersistedState,
  savePersistedWorkspaceChanges,
} from "../../../../electron/persisted-state.js";
import { encodePersistedState } from "../../../../electron/shared/persisted-state-codec.js";
import {
  copyWorkspaceRecord,
  recordLoadedWorkspace,
  recordWorkspace,
  restoreUnsent,
  takeWorkspaceChanges,
} from "./workspace-save";

let directory: string | null = null;
afterEach(async () => {
  closePersistedStateDatabase();
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = null;
});

const LOCAL = new Set(["local"]);

const open = async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dream-workspace-save-"));
  const databasePath = path.join(directory, "state.db");
  return {
    apply: (changes: unknown) =>
      savePersistedWorkspaceChanges(changes, { databasePath }),
    load: () => loadPersistedState({ databasePath }) as PersistedWorkspace,
    saveWhole: (state: PersistedIdeState) =>
      savePersistedState(state, { databasePath }),
  };
};

const project = (name: string, extra: Partial<ProjectConfig> = {}) => ({
  ...createProjectConfig(`/work/${name}`, DEFAULT_SETTINGS),
  ...extra,
});

const encode = (
  projects: ProjectConfig[],
  patch: Partial<PersistedIdeState> = {},
): PersistedIdeState =>
  encodePersistedState({
    activeBrowserTabIdByProject: {},
    activeProjectId: projects[0]?.id ?? null,
    appView: "code",
    browserTabsByProject: {},
    chats: [],
    chatSort: "recent",
    closedProjects: [],
    messagesByChatId: {},
    projects,
    savedPrompts: [],
    settings: DEFAULT_SETTINGS,
    ...patch,
  }) as PersistedIdeState;

test("a workspace saved whole and loaded back has nothing to save", async () => {
  const db = await open();
  const state = encode([project("a"), project("b")]);
  db.saveWhole(state);

  const record = recordLoadedWorkspace(db.load());
  const changes = takeWorkspaceChanges(
    record,
    recordWorkspace(state, { rows: true }),
    LOCAL,
  );

  assert.equal(changes?.upsertRows, undefined);
  assert.equal(changes?.removeRows, undefined);
  assert.equal(changes?.config, undefined);
});

test("a project's view state sends its own row and nothing else", async () => {
  const db = await open();
  const a = project("a");
  const b = project("b");
  db.saveWhole(encode([a, b]));
  const record = recordLoadedWorkspace(db.load());
  takeWorkspaceChanges(
    record,
    recordWorkspace(encode([a, b]), { rows: true }),
    LOCAL,
  );

  const edited = { ...b, ui: { ...b.ui, changesDiffWordWrap: true } };
  const changes = takeWorkspaceChanges(
    record,
    recordWorkspace(encode([a, edited]), { rows: true }),
    LOCAL,
  );

  assert.deepEqual(
    changes?.upsertRows?.map((row) => row.projectId),
    [b.id],
  );
  assert.deepEqual(Object.keys(changes ?? {}), ["upsertRows"]);
  db.apply(changes);
  const stored = db
    .load()
    .workspaceProjects.find((row) => row.projectId === b.id);
  assert.equal(
    (stored?.ui as { changesDiffWordWrap?: boolean }).changesDiffWordWrap,
    true,
  );
});

test("a setting sends its own key; config-only saves leave rows alone", async () => {
  const db = await open();
  const a = project("a");
  db.saveWhole(encode([a]));
  const record = recordLoadedWorkspace(db.load());
  takeWorkspaceChanges(
    record,
    recordWorkspace(encode([a]), { rows: true }),
    LOCAL,
  );

  const changes = takeWorkspaceChanges(
    record,
    recordWorkspace(encode([a], { chatSort: "titleAsc" }), { rows: false }),
    LOCAL,
  );

  assert.deepEqual(changes, { config: { chatSort: "titleAsc" } });
  db.apply(changes);
  assert.equal(db.load().chatSort, "titleAsc");
});

test("a removed project's row goes; a stale stored row goes with the first save", async () => {
  const db = await open();
  const a = project("a");
  const b = project("b");
  const gone = project("gone");
  db.saveWhole(encode([a, b, gone]));
  const record = recordLoadedWorkspace(db.load());

  const changes = takeWorkspaceChanges(
    record,
    recordWorkspace(encode([a, b]), { rows: true }),
    LOCAL,
  );

  assert.deepEqual(changes?.removeRows, [
    { hostId: "local", projectId: gone.id },
  ]);
  db.apply(changes);
  assert.deepEqual(
    db
      .load()
      .workspaceProjects.map((row) => row.projectId)
      .sort(),
    [a.id, b.id].sort(),
  );
});

test("a host this window has not loaded only has its rows moved, never removed", async () => {
  const db = await open();
  const local = project("a");
  const remote = project("r", { hostId: "ssh-1" });
  db.saveWhole(encode([local, remote]));
  const record = recordLoadedWorkspace(db.load());
  takeWorkspaceChanges(
    record,
    recordWorkspace(encode([local, remote]), { rows: true }),
    LOCAL,
  );

  // Its UI changed here (no chats loaded for it): not this window's to save.
  const uiOnly = takeWorkspaceChanges(
    record,
    recordWorkspace(
      encode([
        local,
        { ...remote, ui: { ...remote.ui, changesDiffWordWrap: true } },
      ]),
      { rows: true },
    ),
    LOCAL,
  );
  assert.equal(uiOnly, null);

  // Closed: it moves.
  const closed = takeWorkspaceChanges(
    record,
    recordWorkspace(encode([local], { closedProjects: [remote] }), {
      rows: true,
    }),
    LOCAL,
  );
  assert.deepEqual(
    closed?.moveRows?.map((row) => [row.projectId, row.status]),
    [[remote.id, "closed"]],
  );
  assert.equal(closed?.removeRows, undefined);
});

test("changes that failed to send are sent again by the next save", async () => {
  const db = await open();
  const a = project("a");
  db.saveWhole(encode([a]));
  const record = recordLoadedWorkspace(db.load());
  takeWorkspaceChanges(
    record,
    recordWorkspace(encode([a]), { rows: true }),
    LOCAL,
  );

  const before = copyWorkspaceRecord(record);
  const next = recordWorkspace(encode([a], { chatSort: "createdAsc" }), {
    rows: true,
  });
  const failed = takeWorkspaceChanges(record, next, LOCAL);
  assert.ok(failed);
  restoreUnsent(record, failed, before);

  assert.deepEqual(takeWorkspaceChanges(record, next, LOCAL), failed);
});
