import { afterEach, expect, test, vi } from "vitest";
import {
  type ApiTransport,
  apiClient,
  type ChatQueueResponse,
  createApiClient,
} from "@/lib/api-client";
import * as catalogEvents from "@/lib/catalog-events";
import { createFakeHostSocket } from "@/lib/host-socket-fake";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import { chatQueues, useIdeStore } from "../ide-store";
import { createCatalogActions } from "./catalog-actions";
import { watchHostCatalog } from "./host-catalog-watch";

const initial = useIdeStore.getState();
let stop = () => {};
afterEach(() => {
  stop();
  useIdeStore.setState(initial, true);
  vi.restoreAllMocks();
});

const setup = async (transport: ApiTransport) => {
  const first = {
    ...createProjectConfig("/first", DEFAULT_SETTINGS),
    hostId: "first",
  };
  const second = {
    ...createProjectConfig("/second", DEFAULT_SETTINGS),
    hostId: "second",
  };
  const chat = createChatConfig(first, {});
  const other = createChatConfig(second, {});
  const retry = createChatConfig(first, {});
  vi.spyOn(apiClient, "chatQueue").mockImplementation(
    createApiClient(transport).chatQueue,
  );
  useIdeStore.setState({
    projects: [first],
    closedProjects: [second],
    chats: [chat, other, retry],
    stateHydrated: true,
    refreshHostCatalog: async () => {},
  });
  const catalog = createCatalogActions(
    useIdeStore.setState,
    useIdeStore.getState,
    { persist: () => {} },
  );
  const clients = vi.spyOn(catalogEvents, "getCatalogEventsClient");
  const watch = async (hostId: string) => {
    const fake = createFakeHostSocket();
    clients.mockReturnValueOnce(
      catalogEvents.createCatalogEventsClient({ socket: fake.socket }),
    );
    const disconnect = watchHostCatalog(
      hostId,
      useIdeStore,
      catalog,
      chatQueues,
    );
    await fake.flush();
    const socket = fake.transports[0];
    socket.open();
    const reset = () =>
      socket.deliver({ channel: "catalog", type: "reset", epoch: "e", seq: 0 });
    const event = (seq: number, payload: catalogEvents.CatalogEvent) =>
      socket.deliver({
        channel: "catalog",
        type: "event",
        epoch: "e",
        seq,
        event: payload,
      });
    reset();
    return { disconnect, reset, event };
  };
  const firstHost = await watch("first");
  const secondHost = await watch("second");
  stop = () => {
    firstHost.disconnect();
    secondHost.disconnect();
  };
  return { chat, other, retry, firstHost, secondHost };
};

test.each([
  "success",
  "failure",
])("catalog removal retires a first read before its %s reply", async (result) => {
  const reply = Promise.withResolvers<ChatQueueResponse>();
  const transport = vi.fn<ApiTransport>().mockReturnValue(reply.promise);
  const { chat, firstHost } = await setup(transport);
  const read = chatQueues.refresh(chat.id);
  expect(transport.mock.calls[0][0]).toMatchObject({
    name: "chatQueue",
    hostId: "first",
    body: { chatId: chat.id },
  });
  firstHost.event(1, { kind: "changes", removedChatIds: [chat.id] });
  expect(useIdeStore.getState().chats.some((row) => row.id === chat.id)).toBe(
    false,
  );
  firstHost.event(2, { kind: "queue", chatId: chat.id });
  if (result === "success") reply.resolve({ paused: true, runs: [] });
  else reply.reject(new Error("Gone"));
  await read;
  expect(chatQueues.views.getState().has(chat.id)).toBe(false);
  expect(transport).toHaveBeenCalledTimes(1);
});

test("a Host reset refreshes its pending and failed reads while another Host keeps its queue", async () => {
  const pending = Promise.withResolvers<ChatQueueResponse>();
  const resumed = { paused: false, runs: [] };
  const paused = { paused: true, runs: [] };
  const transport = vi
    .fn<ApiTransport>()
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new Error("Retry"))
    .mockResolvedValueOnce(paused)
    .mockResolvedValue(resumed);
  const { chat, retry, other, firstHost, secondHost } = await setup(transport);
  const read = chatQueues.refresh(chat.id);
  await chatQueues.refresh(retry.id);
  await chatQueues.refresh(other.id);
  expect(chatQueues.views.getState().get(retry.id)?.error).toBe("Retry");
  transport.mockClear();
  firstHost.event(1, { kind: "queue", chatId: other.id });
  firstHost.reset();
  expect(
    transport.mock.calls.map(([request]) => [request.hostId, request.body]),
  ).toEqual([
    ["first", { chatId: chat.id }],
    ["first", { chatId: retry.id }],
  ]);
  pending.resolve(paused);
  await read;
  for (const row of [chat, retry]) {
    expect(chatQueues.views.getState().get(row.id)).toEqual({ queue: resumed });
  }
  expect(chatQueues.views.getState().get(other.id)).toEqual({ queue: paused });
  transport.mockClear();
  secondHost.reset();
  expect(
    transport.mock.calls.map(([request]) => [request.hostId, request.body]),
  ).toEqual([["second", { chatId: other.id }]]);
  await vi.waitFor(() =>
    expect(chatQueues.views.getState().get(other.id)).toEqual({
      queue: resumed,
    }),
  );
});
