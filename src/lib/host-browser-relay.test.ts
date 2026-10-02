import { expect, test } from "vitest";
import {
  type BrowserToolCall,
  createHostBrowserRelay,
} from "./host-browser-relay";
import type { HostSocketChannel, HostSocketMessage } from "./host-socket";

const createSocket = () => {
  let channel: HostSocketChannel | null = null;
  const sent: HostSocketMessage[] = [];
  return {
    get channel() {
      if (!channel) throw new Error("No channel registered.");
      return channel;
    },
    register(next: HostSocketChannel) {
      channel = next;
      return () => {
        channel = null;
      };
    },
    send: (message: HostSocketMessage) => sent.push(message),
    sent,
  };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the window announces its open projects on resume and when they change", () => {
  const socket = createSocket();
  let projectIds = ["p1"];
  const relay = createHostBrowserRelay({
    getProjectIds: () => projectIds,
    runTool: async () => null,
    socket,
  });

  expect(socket.channel.cursor()).toEqual({ projectIds: ["p1"] });
  relay.announce();
  expect(socket.sent).toEqual([]);

  projectIds = ["p1", "p2"];
  relay.announce();
  relay.announce();
  expect(socket.sent).toEqual([
    { channel: "browser", projectIds: ["p1", "p2"], type: "projects" },
  ]);

  relay.stop();
  expect(() => socket.channel).toThrow();
});

test("the window runs the host's calls and answers each one", async () => {
  const socket = createSocket();
  const calls: BrowserToolCall[] = [];
  createHostBrowserRelay({
    getProjectIds: () => ["p1"],
    runTool: async (call) => {
      calls.push(call);
      if (call.tool === "browser_reload") throw new Error("no tab");
      return { content: [{ text: "ok", type: "text" }] };
    },
    socket,
  });

  socket.channel.receive({
    args: { tabId: "t1" },
    channel: "browser",
    id: "1",
    projectId: "p1",
    tool: "browser_snapshot",
    type: "call",
  });
  socket.channel.receive({
    channel: "browser",
    id: "2",
    projectId: "p1",
    tool: "browser_reload",
    type: "call",
  });
  // A project this window does not have open is not run.
  socket.channel.receive({
    channel: "browser",
    id: "3",
    projectId: "elsewhere",
    tool: "browser_list_tabs",
    type: "call",
  });
  await flush();

  expect(calls).toEqual([
    { args: { tabId: "t1" }, projectId: "p1", tool: "browser_snapshot" },
    { args: {}, projectId: "p1", tool: "browser_reload" },
  ]);
  expect(socket.sent).toEqual(
    expect.arrayContaining([
      {
        channel: "browser",
        id: "1",
        result: { content: [{ text: "ok", type: "text" }] },
        type: "result",
      },
      { channel: "browser", id: "2", message: "no tab", type: "error" },
      {
        channel: "browser",
        id: "3",
        message: "This Dream window no longer has the project open.",
        type: "error",
      },
    ]),
  );
});
