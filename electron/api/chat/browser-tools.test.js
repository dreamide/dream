import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildEvaluateScript,
  buildFocusForTypingScript,
  buildLocateForPointerScript,
  buildProgrammaticClickScript,
  buildScrollScript,
  buildSelectOptionScript,
  buildSnapshotScript,
  buildWaitForScript,
} from "./browser-page-scripts.js";
import {
  BROWSER_MCP_SERVER_NAME,
  BROWSER_READ_ONLY_TOOL_IDS,
  createBrowserMcpServer,
  createBrowserToolDefinitions,
  normalizeAgentUrl,
  parseKeyCombo,
} from "./browser-tools.js";

test("normalizes agent-supplied URLs", () => {
  assert.equal(normalizeAgentUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(
    normalizeAgentUrl("127.0.0.1:8080/x"),
    "http://127.0.0.1:8080/x",
  );
  assert.equal(normalizeAgentUrl("example.com/a"), "https://example.com/a");
  assert.equal(normalizeAgentUrl("https://a.b"), "https://a.b");
  assert.equal(normalizeAgentUrl("about:blank"), "about:blank");
  assert.equal(normalizeAgentUrl("   "), null);
});

test("parses key combos into Electron accelerator parts", () => {
  assert.deepEqual(parseKeyCombo("Enter"), { key: "Return", modifiers: [] });
  assert.deepEqual(parseKeyCombo("Control+A"), {
    key: "A",
    modifiers: ["control"],
  });
  assert.deepEqual(parseKeyCombo("Shift+Tab"), {
    key: "Tab",
    modifiers: ["shift"],
  });
  assert.deepEqual(parseKeyCombo("ArrowDown"), { key: "Down", modifiers: [] });
  assert.deepEqual(parseKeyCombo("Q"), { key: "Q", modifiers: ["shift"] });
  assert.throws(() => parseKeyCombo("Hyper+X"), /Unknown modifier/);
  assert.throws(() => parseKeyCombo(""), /key is required/);
});

test("read-only tool ids are namespaced under the dream-browser server", () => {
  assert.equal(BROWSER_MCP_SERVER_NAME, "dream-browser");
  for (const id of BROWSER_READ_ONLY_TOOL_IDS) {
    assert.match(id, /^mcp__dream-browser__browser_/);
  }
  assert.ok(
    BROWSER_READ_ONLY_TOOL_IDS.includes("mcp__dream-browser__browser_snapshot"),
  );
  assert.ok(
    !BROWSER_READ_ONLY_TOOL_IDS.includes("mcp__dream-browser__browser_click"),
  );
});

test("every tool definition has a description, zod object schema and handler", () => {
  const tools = createBrowserToolDefinitions({ bridge: null, projectId: "p1" });
  const names = Object.keys(tools);
  assert.ok(names.length >= 15);
  for (const [name, def] of Object.entries(tools)) {
    assert.match(name, /^browser_[a-z_]+$/);
    assert.equal(typeof def.description, "string");
    assert.ok(
      def.description.length > 20,
      `${name} needs a useful description`,
    );
    assert.equal(typeof def.inputSchema?.shape, "object", `${name} schema`);
    assert.equal(typeof def.handler, "function", `${name} handler`);
  }
  // Read-only tools carry the MCP annotation used by clients for auto-allow.
  for (const id of BROWSER_READ_ONLY_TOOL_IDS) {
    const name = id.replace(`mcp__${BROWSER_MCP_SERVER_NAME}__`, "");
    assert.equal(tools[name]?.annotations?.readOnlyHint, true, name);
  }
});

test("handlers report a missing bridge as a tool error instead of throwing", async () => {
  const tools = createBrowserToolDefinitions({ bridge: null, projectId: "p1" });
  const result = await tools.browser_list_tabs.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not available/);
});

test("browser MCP server is omitted without a bridge or project", () => {
  assert.equal(createBrowserMcpServer({ projectId: "p1" }), null);
  assert.equal(createBrowserMcpServer({ projectId: "" }), null);
});

test("browser_open_tab drives the renderer then waits for the guest to load", async () => {
  const commands = [];
  const guest = {
    canGoBack: () => false,
    canGoForward: () => false,
    getTitle: () => "Home",
    getURL: () => "http://localhost:3000/",
    isDestroyed: () => false,
    isLoading: () => false,
  };
  const bridge = {
    getConsoleEntries: () => [],
    getGuest: () => null,
    sendCommand: async (projectId, type, payload) => {
      commands.push({ payload, projectId, type });
      return { reused: false, tabId: "tab-1" };
    },
    waitForGuest: async () => guest,
    waitForLoad: async () => null,
  };
  const tools = createBrowserToolDefinitions({ bridge, projectId: "p1" });
  const result = await tools.browser_open_tab.handler({
    url: "localhost:3000",
  });

  assert.deepEqual(commands, [
    {
      payload: { url: "http://localhost:3000" },
      projectId: "p1",
      type: "open-tab",
    },
  ]);
  assert.equal(result.isError, undefined);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.tabId, "tab-1");
  assert.equal(body.url, "http://localhost:3000/");
  assert.equal(body.title, "Home");
});

test("page scripts are syntactically valid JavaScript", () => {
  const scripts = [
    buildSnapshotScript(),
    buildSnapshotScript({ maxChars: 2000, selector: "#app" }),
    buildLocateForPointerScript({ ref: "e1" }),
    buildLocateForPointerScript({ selector: 'a[href="/x"]' }),
    buildProgrammaticClickScript({ ref: "e2" }),
    buildFocusForTypingScript({ selector: "input" }, { clear: true }),
    buildSelectOptionScript({ ref: "e3" }, ["a", "b"]),
    buildScrollScript({ deltaY: 400 }),
    buildScrollScript({ ref: "e4", deltaY: 0 }),
    buildWaitForScript({ selector: ".done", text: "ok", urlIncludes: "/x" }),
    buildEvaluateScript("document.title"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentionally exercises escaping of `${` in a user expression
    buildEvaluateScript("`back${'tick'}` + '\\n' + \"quotes\""),
  ];
  for (const script of scripts) {
    // Parsing only; the scripts reference browser globals at runtime.
    assert.doesNotThrow(
      () => new Function(`return (${script});`),
      script.slice(0, 80),
    );
  }
});
