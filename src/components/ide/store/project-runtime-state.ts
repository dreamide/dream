// The registry of per-project state the store keeps outside the project
// record itself, so closing or purging a project drops all of it in one
// place instead of a hand-written list in each action. A new map keyed by
// project id, terminal session id, browser tab id or chat id is added here,
// once, and every exit path picks it up.
import type { IdeState, IdeStoreSet } from "./ide-store-types";
import type { TerminalSessionOwner } from "./terminal-actions";
import type { WorkspaceRemoval } from "./workspace-document";

type RecordKeyOf<T> = {
  [Key in keyof T]: T[Key] extends Record<string, unknown> ? Key : never;
}[keyof T];

/** Runtime maps keyed by project id. */
export const PROJECT_KEYED_RUNTIME_STATE = [
  "activeTerminalSessionIdByProject",
  "agentBrowserTabIdsByProject",
  "draftChatIdByProject",
  "gitWriteByProject",
  "nextTerminalOrdinalByProject",
  "projectFileSearchRequests",
  "projectFilesRefreshKeys",
  "projectGitPanelTabByProject",
  "projectGitRefreshKeys",
  "projectTerminalSessionIds",
] as const satisfies readonly RecordKeyOf<IdeState>[];

/**
 * Persisted maps keyed by project id. They survive a close, so a reopened
 * project comes back where it was, and go only when the project is purged.
 */
export const PROJECT_KEYED_PERSISTED_STATE = [
  "activeBrowserTabIdByProject",
  "browserTabsByProject",
] as const satisfies readonly RecordKeyOf<IdeState>[];

/** Runtime maps keyed by terminal session id. */
export const TERMINAL_SESSION_KEYED_STATE = [
  "terminalSessionNames",
  "terminalShell",
  "terminalStatus",
  "terminalTransport",
] as const satisfies readonly RecordKeyOf<IdeState>[];

/** Runtime maps keyed by browser tab id. */
export const BROWSER_TAB_KEYED_STATE = [
  "browserStatusByTab",
] as const satisfies readonly RecordKeyOf<IdeState>[];

/** Maps keyed by chat id, runtime and persisted alike. */
export const CHAT_KEYED_STATE = [
  "awaitingAnswerChatIds",
  "messagesByChatId",
  "transcriptPageByChatId",
  "sendingChatIds",
  "streamingChatIds",
  "titleGeneratingChatIds",
] as const satisfies readonly RecordKeyOf<IdeState>[];

const omitKeys = <T extends Record<string, unknown>>(
  record: T,
  keys: Iterable<string>,
): T => {
  const next = { ...record };
  for (const key of keys) {
    delete next[key];
  }
  return next;
};

const dropKeysFrom = (
  state: IdeState,
  maps: readonly RecordKeyOf<IdeState>[],
  keys: readonly string[],
): Partial<IdeState> =>
  keys.length === 0
    ? {}
    : (Object.fromEntries(
        maps.map((map) => [map, omitKeys(state[map], keys)]),
      ) as Partial<IdeState>);

/**
 * The runtime state a project leaves behind when it closes: everything
 * keyed by its id, by its terminal sessions or by its browser tabs. Its
 * persisted per-project state (browser tabs, chats) stays, so the project
 * reopens where it was.
 */
export const dropProjectRuntimeState = (
  state: IdeState,
  projectId: string,
): Partial<IdeState> => ({
  ...dropKeysFrom(state, PROJECT_KEYED_RUNTIME_STATE, [projectId]),
  ...dropKeysFrom(
    state,
    TERMINAL_SESSION_KEYED_STATE,
    state.projectTerminalSessionIds[projectId] ?? [],
  ),
  ...dropKeysFrom(
    state,
    BROWSER_TAB_KEYED_STATE,
    (state.browserTabsByProject[projectId] ?? []).map((tab) => tab.id),
  ),
});

/**
 * Closed projects lose their runtime state. Purged projects and chats
 * also lose their persisted state.
 */
export const applyWorkspaceRemoval = (
  state: IdeState,
  {
    doc,
    closedProjectIds,
    removedProjectIds,
    removedChatIds,
  }: WorkspaceRemoval,
): Partial<IdeState> => {
  if (
    !closedProjectIds.length &&
    !removedProjectIds.length &&
    !removedChatIds.length
  )
    return doc;
  let next: Partial<IdeState> = doc;
  for (const projectId of [...closedProjectIds, ...removedProjectIds]) {
    next = {
      ...next,
      ...dropProjectRuntimeState({ ...state, ...next }, projectId),
    };
  }
  const withProjects = { ...state, ...next };
  return {
    ...next,
    ...dropKeysFrom(
      withProjects,
      PROJECT_KEYED_PERSISTED_STATE,
      removedProjectIds,
    ),
    ...dropKeysFrom(withProjects, CHAT_KEYED_STATE, removedChatIds),
  };
};

/**
 * Commits a workspace removal to the store: stops the terminals of every
 * project it takes out (their session ids leave the store with them, and a
 * host does not stop a shell because its project left the catalog), then
 * applies it. Returns once the stops have been answered.
 */
export const commitWorkspaceRemoval = (
  set: IdeStoreSet,
  terminals: Pick<TerminalSessionOwner, "dropProject">,
  removal: WorkspaceRemoval,
): Promise<void> => {
  const stops = Promise.all(
    [...removal.closedProjectIds, ...removal.removedProjectIds].map(
      (projectId) => terminals.dropProject(projectId),
    ),
  ).then(() => undefined);
  set((state) => applyWorkspaceRemoval(state, removal));
  return stops;
};
