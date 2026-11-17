// The turn lifetime alone: one ending, cleanups on every ending, Stop, and a
// start that finishes after the turn already ended.
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createTurnLifetime } from "./turn-lifetime.js";

const settledState = (promise) =>
  Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 5)),
  ]);

test("a turn ends once: the first done or fail wins", async () => {
  const done = createTurnLifetime(undefined);
  done.done("first");
  done.fail(new Error("later"));
  done.done("second");
  assert.equal(done.ended, true);
  assert.equal(await done.settled, "first");

  const failed = createTurnLifetime(undefined);
  const error = new Error("first");
  failed.fail(error);
  failed.done("later");
  await assert.rejects(failed.settled, (thrown) => thrown === error);
});

test("cleanups run once, in reverse order, before the turn settles, however it ends", async () => {
  for (const end of ["done", "fail", "abort"]) {
    const controller = new AbortController();
    const life = createTurnLifetime(controller.signal);
    const order = [];
    life.defer(() => order.push("first"));
    life.defer(() => order.push("second"));
    life.settled.then(
      () => order.push("settled"),
      () => order.push("settled"),
    );
    if (end === "abort") {
      life.onAbort(() => life.done());
      controller.abort();
    } else if (end === "fail") {
      life.fail(new Error("boom"));
    } else {
      life.done();
    }
    life.done();
    await settledState(life.settled);
    assert.deepEqual(order, ["second", "first", "settled"], end);
  }
});

test("a cleanup that throws does not stop the others or the ending", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const life = createTurnLifetime(undefined);
    const ran = [];
    life.defer(() => ran.push("outer"));
    life.defer(() => {
      throw new Error("cleanup failed");
    });
    life.done("value");
    assert.equal(await life.settled, "value");
    assert.deepEqual(ran, ["outer"]);
    assert.equal(error.mock.calls.length, 1);
  } finally {
    error.mockRestore();
  }
});

test("Stop runs each abort handler once and does not end the turn by itself", async () => {
  const controller = new AbortController();
  const life = createTurnLifetime(controller.signal);
  let stops = 0;
  life.onAbort(() => {
    stops += 1;
  });
  controller.abort();
  controller.signal.dispatchEvent(new Event("abort"));
  assert.equal(stops, 1);
  assert.equal(life.aborted, true);
  assert.equal(life.ended, false);
  assert.equal(await settledState(life.settled), "pending");

  // The adapter decides when a stopped turn ends (an interrupt confirmed).
  life.done();
  assert.deepEqual(await settledState(life.settled), { value: undefined });
});

test("an abort handler added after Stop runs at once; one that throws fails the turn", async () => {
  const controller = new AbortController();
  controller.abort();
  const life = createTurnLifetime(controller.signal);
  let stopped = false;
  life.onAbort(() => {
    stopped = true;
  });
  assert.equal(stopped, true);

  const error = new Error("cancel failed");
  life.onAbort(() => {
    throw error;
  });
  assert.equal(life.ended, true);
  await assert.rejects(life.settled, (thrown) => thrown === error);
});

test("a turn that ended no longer hears Stop", async () => {
  const controller = new AbortController();
  const life = createTurnLifetime(controller.signal);
  let stops = 0;
  life.onAbort(() => {
    stops += 1;
  });
  life.done();
  controller.abort();
  life.onAbort(() => {
    stops += 1;
  });
  assert.equal(stops, 0);
  await life.settled;
});

test("a start that finishes after the turn ended is cleaned up at once", async () => {
  const controller = new AbortController();
  const life = createTurnLifetime(controller.signal);
  life.onAbort(() => life.done());

  // A server is starting when Stop arrives.
  let finishStart = () => {};
  const starting = new Promise((resolve) => {
    finishStart = resolve;
  });
  let closed = 0;
  const started = (async () => {
    const server = await starting;
    life.defer(() => {
      closed += 1;
      server.close();
    });
    return life.ended ? "abandoned" : "continued";
  })();

  controller.abort();
  assert.equal(life.ended, true);
  await life.settled;
  finishStart({ close: () => {} });
  assert.equal(await started, "abandoned");
  assert.equal(closed, 1);
});

test("run ends the turn with the promise its start returns, unless the adapter ended it first", async () => {
  const resolved = createTurnLifetime(undefined);
  let cleaned = false;
  const value = await resolved.run(async () => {
    resolved.defer(() => {
      cleaned = true;
    });
    return "answer";
  });
  assert.equal(value, "answer");
  assert.equal(cleaned, true);

  const thrown = createTurnLifetime(undefined);
  await assert.rejects(
    thrown.run(() => {
      throw new Error("sync start failed");
    }),
    /sync start failed/,
  );

  // A callback adapter returns `settled` and ends the turn itself.
  const callbacks = createTurnLifetime(undefined);
  const running = callbacks.run(() => {
    setTimeout(() => callbacks.done("later"), 1);
    return callbacks.settled;
  });
  assert.equal(callbacks.ended, false);
  assert.equal(await running, "later");

  // A start that returns nothing (a merged stream) ends the turn at once.
  const merged = createTurnLifetime(undefined);
  assert.equal(await merged.run(() => undefined), undefined);
  assert.equal(merged.ended, true);
});
