// Browser tools for an agent on an SSH host: its daemon's tool definitions
// forward each call through the host socket's relay, and the window runs it
// on its own browser through /api/browser-tools/call.
import { Hono } from "hono";
import { afterEach, expect, test } from "vitest";
import { setBrowserBridge, setBrowserToolRelay } from "./browser-bridge.js";
import { registerBrowserToolCallRoutes } from "./browser-tool-call-routes.js";
import {
  createAvailableBrowserToolDefinitions,
  createBrowserToolDefinitions,
  createRelayedBrowserToolDefinitions,
} from "./chat/browser-tools.js";

afterEach(() => {
  setBrowserBridge(null);
  setBrowserToolRelay(null);
});

const fakeRelay = (projectIds = ["p1"]) => {
  const calls = [];
  return {
    call: async (projectId, tool, args) => {
      calls.push({ args, projectId, tool });
      return { content: [{ text: `ran ${tool}`, type: "text" }] };
    },
    calls,
    has: (projectId) => projectIds.includes(projectId),
  };
};

test("relayed tools are the window's tools, less those that read host files", () => {
  const relayed = createRelayedBrowserToolDefinitions({
    projectId: "p1",
    relay: fakeRelay(),
  });
  const own = createBrowserToolDefinitions({ bridge: null, projectId: "p1" });

  expect(Object.keys(relayed)).toEqual(
    Object.keys(own).filter((name) => name !== "browser_upload_file"),
  );
  expect(relayed.browser_navigate.description).toBe(
    own.browser_navigate.description,
  );
});

test("a relayed call goes out with a complete URL and comes back as the window's result", async () => {
  const relay = fakeRelay();
  const tools = createRelayedBrowserToolDefinitions({
    projectId: () => "p1",
    relay,
  });

  const result = await tools.browser_navigate.handler({
    url: "localhost:3000",
  });

  expect(relay.calls).toEqual([
    {
      args: { url: "http://localhost:3000" },
      projectId: "p1",
      tool: "browser_navigate",
    },
  ]);
  expect(result).toEqual({
    content: [{ text: "ran browser_navigate", type: "text" }],
  });
});

test("a relayed call with no window answers that the browser is unavailable", async () => {
  const tools = createRelayedBrowserToolDefinitions({
    projectId: "p1",
    relay: {
      call: async () => {
        throw new Error("No Dream window has this project open.");
      },
      has: () => false,
    },
  });

  const result = await tools.browser_list_tabs.handler({});
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("No Dream window");
});

test("this process's own browser wins over the relay", () => {
  expect(createAvailableBrowserToolDefinitions({ projectId: "p1" })).toBe(null);

  setBrowserToolRelay(fakeRelay());
  expect(
    createAvailableBrowserToolDefinitions({ projectId: "p1" }),
  ).not.toHaveProperty("browser_upload_file");

  setBrowserBridge({ sendCommand: async () => ({ tabs: [] }) });
  expect(
    createAvailableBrowserToolDefinitions({ projectId: "p1" }),
  ).toHaveProperty("browser_upload_file");
});

const callRoute = (body) => {
  const app = new Hono();
  registerBrowserToolCallRoutes(app);
  return app.request("/api/browser-tools/call", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
};

test("the window runs a forwarded call on its own browser", async () => {
  const commands = [];
  setBrowserBridge({
    beginActivity: () => () => {},
    getGuest: () => null,
    sendCommand: async (projectId, type) => {
      commands.push({ projectId, type });
      return {
        tabs: [{ active: true, id: "t1", title: "App", url: "http://x/" }],
      };
    },
  });

  const response = await callRoute({
    args: {},
    projectId: "p1",
    tool: "browser_list_tabs",
  });

  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toContain("t1");
  expect(commands).toEqual([{ projectId: "p1", type: "list-tabs" }]);
});

test("a forwarded call to an unknown tool, with bad arguments, or without a browser is refused", async () => {
  expect(
    (await callRoute({ args: {}, projectId: "p1", tool: "browser_list_tabs" }))
      .status,
  ).toBe(503);

  setBrowserBridge({ sendCommand: async () => ({ tabs: [] }) });
  expect(
    (await callRoute({ args: {}, projectId: "p1", tool: "rm_rf" })).status,
  ).toBe(404);
  expect(
    (
      await callRoute({
        args: { url: 42 },
        projectId: "p1",
        tool: "browser_navigate",
      })
    ).status,
  ).toBe(400);
});
