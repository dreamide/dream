// The registry of per-project state the store keeps outside the project
// record itself, so closing or purging a project drops all of it in one
// place instead of a hand-written list in each action. A new map keyed by
// project id, terminal session id, browser tab id or chat id is added here,
// once, and every exit path picks it up.
import type { IdeState } from "./ide-store-types";

type RecordKeyOf<T> = {
  [Key in keyof T]: T[Key] extends Record<string, unknown> ? Key : never;
}[keyof T];

/** Runtime maps keyed by project id. */
export const PROJECT_KEYED_RUNTIME_STATE = [
  "activeTerminalSessionIdByProject",
  "draftChatIdByProject",
  "nextTerminalOrdinalByProject",
  "projectFileOpenRequests",
  "projectFileSearchRequests",
  "projectFilesRefreshKeys",
  "projectGitLogPanelOpenByProject",
  "projectGitRefreshKeys",
  "projectTerminalPanelOpenByProject",
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
  "browserLoading",
] as const satisfies readonly RecordKeyOf<IdeState>[];

/** Maps keyed by chat id, runtime and persisted alike. */
export const CHAT_KEYED_STATE = [
  "awaitingAnswerChatIds",
  "completedChatIds",
  "messagesByChatId",
  "pendingChatSubmitByChatId",
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
 * Everything keyed by projects that are gone for good, and by the chats
 * that went with them: the runtime state a close drops, plus the persisted
 * per-project and per-chat maps.
 */
export const dropPurgedProjectState = (
  state: IdeState,
  projectIds: readonly string[],
  chatIds: readonly string[],
): Partial<IdeState> => {
  let next: Partial<IdeState> = {};
  for (const projectId of projectIds) {
    next = {
      ...next,
      ...dropProjectRuntimeState({ ...state, ...next }, projectId),
    };
  }
  const withProjects = { ...state, ...next };
  return {
    ...next,
    ...dropKeysFrom(withProjects, PROJECT_KEYED_PERSISTED_STATE, projectIds),
    ...dropKeysFrom(withProjects, CHAT_KEYED_STATE, chatIds),
  };
};
