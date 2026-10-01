import { expect, test } from "vitest";
import { createCatalogEvents } from "./catalog-events.js";

const setup = (options = {}) => {
  const broadcasts = [];
  const catalog = createCatalogEvents({
    broadcast: (message) => broadcasts.push(message),
    epoch: "e1",
    ...options,
  });
  const resume = (cursor) => {
    const sent = [];
    catalog.resume((message) => sent.push(message), cursor);
    return sent;
  };
  return { broadcasts, catalog, resume };
};

test("each change goes to every client, numbered", () => {
  const { broadcasts, catalog } = setup();

  catalog.publish({ kind: "chat-created", chatId: "a" });
  catalog.publish({ kind: "chat-deleted", chatId: "a" });

  expect(broadcasts).toEqual([
    {
      channel: "catalog",
      type: "event",
      epoch: "e1",
      seq: 1,
      event: { kind: "chat-created", chatId: "a" },
    },
    {
      channel: "catalog",
      type: "event",
      epoch: "e1",
      seq: 2,
      event: { kind: "chat-deleted", chatId: "a" },
    },
  ]);
  expect(catalog.getCursor()).toEqual({ epoch: "e1", seq: 2 });
});

test("a reconnecting client gets only what came after its cursor", () => {
  const { catalog, resume } = setup();
  catalog.publish({ kind: "a" });
  catalog.publish({ kind: "b" });
  catalog.publish({ kind: "c" });

  expect(resume({ epoch: "e1", seq: 1 }).map((m) => m.event.kind)).toEqual([
    "b",
    "c",
  ]);
  expect(resume({ epoch: "e1", seq: 3 })).toEqual([]);
});

test("a client the log cannot catch up is told to refetch", () => {
  const { catalog, resume } = setup({ retain: 2 });
  catalog.publish({ kind: "a" });
  catalog.publish({ kind: "b" });
  catalog.publish({ kind: "c" });
  const reset = { channel: "catalog", type: "reset", epoch: "e1", seq: 3 };

  expect(resume(null)).toEqual([reset]); // a first connect
  expect(resume({ epoch: "e0", seq: 3 })).toEqual([reset]); // host restarted
  expect(resume({ epoch: "e1", seq: 0 })).toEqual([reset]); // too old
  expect(resume({ epoch: "e1", seq: 9 })).toEqual([reset]); // from nowhere
  expect(resume({ epoch: "e1", seq: 1 }).map((m) => m.seq)).toEqual([2, 3]);
});
