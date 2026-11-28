/**
 * Chat turn outcome: what a Chat's last turn came to, as one record per chat.
 * Its turn status (running, waiting on its user, finished, failed,
 * interrupted), its unread mark (the turn ended while the chat was not
 * shown) and the message on its banner.
 *
 * Two sources report turns. This window's session (the chat runtime, while
 * it follows a turn) knows how a turn ended and what it asks of its user. The
 * host catalog's `turn` and `approval` events, as the store's host sets
 * (`hostRunningChatIds`, `hostAwaitingApprovalChatIds`) hold them, know every
 * turn, followed here or not. A turn both report is one turn: it starts when
 * the first source reports it and ends when the last one does, with the most
 * telling ending either gave (the Host's settled ending, then the session's
 * own end, then an older Host's plain end, then loss of a follow).
 *
 * Not here: whether a chat runs, waits or accepts a message now. Chat
 * activity (chat-activity.ts) answers those from the store's signals.
 */
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentTurnEnding } from "../../../electron/shared/agent-turn-contract.js";
import type { IdeState } from "./store/ide-store-types";

export type TurnStatus =
  | "running"
  | "waiting"
  | "finished"
  | "failed"
  | "interrupted";

/** How a turn ended, as this window's session saw it. */
export type TurnEnding = AgentTurnEnding["status"];

export interface ChatTurn {
  status: TurnStatus;
  updatedAt: number;
  /** The question it waits on, or what it failed with. */
  detail: string;
}

export interface ChatTurnOutcomeState {
  /** Each chat's last turn. Kept across reloads. */
  turns: Record<string, ChatTurn>;
  /** Chats whose turn ended while they were not shown, until seen. */
  unread: Record<string, true>;
  /** The message on each chat's banner. */
  errors: Record<string, string>;
}

/** What the outcome reads of the IDE store. */
export type WatchedIdeState = Pick<
  IdeState,
  | "activeProjectId"
  | "chats"
  | "hostAwaitingApprovalChatIds"
  | "hostRunningChatIds"
  | "projects"
>;

export interface WatchedIdeStore {
  getState: () => WatchedIdeState;
  subscribe: (
    listener: (state: WatchedIdeState, previous: WatchedIdeState) => void,
  ) => () => void;
}

export interface ChatTurnOutcomes {
  readonly store: StoreApi<ChatTurnOutcomeState>;
  /** This window's session started following a turn in the chat. */
  started: (chatId: string) => void;
  /** What the followed turn asks of its user now; null for nothing. */
  attention: (chatId: string, detail: string | null) => void;
  /**
   * This window's session saw the turn end, and how. Without `how` it only
   * stopped following: the host says when the turn ends. A failure is shown
   * on the chat's banner at once, even after its turn ended.
   */
  ended: (chatId: string, how?: TurnEnding, detail?: string) => void;
  /** The Host's ending, supplied before its running flag is cleared. */
  reportHostEnding: (chatId: string, ending: AgentTurnEnding) => void;
  /** Puts a message on the chat's banner; null clears it. */
  reportError: (chatId: string, message: string | null) => void;
  /** The user saw these chats: their unread marks go. */
  seen: (chatIds: Iterable<string>) => void;
  /**
   * Follows the host's running and waiting chats in `store`, reads which
   * chat is shown when a turn ends, and forgets chats that leave it or are
   * deleted. Returns how to stop.
   */
  watch: (store: WatchedIdeStore) => () => void;
}

/** Where turns are kept across reloads: local storage in the window. */
export type TurnStorage = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "dream-agent-activity-v1";
const DETAIL_MAX_LENGTH = 500;
const STATUSES: readonly string[] = [
  "running",
  "waiting",
  "finished",
  "failed",
  "interrupted",
];

/** A turn saved while running was lost with the window that followed it. */
const readTurns = (storage: TurnStorage | null): Record<string, ChatTurn> => {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    const turns: Record<string, ChatTurn> = {};
    for (const [chatId, value] of Object.entries(saved)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as ChatTurn;
      if (!Number.isFinite(entry.updatedAt) || !STATUSES.includes(entry.status))
        continue;
      const lost = entry.status === "running" || entry.status === "waiting";
      turns[chatId] = {
        status: lost ? "interrupted" : entry.status,
        updatedAt: entry.updatedAt,
        detail: lost || typeof entry.detail !== "string" ? "" : entry.detail,
      };
    }
    return turns;
  } catch {
    return {};
  }
};

const defaultStorage = (): TurnStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

type Source = "session" | "host";

/** One ending report; a higher rank says more about how the turn ended. */
interface Ending {
  how: TurnEnding;
  detail: string;
  rank: number;
}

/** A turn running now, and which sources report it. */
interface LiveTurn {
  session: boolean;
  host: boolean;
  /** What the session's transcript asks of the user (null: nothing). */
  sessionAttention: string | null;
  hostAwaiting: boolean;
  hostEnding?: AgentTurnEnding;
  ending: Ending | null;
}

