import { expect, test } from "vitest";
import { createCatalogEventsClient } from "./catalog-events";
import { createFakeHostSocket } from "./host-socket-fake";

const setup = async () => {
  const fake = createFakeHostSocket();
  const client = createCatalogEventsClient({ socket: fake.socket });
  const events: string[] = [];
  const resets: unknown[] = [];
  client.onEvent((event) => events.push(event.kind));
  client.onReset((cursor) => resets.push(cursor));
  await fake.flush();
  fake.transports[0].open();
  return { ...fake, client, events, resets };
};

const event = (epoch: string, seq: number, kind: string) => ({
  channel: "catalog",
  type: "event",
  epoch,
  seq,
  event: { kind },
});

test("a first connect asks from nowhere and is told to refetch", async () => {
  const { client, events, resets, transports } = await setup();

  expect(transports[0].sent[0]).toEqual({
    channel: "host",
    type: "resume",
    cursors: { catalog: null },
  });
  transports[0].deliver({
    channel: "catalog",
    type: "reset",
    epoch: "e1",
    seq: 5,
  });
  transports[0].deliver(event("e1", 6, "chat-created"));

  expect(resets).toEqual([{ epoch: "e1", seq: 5 }]);
  expect(events).toEqual(["chat-created"]);
  expect(client.getCursor()).toEqual({ epoch: "e1", seq: 6 });
});

test("events are applied once, in order", async () => {
  const { events, transports } = await setup();
  transports[0].deliver({
    channel: "catalog",
    type: "reset",
    epoch: "e1",
    seq: 0,
  });

  transports[0].deliver(event("e1", 1, "a"));
  transports[0].deliver(event("e1", 1, "a"));
  transports[0].deliver(event("e1", 2, "b"));

  expect(events).toEqual(["a", "b"]);
});

test("an event from a new epoch starts over instead of applying", async () => {
  const { events, resets, transports } = await setup();
  transports[0].deliver({
    channel: "catalog",
    type: "reset",
    epoch: "e1",
    seq: 3,
  });

  transports[0].deliver(event("e2", 1, "a"));

  expect(events).toEqual([]);
  expect(resets.at(-1)).toEqual({ epoch: "e2", seq: 1 });
});

test("a reconnect resumes from the last event seen", async () => {
  const { flush, timers, transports } = await setup();
  transports[0].deliver({
    channel: "catalog",
    type: "reset",
    epoch: "e1",
    seq: 0,
  });
  transports[0].deliver(event("e1", 1, "a"));

  transports[0].close();
  timers[0]();
  await flush();
  transports[1].open();

  expect(transports[1].sent[0]).toEqual({
    channel: "host",
    type: "resume",
    cursors: { catalog: { epoch: "e1", seq: 1 } },
  });
});
