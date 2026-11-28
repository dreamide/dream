import type { IdeState } from "./ide-store-types";

type Activity = Pick<
  IdeState,
  "hostRunningChatIds" | "hostAwaitingApprovalChatIds"
>;
type Owners = Record<string, string>;
type Snapshot = {
  runningChatIds?: string[];
  awaitingApprovalChatIds?: string[];
};

/** Each flag carries the connection that reported it, even before its Chat row arrives. */
export const setHostFlag = (
  flags: Owners,
  hostId: string,
  chatId: string,
  active: boolean,
): Owners => {
  const owner = flags[chatId];
  if (active) return owner ? flags : { ...flags, [chatId]: hostId };
  if (owner !== hostId) return flags;
  const next = { ...flags };
  delete next[chatId];
  return next;
};

const replaceFlags = (flags: Owners, hostId: string, ids: string[]) => {
  const next: Owners = {};
  for (const [id, owner] of Object.entries(flags)) {
    if (owner !== hostId) next[id] = owner;
  }
  for (const id of ids) next[id] ??= hostId;
  return next;
};

export const replaceHostActivity = (
  state: Activity,
  hostId: string,
  snapshot: Snapshot,
): Activity => ({
  hostRunningChatIds: replaceFlags(
    state.hostRunningChatIds,
    hostId,
    snapshot.runningChatIds ?? [],
  ),
  hostAwaitingApprovalChatIds: replaceFlags(
    state.hostAwaitingApprovalChatIds,
    hostId,
    snapshot.awaitingApprovalChatIds ?? [],
  ),
});

/** Two saved connections turned out to reach the same Host. Keep its live flags. */
export const reassignHostActivity = (
  state: Activity,
  from: string,
  to: string,
): Activity => {
  const reassign = (flags: Owners) =>
    Object.fromEntries(
      Object.entries(flags).map(([id, hostId]) => [
        id,
        hostId === from ? to : hostId,
      ]),
    );
  return {
    hostRunningChatIds: reassign(state.hostRunningChatIds),
    hostAwaitingApprovalChatIds: reassign(state.hostAwaitingApprovalChatIds),
  };
};
