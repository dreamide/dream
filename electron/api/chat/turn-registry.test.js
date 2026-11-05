import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createTurnRegistry,
  TURN_ID_HEADER,
  TURN_OFFSET_HEADER,
  TurnInProgressError,
} from "./turn-registry.js";

const encoder = new TextEncoder();

/** A streaming response whose chunks the test writes and ends. */
const controllableResponse = () => {
  let controller;
  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    end: () => controller.close(),
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
    write: (text) => controller.enqueue(encoder.encode(text)),
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a turn runs to its end even when its first client goes away", async () => {
  const events = [];
  const turns = createTurnRegistry({ onChange: (event) => events.push(event) });
  const turn = controllableResponse();

  const first = await turns.start({ chatId: "c1", run: () => turn.response });
  await first.body.cancel();
  turn.write("a");
  turn.write("b");
  turn.end();
  await settle();

  assert.equal(turns.isRunning("c1"), false);
  assert.deepEqual(events, [
    { chatId: "c1", running: true },
    { chatId: "c1", running: false },
  ]);
});

test("a client that reconnects gets the whole turn from its start", async () => {
  const turns = createTurnRegistry();
  const turn = controllableResponse();
  await turns.start({ chatId: "c1", run: () => turn.response });
  turn.write("one,");
  await settle();

  const resumed = turns.resume("c1");
  turn.write("two");
  turn.end();

  assert.equal(await resumed.text(), "one,two");
  assert.equal(resumed.headers.get("content-type"), "text/event-stream");
  assert.equal(turns.resume("c1"), null);
});

test("a client holding a turn's first bytes gets only the rest", async () => {
  const turns = createTurnRegistry();
  const turn = controllableResponse();
  const first = await turns.start({ chatId: "c1", run: () => turn.response });
  const turnId = first.headers.get(TURN_ID_HEADER);
  assert.match(turnId, /^[0-9a-f-]{36}$/);
  assert.equal(first.headers.get(TURN_OFFSET_HEADER), "0");
  turn.write("one,");
  turn.write("two,");
  await settle();

  // Inside a chunk as well as on a boundary.
  const tail = turns.resume("c1", { from: 6, turnId });
  const boundary = turns.resume("c1", { from: 4, turnId });
  turn.write("three");
  turn.end();

  assert.equal(tail.headers.get(TURN_OFFSET_HEADER), "6");
  assert.equal(tail.headers.get(TURN_ID_HEADER), turnId);
  assert.equal(await tail.text(), "o,three");
  assert.equal(await boundary.text(), "two,three");
  await first.body.cancel();
});

test("another turn, or an offset not reached, replays from the start", async () => {
  const turns = createTurnRegistry();
  const turn = controllableResponse();
  const first = await turns.start({ chatId: "c1", run: () => turn.response });
  const turnId = first.headers.get(TURN_ID_HEADER);
  turn.write("abc");
  await settle();

  const otherTurn = turns.resume("c1", { from: 2, turnId: "another" });
  const ahead = turns.resume("c1", { from: 4, turnId });
  const noOffset = turns.resume("c1", { from: 0, turnId });
  turn.end();

  for (const response of [otherTurn, ahead, noOffset]) {
    assert.equal(response.headers.get(TURN_OFFSET_HEADER), "0");
    assert.equal(await response.text(), "abc");
  }
  await first.body.cancel();
});

test("a chat runs one turn at a time", async () => {
  const turns = createTurnRegistry();
  const turn = controllableResponse();
  await turns.start({ chatId: "c1", run: () => turn.response });

  await assert.rejects(
    turns.start({ chatId: "c1", run: () => controllableResponse().response }),
    TurnInProgressError,
  );
  assert.deepEqual(turns.runningChatIds(), ["c1"]);
  turn.end();
});

test("only an explicit stop aborts a turn", async () => {
  const turns = createTurnRegistry();
  let signal = null;
  const turn = controllableResponse();
  await turns.start({
    chatId: "c1",
    run: (turnSignal) => {
      signal = turnSignal;
      return turn.response;
    },
  });

  assert.equal(signal.aborted, false);
  assert.equal(turns.stop("c1"), true);
  assert.equal(signal.aborted, true);
  assert.equal(turns.stop("other"), false);
  turn.end();
});

test("an answer without a stream is passed on and keeps no turn", async () => {
  const turns = createTurnRegistry();

  const answer = await turns.start({
    chatId: "c1",
    run: () => new Response(null, { status: 400 }),
  });

  assert.equal(answer.status, 400);
  assert.equal(turns.isRunning("c1"), false);
});

test("a turn preparing its response owns the chat but exposes no incomplete stream", async () => {
  const turns = createTurnRegistry();
  let release;
  const starting = turns.start({
    chatId: "c",
    run: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  assert.equal(turns.isRunning("c"), true);
  assert.deepEqual(turns.streamingChatIds(), []);
  assert.equal(turns.resume("c"), null);
  const turn = controllableResponse();
  release(turn.response);
  const response = await starting;
  assert.deepEqual(turns.streamingChatIds(), ["c"]);
  turn.end();
  await response.text();
});
