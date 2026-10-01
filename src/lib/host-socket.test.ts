import { expect, test } from "vitest";
import { createFakeHostSocket } from "./host-socket-fake";

test("connects with a ticket only once someone retains it", async () => {
  const { api, flush, socket, transports } = createFakeHostSocket();
  await flush();
  expect(transports).toHaveLength(0);

  socket.retain();
  await flush();

  expect(api.hostSocketTicket).toHaveBeenCalledTimes(1);
  expect(transports).toHaveLength(1);
});

test("resumes every channel in one message, then sends the outbox", async () => {
  const { flush, socket, transports } = createFakeHostSocket();
  socket.register({ name: "a", cursor: () => ({ at: 1 }), receive: () => {} });
  socket.register({ name: "b", cursor: () => null, receive: () => {} });
  socket.retain();
  socket.send({ channel: "a", type: "ping" });
  await flush();

  transports[0].open();

  expect(transports[0].sent).toEqual([
    { channel: "host", type: "resume", cursors: { a: { at: 1 }, b: null } },
    { channel: "a", type: "ping" },
  ]);
});

test("hands each message to its channel", async () => {
  const { flush, socket, transports } = createFakeHostSocket();
  const received: unknown[] = [];
  socket.register({
    name: "a",
    cursor: () => null,
    receive: (message) => received.push(message),
  });
  socket.retain();
  await flush();
  transports[0].open();

  transports[0].deliver({ channel: "a", type: "x" });
  transports[0].deliver({ channel: "other", type: "y" });

  expect(received).toEqual([{ channel: "a", type: "x" }]);
});

test("reconnects while retained, and not after release", async () => {
  const { flush, socket, timers, transports } = createFakeHostSocket();
  const release = socket.retain();
  await flush();
  transports[0].open();

  transports[0].close();
  expect(timers).toHaveLength(1);
  timers[0]();
  await flush();
  expect(transports).toHaveLength(2);

  release();
  transports[1].open();
  transports[1].close();
  expect(timers).toHaveLength(1);
});
