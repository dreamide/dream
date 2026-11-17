// The Chat turn outcome through its interface: this window's session
// reporting turns, the host's running and waiting chats in a watched store,
// and seeing chats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ProjectConfig } from "@/types/ide";
import {
  createChatTurnOutcomes,
  type TurnStorage,
  type WatchedIdeState,
} from "./chat-turn-outcome";

const project = createProjectConfig("/workspace/app", DEFAULT_SETTINGS);
const shownChat = createChatConfig(project, { title: "Shown" });
const otherChat = createChatConfig(project, { title: "Other" });
const shownProject: ProjectConfig = {
  ...project,
  ui: { ...project.ui, activeChatId: shownChat.id },
};

/** A store with one project in front, showing `shownChat`. */
const setUp = ({ storage = null }: { storage?: TurnStorage | null } = {}) => {
  const ide = createStore<WatchedIdeState>(() => ({
    activeProjectId: shownProject.id,
    chats: [shownChat, otherChat],
    hostAwaitingApprovalChatIds: {},
    hostRunningChatIds: {},
    projects: [shownProject],
  }));
  let time = 0;
  const outcomes = createChatTurnOutcomes({ now: () => ++time, storage });
  outcomes.watch(ide);
  // Every status a chat's turn passes through, as a reader sees it.
  const statuses: string[] = [];
  outcomes.store.subscribe((state, previous) => {
    for (const [chatId, turn] of Object.entries(state.turns))
      if (turn.status !== previous.turns[chatId]?.status)
        statuses.push(turn.status);
  });
  const host = {
    // As the store applies a `turn` event: an ended turn waits on nothing.
    running: (chatId: string, running: boolean) => {
      const state = ide.getState();
      const { [chatId]: _, ...rest } = state.hostRunningChatIds;
      const { [chatId]: __, ...notAwaiting } =
        state.hostAwaitingApprovalChatIds;
      ide.setState({
        hostAwaitingApprovalChatIds: running
          ? state.hostAwaitingApprovalChatIds
          : notAwaiting,
        hostRunningChatIds: running ? { ...rest, [chatId]: true } : rest,
      });
    },
    awaiting: (chatId: string, awaiting: boolean) => {
      const { [chatId]: _, ...rest } =
        ide.getState().hostAwaitingApprovalChatIds;
      ide.setState({
        hostAwaitingApprovalChatIds: awaiting
          ? { ...rest, [chatId]: true }
          : rest,
      });
    },
  };
  const read = () => outcomes.store.getState();
  return { host, ide, outcomes, read, statuses };
};

test("a session turn finishing marks a chat not shown unread", () => {
  const { outcomes, read, statuses } = setUp();

  outcomes.started(otherChat.id);
  outcomes.attention(otherChat.id, null);
  outcomes.ended(otherChat.id, "finished");
  outcomes.started(shownChat.id);
  outcomes.ended(shownChat.id, "finished");

  assert.equal(read().turns[otherChat.id]?.status, "finished");
  assert.equal(read().turns[shownChat.id]?.status, "finished");
  assert.deepEqual(statuses, ["running", "finished", "running", "finished"]);
  // The chat on screen was seen as it ended.
  assert.deepEqual(read().unread, { [otherChat.id]: true });
});

test("a session turn failing shows its error at once and ends failed", () => {
  const { host, outcomes, read, statuses } = setUp();

  host.running(otherChat.id, true);
  outcomes.started(otherChat.id);
  outcomes.ended(otherChat.id, "failed", "Provider quota exceeded");
  // On the banner before the host says the turn is over.
  assert.equal(read().errors[otherChat.id], "Provider quota exceeded");
  assert.equal(read().turns[otherChat.id]?.status, "running");

  // The AI SDK's own finish, then the host's end, say less.
  outcomes.ended(otherChat.id, "failed");
  outcomes.ended(otherChat.id, "finished");
  host.running(otherChat.id, false);

  assert.deepEqual(read().turns[otherChat.id], {
    detail: "Provider quota exceeded",
    status: "failed",
    updatedAt: read().turns[otherChat.id]?.updatedAt,
  });
  assert.deepEqual(statuses, ["running", "failed"]);
  assert.equal(read().unread[otherChat.id], true);
});

test("a host turn this window does not follow starts, ends and marks its chat unread", () => {
  const { host, read, statuses } = setUp();

  host.running(otherChat.id, true);
  assert.equal(read().turns[otherChat.id]?.status, "running");
  host.running(otherChat.id, false);

  assert.equal(read().turns[otherChat.id]?.status, "finished");
  assert.deepEqual(statuses, ["running", "finished"]);
  assert.equal(read().unread[otherChat.id], true);
});

test("a followed turn both sources report is one turn, whichever ends first", () => {
  for (const sessionEndsFirst of [true, false]) {
    const { host, outcomes, read, statuses } = setUp();

    host.running(otherChat.id, true);
    outcomes.started(otherChat.id);
    if (sessionEndsFirst) {
      outcomes.ended(otherChat.id, "finished");
      assert.equal(read().turns[otherChat.id]?.status, "running");
      host.running(otherChat.id, false);
    } else {
      host.running(otherChat.id, false);
      assert.equal(read().turns[otherChat.id]?.status, "running");
      outcomes.ended(otherChat.id, "finished");
    }
    // The session settles after reporting the end: nothing more.
    outcomes.ended(otherChat.id);

    assert.deepEqual(statuses, ["running", "finished"]);
  }
});

