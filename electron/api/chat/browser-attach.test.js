import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  getProviderCapabilities,
  PROVIDER_IDS,
} from "../../shared/provider-capabilities.js";
import { setBrowserBridge, setBrowserMcpEndpoint } from "../browser-bridge.js";
import {
  attachBrowser,
  resetSharedBrowserTurnsForTests,
  resolveSharedBrowserProject,
} from "./browser-attach.js";

const ENDPOINT = "http://127.0.0.1:4000/api/mcp/browser";
const userServers = [
  { id: "u1", name: "github", transport: "stdio", command: "gh-mcp" },
];

const withBrowser = () => {
  setBrowserBridge({ sendCommand: async () => ({ tabs: [] }) });
  setBrowserMcpEndpoint({
    headers: { "x-dream-api-token": "tok" },
    url: ENDPOINT,
  });
};

afterEach(() => {
  setBrowserBridge(null);
  setBrowserMcpEndpoint(null);
  resetSharedBrowserTurnsForTests();
});

test("each Provider's capability names its mechanism", () => {
  assert.deepEqual(
    Object.fromEntries(
      PROVIDER_IDS.map((id) => [id, getProviderCapabilities(id).browserTools]),
    ),
    {
      anthropic: "in-process",
      antigravity: "none",
      cursor: "none",
      grok: "project-url",
      openai: "shared-url",
      opencode: "project-url",
    },
  );
});

test("in-process: the turn gets a server object and its MCP servers unchanged", () => {
  withBrowser();
  const browser = attachBrowser({
    mechanism: "in-process",
    mcpServers: userServers,
    projectId: "p1",
  });
  assert.ok(browser.inProcessServer);
  assert.equal(browser.mcpServers, userServers);
  assert.equal(resolveSharedBrowserProject(), null);
  browser.end();

  assert.equal(
    attachBrowser({ mechanism: "in-process", projectId: "" }).inProcessServer,
    null,
  );
  setBrowserBridge(null);
  assert.equal(
    attachBrowser({ mechanism: "in-process", projectId: "p1" }).inProcessServer,
    null,
  );
});

test("project-url: the endpoint with the project in its URL, no registration", () => {
  withBrowser();
  const browser = attachBrowser({
    mechanism: "project-url",
    mcpServers: userServers,
    projectId: "p 1",
  });
  assert.equal(browser.inProcessServer, null);
  assert.equal(browser.mcpServers.length, 2);
  assert.equal(browser.mcpServers[1].url, `${ENDPOINT}/p%201`);
  assert.deepEqual(browser.mcpServers[1].headers, {
    "x-dream-api-token": "tok",
  });
  assert.equal(resolveSharedBrowserProject(), null);

  // No project, no endpoint.
  assert.equal(
    attachBrowser({
      mechanism: "project-url",
      mcpServers: userServers,
      projectId: "",
    }).mcpServers,
    userServers,
  );
});

test("shared-url: one URL for every turn, registered until the turn ends", () => {
  withBrowser();
  const older = attachBrowser({
    mechanism: "shared-url",
    mcpServers: userServers,
    projectId: "a",
  });
  const newer = attachBrowser({
    mechanism: "shared-url",
    mcpServers: userServers,
    projectId: "b",
  });
  assert.equal(older.inProcessServer, null);
  assert.equal(older.mcpServers[1].url, ENDPOINT);
  assert.equal(newer.mcpServers[1].url, ENDPOINT);

  // Without a session to go by, the newest running turn.
  assert.equal(resolveSharedBrowserProject(), "b");
  newer.end();
  newer.end();
  assert.equal(resolveSharedBrowserProject(), "a");
  older.end();
  // A call racing the last turn's end still lands on its project.
  assert.equal(resolveSharedBrowserProject(), "a");
});

test("shared-url: a turn without a project is not registered", () => {
  withBrowser();
  const browser = attachBrowser({ mechanism: "shared-url", projectId: "" });
  assert.equal(browser.mcpServers.at(-1).url, ENDPOINT);
  assert.equal(resolveSharedBrowserProject(), null);
  browser.end();
});

test("shared-url: two concurrent turns in different projects each get their own calls by session", () => {
  withBrowser();
  const a = attachBrowser({ mechanism: "shared-url", projectId: "a" });
  const b = attachBrowser({ mechanism: "shared-url", projectId: "b" });
  a.session("thread-a");
  b.session("thread-b");

  assert.equal(resolveSharedBrowserProject({ sessionId: "thread-a" }), "a");
  assert.equal(resolveSharedBrowserProject({ sessionId: "thread-b" }), "b");
  // A call naming no reported session (an older Codex, a subagent's own
  // thread) takes the guess: the newest running turn, whichever made it.
  assert.equal(resolveSharedBrowserProject({ sessionId: "subagent" }), "b");
  assert.equal(resolveSharedBrowserProject(), "b");

  // A call racing its turn's end still finds it by session.
  a.end();
  assert.equal(resolveSharedBrowserProject({ sessionId: "thread-a" }), "a");
  assert.equal(resolveSharedBrowserProject({ sessionId: "other" }), "b");
  b.end();
});

test("none: nothing added and nothing registered", () => {
  withBrowser();
  const browser = attachBrowser({
    mechanism: "none",
    mcpServers: userServers,
    projectId: "p1",
  });
  assert.equal(browser.mcpServers, userServers);
  assert.equal(browser.inProcessServer, null);
  browser.session("s");
  browser.end();
  assert.equal(resolveSharedBrowserProject(), null);
});

test("a URL mechanism adds nothing without an endpoint and a browser", () => {
  setBrowserMcpEndpoint({ headers: {}, url: ENDPOINT });
  for (const mechanism of ["project-url", "shared-url"]) {
    assert.equal(
      attachBrowser({ mechanism, mcpServers: userServers, projectId: "p" })
        .mcpServers,
      userServers,
    );
  }
});
