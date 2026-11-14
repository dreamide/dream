// Following host turns, through the module's interface: when it follows,
// how it keeps to one follow per chat, how it retries a lost stream, and
// when it stops. The runtime's part (what a follow does) is a fake the test
// controls, and so are the timers.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createTurnFollowing,
  ENDED_STREAM_GRACE_MS,
  MAX_FOLLOW_RETRY_MS,
  MIN_FOLLOW_RETRY_MS,
} from "./turn-following";

interface Session {
  chatId: string;
  streaming: boolean;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const setup = ({ host = "local" }: { host?: string } = {}) => {
  const running = new Set<string>();
  const current = new Map<string, Session>();
  const followed: string[] = [];
  const stopped: string[] = [];
  const settled: string[] = [];
  // Each follow waits until the test ends it: true (clean), false, or an error.
  const ends: ((outcome: boolean | Error) => void)[] = [];
  const scheduled: { callback: () => void; ms: number }[] = [];
  const following = createTurnFollowing<Session>({
    canFollow: (chatId) => running.has(chatId),
    follow: (session) => {
      followed.push(session.chatId);
      return new Promise((resolve, reject) =>
        ends.push((outcome) =>
          outcome instanceof Error ? reject(outcome) : resolve(outcome),
        ),
      );
    },
    hostOf: () => host,
    isCurrent: (session) => current.get(session.chatId) === session,
    isStreaming: (session) => session.streaming,
    // A transient failure is a lost stream, as the runtime decides.
    onError: (session) => following.lost(session.chatId),
    onSettled: (session) => settled.push(session.chatId),
    stopStream: (session) => stopped.push(session.chatId),
    timers: {
      clear: (timer) => {
        const index = scheduled.indexOf(timer as (typeof scheduled)[number]);
        if (index >= 0) scheduled.splice(index, 1);
      },
      set: (callback, ms) => {
        const timer = { callback, ms };
        scheduled.push(timer);
        return timer;
      },
    },
  });
  const session = (chatId: string): Session => {
    const made = { chatId, streaming: false };
    current.set(chatId, made);
    return made;
  };
  const end = async (outcome: boolean | Error) => {
    ends.shift()?.(outcome);
    await flush();
  };
  return {
    current,
    end,
    followed,
    following,
    running,
    scheduled,
    session,
    settled,
    stopped,
  };
};

test("only a running turn on a reachable host is followed, and one follow at a time", async () => {
  const { end, followed, following, running, session, settled } = setup();
  const chat = session("c");
  following.follow(chat);
  assert.deepEqual(followed, [], "no turn runs");

  running.add("c");
  chat.streaming = true;
  following.follow(chat);
  assert.deepEqual(followed, [], "this session already streams it");

  chat.streaming = false;
  following.follow(chat);
  following.follow(chat);
  assert.deepEqual(followed, ["c"]);
  await end(true);
  assert.deepEqual(settled, ["c"]);
});

test("a turn that starts during a follow is followed once that one ends", async () => {
  const { end, followed, following, running, session } = setup();
  running.add("c");
  const chat = session("c");
  following.follow(chat);
  following.follow(chat, { newTurn: true });
  assert.deepEqual(followed, ["c"]);
  await end(true);
  assert.deepEqual(followed, ["c", "c"]);
});

test("a lost stream is followed again, waiting twice as long each time up to a ceiling", async () => {
  const { end, followed, following, running, scheduled, session } = setup();
  running.add("c");
  const chat = session("c");
  following.follow(chat);

  const waits: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    await end(new Error("network"));
    assert.equal(following.isLost("c"), true);
    const retry = scheduled.shift();
    assert.ok(retry, `retry ${attempt}`);
    waits.push(retry.ms);
    retry.callback();
  }
  assert.deepEqual(waits, [
    MIN_FOLLOW_RETRY_MS,
    500,
    1000,
    2000,
    4000,
    MAX_FOLLOW_RETRY_MS,
    MAX_FOLLOW_RETRY_MS,
  ]);
  assert.equal(followed.length, 8);
});

