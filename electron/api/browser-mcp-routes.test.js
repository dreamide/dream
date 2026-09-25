import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { afterEach, test } from "vitest";
import { setBrowserBridge, setBrowserMcpEndpoint } from "./browser-bridge.js";
import {
  BROWSER_MCP_PATH,
  registerBrowserMcpRoutes,
} from "./browser-mcp-routes.js";
import {
  beginBrowserTurn,
  resetBrowserTurnsForTests,
} from "./chat/active-browser-turns.js";
import { appendBrowserMcpServer } from "./chat/browser-tools.js";

const createFakeBridge = () => {
  const commands = [];
  return {
    commands,
    getConsoleEntries: () => [],
    getGuest: () => null,
    sendCommand: async (projectId, type, payload) => {
      commands.push({ payload, projectId, type });
      return {
        panelOpen: true,
        tabs: [
          {
            active: true,
            id: `${projectId}-tab`,
            title: "T",
            url: "http://x/",
          },
        ],
      };
    },
    waitForGuest: async () => {
      throw new Error("not mounted");
    },
    waitForLoad: async () => null,
  };
};

const connectClient = async (app, path) => {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://dream.local${path}`),
    { fetch: (input, init) => app.request(input, init) },
  );
  await client.connect(transport);
  return client;
};

afterEach(() => {
  setBrowserBridge(null);
  setBrowserMcpEndpoint(null);
  resetBrowserTurnsForTests();
});

test("serves the browser tools over Streamable HTTP, scoped by project", async () => {
  const bridge = createFakeBridge();
  setBrowserBridge(bridge);
  const app = new Hono();
  registerBrowserMcpRoutes(app);

  const client = await connectClient(app, `${BROWSER_MCP_PATH}/proj-1`);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("browser_open_tab"));
  assert.ok(names.includes("browser_snapshot"));
  const snapshot = tools.find((tool) => tool.name === "browser_snapshot");
  assert.equal(snapshot.annotations?.readOnlyHint, true);
  assert.equal(typeof snapshot.inputSchema?.properties?.tabId, "object");

  const result = await client.callTool({
    arguments: {},
    name: "browser_list_tabs",
  });
  assert.equal(result.isError, undefined);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.tabs[0].id, "proj-1-tab");
  assert.deepEqual(bridge.commands, [
    { payload: undefined, projectId: "proj-1", type: "list-tabs" },
  ]);
  await client.close();
});

test("shared endpoint resolves the project from the running Codex turn", async () => {
  const bridge = createFakeBridge();
  setBrowserBridge(bridge);
  const app = new Hono();
  registerBrowserMcpRoutes(app);
  const client = await connectClient(app, BROWSER_MCP_PATH);

  const noTurn = await client.callTool({
    arguments: {},
    name: "browser_list_tabs",
  });
  assert.equal(noTurn.isError, true);
  assert.match(noTurn.content[0].text, /No Dream project/);

  const end = beginBrowserTurn({ projectId: "codex-proj", provider: "openai" });
  const result = await client.callTool({
    arguments: {},
    name: "browser_list_tabs",
  });
  end();
  assert.equal(result.isError, undefined);
  assert.equal(bridge.commands.at(-1).projectId, "codex-proj");
  await client.close();
});

test("responds 503 when no bridge is registered", async () => {
  const app = new Hono();
  registerBrowserMcpRoutes(app);
  const response = await app.request(`${BROWSER_MCP_PATH}/p`, {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 503);
});

test("appendBrowserMcpServer adds the endpoint per scope and replaces name clashes", () => {
  const user = [
    { id: "u1", name: "github", transport: "stdio", command: "gh-mcp" },
  ];
  assert.deepEqual(appendBrowserMcpServer(user, { projectId: "p" }), user);

  setBrowserBridge(createFakeBridge());
  setBrowserMcpEndpoint({
    headers: { "x-dream-api-token": "tok" },
    url: "http://127.0.0.1:4000/api/mcp/browser",
  });

  const scoped = appendBrowserMcpServer(user, {
    projectId: "p 1",
    scope: "project",
  });
  assert.equal(scoped.length, 2);
  assert.equal(scoped[1].name, "dream-browser");
  assert.equal(scoped[1].transport, "http");
  assert.equal(scoped[1].url, "http://127.0.0.1:4000/api/mcp/browser/p%201");
  assert.deepEqual(scoped[1].headers, { "x-dream-api-token": "tok" });

  assert.equal(
    appendBrowserMcpServer(user, { projectId: "", scope: "project" }),
    user,
  );

  const shared = appendBrowserMcpServer(
    [
      ...user,
      { id: "x", name: "dream-browser", transport: "http", url: "http://evil" },
    ],
    { projectId: "", scope: "shared" },
  );
  assert.equal(shared.length, 2);
  assert.equal(shared[1].url, "http://127.0.0.1:4000/api/mcp/browser");
});
