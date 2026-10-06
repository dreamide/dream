/**
 * Saving the client's workspace a change at a time: what the main process
 * last stored (config rows, saved prompts, a row per project) against what
 * the encoded state says now, and the difference as `WorkspaceChanges`.
 *
 * The rows follow the main process's rules (persisted-state.js): a row of
 * a host this window describes (has loaded) is written whole and removed
 * when its project goes; a row of a host it does not describe only moves,
 * and is never removed from here.
 *
 * Pure: the store's save scheduler calls it (store/save-scheduler.ts).
 */
import type {
  PersistedIdeState,
  PersistedWorkspace,
  PersistedWorkspaceProject,
  WorkspaceChanges,
} from "@/types/ide";
import {
  projectToWorkspaceRow,
  stateToConfig,
} from "../../../../electron/shared/persisted-state-codec.js";

/** What one save (or the load) holds, comparable value by value. */
export interface WorkspaceRecord {
  /** Config key -> JSON of its value. */
  config: Map<string, string>;
  /** JSON of the saved prompts; null when unknown. */
  savedPrompts: string | null;
  /** `hostId\0projectId` -> the row and its JSON. */
  rows: Map<string, { json: string; row: PersistedWorkspaceProject }>;
}

const rowKey = (row: { hostId: string; projectId: string }) =>
  `${row.hostId}\0${row.projectId}`;

const rowJson = (row: PersistedWorkspaceProject) =>
  JSON.stringify([
    row.status,
    row.sortOrder,
    row.ui,
    row.lastUsedAt,
    row.snapshot,
  ]);

const recordRows = (rows: PersistedWorkspaceProject[]) =>
  new Map(rows.map((row) => [rowKey(row), { json: rowJson(row), row }]));

const recordConfig = (config: Record<string, unknown>) =>
  new Map(
    Object.entries(config).map(([key, value]) => [
      key,
      JSON.stringify(value ?? null),
    ]),
  );

/** The rows `state` describes, in the main process's order and numbering. */
const workspaceRows = (state: PersistedIdeState) => {
  const rows: PersistedWorkspaceProject[] = [];
  const seen = new Set<string>();
  for (const [status, projects] of [
    ["open", state.projects],
    ["closed", state.closedProjects],
  ] as const) {
    for (const project of projects) {
      if (!project?.id?.trim() || seen.has(project.id)) continue;
      seen.add(project.id);
      rows.push(
        projectToWorkspaceRow(
          project,
          status,
          rows.length,
        ) as PersistedWorkspaceProject,
      );
    }
  }
  return rows;
};

/** What the main process loaded: the baseline the first save is against. */
export const recordLoadedWorkspace = (
  loaded: PersistedWorkspace,
): WorkspaceRecord => ({
  config: recordConfig(
    // The loaded top-level fields and settings, raw: what config holds.
    stateToConfig(loaded as unknown as PersistedIdeState),
  ),
  savedPrompts: Array.isArray(loaded.savedPrompts)
    ? JSON.stringify(loaded.savedPrompts)
    : null,
  rows: recordRows(loaded.workspaceProjects ?? []),
});

/**
 * What `encoded` says, for the parts asked for: `rows` needs the whole
 * encoded state (a project's UI is checked against its chats), config and
 * saved prompts do not.
 */
export const recordWorkspace = (
  encoded: PersistedIdeState,
  { rows }: { rows: boolean },
): Partial<WorkspaceRecord> &
  Pick<WorkspaceRecord, "config" | "savedPrompts"> => ({
  config: recordConfig(stateToConfig(encoded)),
  savedPrompts: JSON.stringify(encoded.savedPrompts),
  ...(rows ? { rows: recordRows(workspaceRows(encoded)) } : {}),
});

/**
 * The changes from `previous` to `next`, or null when there are none.
 * `previous` is updated to `next` for what is sent (the caller restores it
 * with `restoreUnsent` if the send fails). Absent parts of `next` are not
 * compared.
 */
export const takeWorkspaceChanges = (
  previous: WorkspaceRecord,
  next: Partial<WorkspaceRecord>,
  describedHostIds: ReadonlySet<string>,
): WorkspaceChanges | null => {
  const changes: WorkspaceChanges = {};

  if (next.config) {
    const config: Record<string, unknown> = {};
    for (const [key, json] of next.config) {
      if (previous.config.get(key) === json) continue;
      config[key] = JSON.parse(json);
      previous.config.set(key, json);
    }
    if (Object.keys(config).length > 0) changes.config = config;
  }

  if (
    next.savedPrompts !== undefined &&
    next.savedPrompts !== null &&
    next.savedPrompts !== previous.savedPrompts
  ) {
    changes.savedPrompts = JSON.parse(next.savedPrompts);
    previous.savedPrompts = next.savedPrompts;
  }

  if (next.rows) {
    const upsertRows: PersistedWorkspaceProject[] = [];
    const moveRows: PersistedWorkspaceProject[] = [];
    for (const [key, entry] of next.rows) {
      const before = previous.rows.get(key);
      if (describedHostIds.has(entry.row.hostId)) {
        if (before?.json === entry.json) continue;
        upsertRows.push(entry.row);
      } else {
        // Only its status and place are this window's to save.
        if (
          before &&
          before.row.status === entry.row.status &&
          before.row.sortOrder === entry.row.sortOrder
        ) {
          continue;
        }
        moveRows.push(entry.row);
      }
      previous.rows.set(key, entry);
    }
    const removeRows: { hostId: string; projectId: string }[] = [];
    for (const [key, entry] of previous.rows) {
      if (next.rows.has(key) || !describedHostIds.has(entry.row.hostId)) {
        continue;
      }
      removeRows.push({
        hostId: entry.row.hostId,
        projectId: entry.row.projectId,
      });
      previous.rows.delete(key);
    }
    if (upsertRows.length > 0) changes.upsertRows = upsertRows;
    if (moveRows.length > 0) changes.moveRows = moveRows;
    if (removeRows.length > 0) changes.removeRows = removeRows;
  }

  return Object.keys(changes).length > 0 ? changes : null;
};

/**
 * Undoes what `takeWorkspaceChanges` recorded for `changes`, after they
 * failed to send, so the next save sends them again.
 */
export const restoreUnsent = (
  previous: WorkspaceRecord,
  changes: WorkspaceChanges,
  before: WorkspaceRecord,
) => {
  for (const key of Object.keys(changes.config ?? {})) {
    const json = before.config.get(key);
    if (json === undefined) previous.config.delete(key);
    else previous.config.set(key, json);
  }
  if (changes.savedPrompts) previous.savedPrompts = before.savedPrompts;
  for (const row of [
    ...(changes.upsertRows ?? []),
    ...(changes.moveRows ?? []),
    ...(changes.removeRows ?? []),
  ]) {
    const key = rowKey(row);
    const entry = before.rows.get(key);
    if (entry) previous.rows.set(key, entry);
    else previous.rows.delete(key);
  }
};

/** A copy to restore from (`restoreUnsent`). */
export const copyWorkspaceRecord = (
  record: WorkspaceRecord,
): WorkspaceRecord => ({
  config: new Map(record.config),
  savedPrompts: record.savedPrompts,
  rows: new Map(record.rows),
});