test("bytes arriving reset the wait, and a clean end stops the retries", async () => {
  const { end, following, running, scheduled, session } = setup();
  running.add("c");
  const chat = session("c");
  following.follow(chat);
  await end(new Error("network"));
  scheduled.shift()?.callback();
  await end(new Error("network"));
  assert.equal(scheduled[0].ms, 500);
  scheduled.shift()?.callback();

  // The retry's first bytes say the lost stream is live again (the runtime
  // then clears its error banner); later bytes say nothing new.
  assert.equal(following.receiving("c"), true);
  assert.equal(following.receiving("c"), false);
  following.lost("c");
  await end(new Error("network"));
  assert.equal(scheduled[0].ms, MIN_FOLLOW_RETRY_MS, "the wait starts over");
  scheduled.shift()?.callback();

  await end(true);
  assert.equal(following.isLost("c"), false);
  assert.equal(scheduled.length, 0);
});

test("following stops when the turn ends, the session is replaced, or it is forgotten", async () => {
  const { current, end, following, running, scheduled, session, settled } =
    setup();
  running.add("c");
  const chat = session("c");
  following.follow(chat);
  running.delete("c");
  await end(new Error("network"));
  assert.equal(scheduled.length, 0, "the turn ended: nothing to follow");

  running.add("c");
  following.follow(chat);
  current.delete("c");
  await end(new Error("network"));
  assert.equal(scheduled.length, 0, "a replaced session is left alone");
  assert.deepEqual(settled, ["c"], "and not settled");

  const next = session("c");
  following.follow(next);
  await end(new Error("network"));
  assert.equal(scheduled.length, 1);
  following.forget("c");
  assert.equal(scheduled.length, 0, "forgetting cancels the retry");
});

test("a stream still open after its turn ended is dropped, and settles as ended", async () => {
  const { end, following, running, scheduled, session, settled, stopped } =
    setup();
  running.add("c");
  const chat = session("c");
  following.follow(chat);

  // The host says the turn ended; the stream it was read on never closes.
  running.delete("c");
  following.ended("c");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, ENDED_STREAM_GRACE_MS);
  assert.deepEqual(stopped, [], "the stream gets a grace period first");

  scheduled.shift()?.callback();
  assert.deepEqual(stopped, ["c"], "then the stalled stream is dropped");
  assert.equal(following.isEnded("c"), true);

  // Dropping it ends the follow, which settles (loading the transcript).
  await end(true);
  assert.deepEqual(settled, ["c"]);
  assert.equal(scheduled.length, 0, "and it is not followed again");
});

test("a stream that closes after its turn ended is left alone", async () => {
  const { end, following, running, scheduled, session, stopped } = setup();
  running.add("c");
  const chat = session("c");
  following.follow(chat);
  running.delete("c");
  following.ended("c");
  await end(true);
  assert.equal(scheduled.length, 0, "closing cancels the wait");
  assert.deepEqual(stopped, []);
  assert.equal(following.isEnded("c"), false);

  // Nothing is followed: an ended turn with no follow has nothing to drop.
  following.ended("c");
  assert.equal(scheduled.length, 0);
});

test("a follow that starts after an ended one is not ended", async () => {
  const { end, following, running, scheduled, session, stopped } = setup();
  running.add("c");
  const chat = session("c");
  following.follow(chat);
  running.delete("c");
  following.ended("c");
  scheduled.shift()?.callback();
  await end(true);
  assert.equal(following.isEnded("c"), true);

  running.add("c");
  following.follow(chat);
  assert.equal(following.isEnded("c"), false);
  following.forget("c");
  assert.deepEqual(stopped, ["c"]);
});

test("reattaching drops streams being read and follows the rest, on that host only", async () => {
  const { end, followed, following, running, session, stopped } = setup();
  running.add("open");
  running.add("idle");
  const open = session("open");
  open.streaming = true;
  const idle = session("idle");

  following.reattach("devbox", [open, idle]);
  assert.deepEqual([followed, stopped], [[], []]);

  following.reattach("local", [open, idle]);
  assert.deepEqual(stopped, ["open"]);
  assert.deepEqual(followed, ["idle"]);

  // The dropped stream is followed again once it has ended.
  open.streaming = false;
  following.follow(open);
  assert.deepEqual(followed, ["idle", "open"]);
  await end(true);
});