test("a turn the user stopped is interrupted, though the host only says it ended", () => {
  const { host, outcomes, read } = setUp();

  host.running(otherChat.id, true);
  outcomes.started(otherChat.id);
  host.running(otherChat.id, false);
  outcomes.ended(otherChat.id, "interrupted");

  assert.equal(read().turns[otherChat.id]?.status, "interrupted");
});

test("a session that only stops following leaves the end to the host", () => {
  const { host, outcomes, read } = setUp();

  host.running(otherChat.id, true);
  outcomes.started(otherChat.id);
  // The host became unreachable; its turn runs on.
  outcomes.ended(otherChat.id);
  assert.equal(read().turns[otherChat.id]?.status, "running");

  host.running(otherChat.id, false);
  assert.equal(read().turns[otherChat.id]?.status, "finished");
});

test("a host approval makes the chat wait on its user until it is answered", () => {
  const { host, read, statuses } = setUp();

  host.running(otherChat.id, true);
  host.awaiting(otherChat.id, true);
  assert.equal(read().turns[otherChat.id]?.status, "waiting");
  host.awaiting(otherChat.id, false);
  assert.equal(read().turns[otherChat.id]?.status, "running");
  host.awaiting(otherChat.id, true);
  // The host clears the approval as the turn ends, in one change.
  host.running(otherChat.id, false);

  assert.deepEqual(statuses, [
    "running",
    "waiting",
    "running",
    "waiting",
    "finished",
  ]);
});

test("a session question shows as the turn's detail, and a turn ending on one waits", () => {
  const { outcomes, read } = setUp();

  outcomes.started(otherChat.id);
  outcomes.attention(otherChat.id, "Which branch?");
  assert.deepEqual(
    [read().turns[otherChat.id]?.status, read().turns[otherChat.id]?.detail],
    ["waiting", "Which branch?"],
  );
  outcomes.ended(otherChat.id, "finished");

  assert.deepEqual(
    [read().turns[otherChat.id]?.status, read().turns[otherChat.id]?.detail],
    ["waiting", "Which branch?"],
  );
});

test("seeing a chat clears its mark, and so does its next turn", () => {
  const { host, outcomes, read } = setUp();

  host.running(otherChat.id, true);
  host.running(otherChat.id, false);
  assert.equal(read().unread[otherChat.id], true);
  outcomes.seen([otherChat.id]);
  assert.deepEqual(read().unread, {});

  host.running(otherChat.id, true);
  host.running(otherChat.id, false);
  assert.equal(read().unread[otherChat.id], true);
  host.running(otherChat.id, true);
  assert.deepEqual(read().unread, {});
});

test("a deleted chat loses its mark and a removed one its whole outcome", () => {
  const { host, ide, outcomes, read } = setUp();

  for (const chat of [shownChat, otherChat]) {
    host.running(chat.id, true);
    host.running(chat.id, false);
    outcomes.reportError(chat.id, "Lost");
  }
  outcomes.seen([shownChat.id]);
  ide.setState({
    chats: [
      { ...otherChat, deletedAt: new Date().toISOString() },
      // shownChat is removed for good.
    ],
  });

  assert.deepEqual(read().unread, {});
  assert.deepEqual(Object.keys(read().turns), [otherChat.id]);
  assert.deepEqual(Object.keys(read().errors), [otherChat.id]);
});

test("a host already running a turn when watching starts counts it", () => {
  const ide = createStore<WatchedIdeState>(() => ({
    activeProjectId: null,
    chats: [otherChat],
    hostAwaitingApprovalChatIds: { [otherChat.id]: true },
    hostRunningChatIds: { [otherChat.id]: true },
    projects: [project],
  }));
  const outcomes = createChatTurnOutcomes({ storage: null });
  outcomes.watch(ide);

  assert.equal(
    outcomes.store.getState().turns[otherChat.id]?.status,
    "waiting",
  );
});

test("turns are kept across reloads, a running one as interrupted", () => {
  const saved = new Map<string, string>();
  const storage: TurnStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  };
  const { host, outcomes } = setUp({ storage });

  outcomes.started(shownChat.id);
  outcomes.ended(shownChat.id, "failed", "Provider quota exceeded");
  host.running(otherChat.id, true);

  const reloaded = createChatTurnOutcomes({ storage }).store.getState();
  assert.equal(reloaded.turns[shownChat.id]?.status, "failed");
  assert.equal(reloaded.turns[shownChat.id]?.detail, "Provider quota exceeded");
  assert.equal(reloaded.turns[otherChat.id]?.status, "interrupted");
  // The mark and the banner are this window's.
  assert.deepEqual([reloaded.unread, reloaded.errors], [{}, {}]);
});