const reportOf = (
  source: Source,
  how: TurnEnding | undefined,
  detail: string,
): Ending =>
  source === "host"
    ? { how: how ?? "finished", detail, rank: how === undefined ? 1 : 4 }
    : how === undefined
      ? { how: "interrupted", detail: "", rank: 0 }
      : { how, detail, rank: how === "failed" ? 3 : 2 };

const without = <Value>(record: Record<string, Value>, keys: string[]) => {
  const present = keys.filter((key) => Object.hasOwn(record, key));
  if (present.length === 0) return record;
  const next = { ...record };
  for (const key of present) delete next[key];
  return next;
};

const keysAdded = (
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
) => Object.keys(next).filter((key) => next[key] && !previous[key]);

const NOTHING_WATCHED: WatchedIdeState = {
  activeProjectId: null,
  chats: [],
  hostAwaitingApprovalChatIds: {},
  hostRunningChatIds: {},
  projects: [],
};

export const createChatTurnOutcomes = ({
  now = Date.now,
  storage = defaultStorage(),
}: {
  now?: () => number;
  storage?: TurnStorage | null;
} = {}): ChatTurnOutcomes => {
  const store = createStore<ChatTurnOutcomeState>(() => ({
    errors: {},
    turns: readTurns(storage),
    unread: {},
  }));
  store.subscribe((state, previous) => {
    if (state.turns === previous.turns) return;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(state.turns));
    } catch {
      // The outcome still works when local storage is unavailable.
    }
  });

  const live = new Map<string, LiveTurn>();
  let watched: WatchedIdeStore | null = null;

  // A host change can start, ask and end several turns at once; they reach
  // readers (and notifications) as one write.
  let draft: ChatTurnOutcomeState | null = null;
  const current = () => draft ?? store.getState();
  const write = (next: ChatTurnOutcomeState) => {
    if (next === current()) return;
    if (draft) draft = next;
    else store.setState(next, true);
  };
  const batch = (apply: () => void) => {
    draft = store.getState();
    try {
      apply();
    } finally {
      const next = draft;
      draft = null;
      if (next !== store.getState()) store.setState(next, true);
    }
  };

  const setTurn = (
    state: ChatTurnOutcomeState,
    chatId: string,
    turn: ChatTurn,
  ): ChatTurnOutcomeState => ({
    ...state,
    turns: { ...state.turns, [chatId]: turn },
  });

  /** Unread when it ended in a live chat no one is looking at. */
  const endsUnread = (chatId: string) => {
    if (!watched) return false;
    const state = watched.getState();
    const chat = state.chats.find((item) => item.id === chatId);
    if (!chat || chat.deletedAt !== null) return false;
    const shown =
      state.activeProjectId === chat.projectId &&
      state.projects.find((project) => project.id === chat.projectId)?.ui
        .activeChatId === chatId;
    return !shown;
  };

  const begin = (chatId: string, source: Source) => {
    let turn = live.get(chatId);
    if (!turn) {
      turn = {
        ending: null,
        host: false,
        hostAwaiting: false,
        session: false,
        sessionAttention: null,
      };
      live.set(chatId, turn);
      const state = current();
      write({
        ...setTurn(state, chatId, {
          detail: "",
          status: "running",
          updatedAt: now(),
        }),
        unread: without(state.unread, [chatId]),
      });
    }
    turn[source] = true;
  };

  const ask = (chatId: string, source: Source, detail: string | null) => {
    const turn = live.get(chatId);
    if (!turn) return;
    if (source === "session") turn.sessionAttention = detail;
    else turn.hostAwaiting = detail !== null;
    const waiting = turn.sessionAttention !== null || turn.hostAwaiting;
    const status = waiting ? "waiting" : "running";
    const nextDetail = (turn.sessionAttention ?? "").slice(
      0,
      DETAIL_MAX_LENGTH,
    );
    const state = current();
    const previous = state.turns[chatId];
    if (previous?.status === status && previous.detail === nextDetail) return;
    write(
      setTurn(state, chatId, {
        detail: nextDetail,
        status,
        updatedAt: previous?.status === status ? previous.updatedAt : now(),
      }),
    );
  };

  const end = (
    chatId: string,
    source: Source,
    how: TurnEnding | undefined,
    detail = "",
  ) => {
    const report = reportOf(source, how, detail.slice(0, DETAIL_MAX_LENGTH));
    if (report.how === "failed" && report.detail) {
      const state = current();
      write({
        ...state,
        errors: { ...state.errors, [chatId]: report.detail },
      });
    }
    const turn = live.get(chatId);
    const record = (into: LiveTurn) => {
      if (
        !into.ending ||
        report.rank > into.ending.rank ||
        (report.rank === into.ending.rank &&
          report.how === "failed" &&
          report.detail)
      )
        into.ending = report;
    };

    if (!turn?.[source]) {
      // A report about no turn this source follows: only a failure counts.
      if (report.how !== "failed") return;
      if (turn) {
        record(turn);
        return;
      }
      const state = current();
      // A later cleanup must not overwrite the failure itself.
      if (state.turns[chatId]?.status === "failed" && !report.detail) return;
      write(
        setTurn(state, chatId, {
          detail: report.detail,
          status: "failed",
          updatedAt: now(),
        }),
      );
      return;
    }

    turn[source] = false;
    record(turn);
    if (turn.session || turn.host) return;

    live.delete(chatId);
    const ending = turn.ending ?? report;
    // A turn that ended asking its user something waits on them.
    const waiting = ending.how === "finished" && turn.sessionAttention !== null;
    const state = current();
    write({
      ...setTurn(state, chatId, {
        detail: waiting
          ? (turn.sessionAttention ?? "").slice(0, DETAIL_MAX_LENGTH)
          : ending.how === "failed"
            ? ending.detail
            : "",
        status: waiting ? "waiting" : ending.how,
        updatedAt: now(),
      }),
      unread: endsUnread(chatId)
        ? { ...state.unread, [chatId]: true }
        : without(state.unread, [chatId]),
    });
  };

  const see = (chatIds: string[]) => {
    if (chatIds.length === 0) return;
    const state = current();
    const nextUnread = without(state.unread, chatIds);
    if (nextUnread === state.unread) return;
    write({ ...state, unread: nextUnread });
  };

  /** Chats gone from the store take their whole outcome with them. */
  const forget = (chatIds: string[]) => {
    if (chatIds.length === 0) return;
    for (const chatId of chatIds) live.delete(chatId);
    const state = current();
    const errors = without(state.errors, chatIds);
    const turns = without(state.turns, chatIds);
    const unread = without(state.unread, chatIds);
    if (
      errors === state.errors &&
      turns === state.turns &&
      unread === state.unread
    ) {
      return;
    }
    write({ errors, turns, unread });
  };

  const followHost = (state: WatchedIdeState, previous: WatchedIdeState) => {
    const running = state.hostRunningChatIds;
    const wasRunning = previous.hostRunningChatIds;
    if (running !== wasRunning)
      for (const chatId of keysAdded(running, wasRunning))
        begin(chatId, "host");

    const awaiting = state.hostAwaitingApprovalChatIds;
    const wasAwaiting = previous.hostAwaitingApprovalChatIds;
    if (awaiting !== wasAwaiting) {
      for (const chatId of keysAdded(awaiting, wasAwaiting))
        ask(chatId, "host", "");
      for (const chatId of keysAdded(wasAwaiting, awaiting))
        ask(chatId, "host", null);
    }

    if (running !== wasRunning)
      for (const chatId of keysAdded(wasRunning, running)) {
        const ending = live.get(chatId)?.hostEnding;
        end(
          chatId,
          "host",
          ending?.status,
          ending?.status === "failed" ? ending.detail : undefined,
        );
      }

    if (state.chats !== previous.chats) {
      const deletedAt = new Map(
        state.chats.map((chat) => [chat.id, chat.deletedAt]),
      );
      const removed: string[] = [];
      const deleted: string[] = [];
      for (const chat of previous.chats) {
        if (!deletedAt.has(chat.id)) removed.push(chat.id);
        else if (chat.deletedAt === null && deletedAt.get(chat.id) !== null)
          deleted.push(chat.id);
      }
      forget(removed);
      // A deleted chat can be restored; it only loses its mark.
      see(deleted);
    }
  };

  return {
    store,
    started: (chatId) => begin(chatId, "session"),
    attention: (chatId, detail) => ask(chatId, "session", detail),
    ended: (chatId, how, detail) => end(chatId, "session", how, detail),
    reportHostEnding: (chatId, ending) => {
      const turn = live.get(chatId);
      if (turn?.host) turn.hostEnding = ending;
    },
    reportError: (chatId, message) => {
      const state = current();
      if (message) {
        if (state.errors[chatId] === message) return;
        write({ ...state, errors: { ...state.errors, [chatId]: message } });
      } else {
        const nextErrors = without(state.errors, [chatId]);
        if (nextErrors === state.errors) return;
        write({ ...state, errors: nextErrors });
      }
    },
    seen: (chatIds) => see([...chatIds]),
    watch: (ideStore) => {
      watched = ideStore;
      batch(() => followHost(ideStore.getState(), NOTHING_WATCHED));
      const unsubscribe = ideStore.subscribe((state, previous) =>
        batch(() => followHost(state, previous)),
      );
      return () => {
        unsubscribe();
        if (watched === ideStore) watched = null;
      };
    },
  };
};

/** This window's chat turn outcomes. */
export const chatTurnOutcomes = createChatTurnOutcomes();

export const useChatTurnOutcomes = <Selected>(
  selector: (state: ChatTurnOutcomeState) => Selected,
) => useStore(chatTurnOutcomes.store, selector);
