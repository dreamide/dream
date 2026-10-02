import { expect, test } from "vitest";
import {
  BROWSER_CHANNEL,
  BrowserUnavailableError,
  createBrowserRelay,
} from "./browser-relay.js";
import { createHostSocket } from "./host-socket.js";

const window = () => {
  const sent = [];
  return { send: (message) => sent.push(message), sent };
};

test("a call goes to the window that announced the project most recently", async () => {
  const relay = createBrowserRelay();
  const a = window();
  const b = window();
  relay.resume(a.send, { projectIds: ["p1", "p2"] }, a);
  relay.resume(b.send, { projectIds: ["p1"] }, b);

  const call = relay.call("p1", "browser_snapshot", { tabId: "t1" });
  expect(a.sent).toEqual([]);
  expect(b.sent).toEqual([
    {
      args: { tabId: "t1" },
      channel: BROWSER_CHANNEL,
      id: expect.any(String),
      projectId: "p1",
      tool: "browser_snapshot",
      type: "call",
    },
  ]);
  relay.receive(
    { id: b.sent[0].id, result: { content: [] }, type: "result" },
    b.send,
    b,
  );
  await expect(call).resolves.toEqual({ content: [] });

  // p2 is only open in a; a later announcement from b changes nothing.
  relay.receive({ projectIds: ["p1"], type: "projects" }, b.send, b);
  const second = relay.call("p2", "browser_list_tabs", {});
  relay.receive(
    { id: a.sent[0].id, message: "no tab", type: "error" },
    a.send,
    a,
  );
  await expect(second).rejects.toThrow("no tab");
});

test("with no window that has the project, the browser is unavailable", async () => {
  const relay = createBrowserRelay();
  const a = window();
  relay.resume(a.send, { projectIds: ["p1"] }, a);

  expect(relay.has("p1")).toBe(true);
  expect(relay.has("p2")).toBe(false);
  await expect(relay.call("p2", "browser_list_tabs", {})).rejects.toThrow(
    BrowserUnavailableError,
  );

  // A window that closes the project, or resumes saying nothing, is out.
  relay.receive({ projectIds: [], type: "projects" }, a.send, a);
  expect(relay.has("p1")).toBe(false);
  relay.resume(a.send, { projectIds: ["p1"] }, a);
  relay.resume(a.send, null, a);
  expect(relay.has("p1")).toBe(false);
});

test("a window that goes away fails its calls; a silent one times out", async () => {
  const relay = createBrowserRelay({ timeoutMs: 20 });
  const a = window();
  relay.resume(a.send, { projectIds: ["p1"] }, a);

  const pending = relay.call("p1", "browser_navigate", { url: "x" });
  relay.close(a);
  await expect(pending).rejects.toThrow("went away");
  expect(relay.has("p1")).toBe(false);

  relay.resume(a.send, { projectIds: ["p1"] }, a);
  await expect(relay.call("p1", "browser_reload", {})).rejects.toThrow(
    "did not answer in time",
  );
});

test("the host socket carries browser calls to the client that announced the project", async () => {
  const socket = createHostSocket();
  const received = [];
  const client = socket.connect({
    send: (text) => received.push(JSON.parse(text)),
  });
  client.receive(
    JSON.stringify({
      channel: "host",
      cursors: { browser: { projectIds: ["p1"] } },
      type: "resume",
    }),
  );

  const call = socket.browser.call("p1", "browser_list_tabs", {});
  const sent = received.find((message) => message.channel === "browser");
  expect(sent).toMatchObject({ projectId: "p1", type: "call" });
  client.receive(
    JSON.stringify({
      channel: "browser",
      id: sent.id,
      result: { content: [{ text: "tabs", type: "text" }] },
      type: "result",
    }),
  );
  await expect(call).resolves.toEqual({
    content: [{ text: "tabs", type: "text" }],
  });

  client.close();
  expect(socket.browser.has("p1")).toBe(false);
});
