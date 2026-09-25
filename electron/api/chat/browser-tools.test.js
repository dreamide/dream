import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildEvaluateScript,
  buildFileInputLookupExpression,
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

// ---------------------------------------------------------------------------
// Phase 3: hover, uploads, network, activity indicator
// ---------------------------------------------------------------------------

const createGuestStub = (overrides = {}) => ({
  canGoBack: () => false,
  canGoForward: () => false,
  events: [],
  executeJavaScript: async () => ({
    covered: false,
    element: { tag: "button", text: "Go" },
    inViewport: true,
    x: 10,
    y: 20,
  }),
  getTitle: () => "T",
  getURL: () => "http://localhost/",
  getZoomFactor: () => 2,
  isDestroyed: () => false,
  isLoading: () => false,
  sendInputEvent(event) {
    this.events.push(event);
  },
  ...overrides,
});

const createBridgeStub = (guest, extra = {}) => {
  const activity = [];
  return {
    activity,
    beginActivity: (projectId, tool) => {
      activity.push(`start:${projectId}:${tool}`);
      return () => activity.push(`end:${projectId}:${tool}`);
    },
    getConsoleEntries: () => [],
    getGuest: () => guest,
    getNetworkEntries: async () => ({
      capturing: true,
      entries: [],
      reason: null,
    }),
    sendCommand: async () => ({
      projectPath: process.cwd(),
      tabs: [{ active: true, id: "t1", title: "T", url: "http://localhost/" }],
    }),
    waitForGuest: async () => guest,
    waitForLoad: async () => null,
    ...extra,
  };
};

test("browser_hover sends a zoom-scaled mouseMove and reports activity", async () => {
  const guest = createGuestStub();
  const bridge = createBridgeStub(guest);
  const tools = createBrowserToolDefinitions({ bridge, projectId: "p1" });
  const result = await tools.browser_hover.handler({ ref: "e1" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(guest.events, [{ type: "mouseMove", x: 20, y: 40 }]);
  assert.deepEqual(bridge.activity, [
    "start:p1:browser_hover",
    "end:p1:browser_hover",
  ]);
});

test("activity is ended even when a tool fails", async () => {
  const bridge = createBridgeStub(null, {
    sendCommand: async () => {
      throw new Error("renderer gone");
    },
  });
  const tools = createBrowserToolDefinitions({ bridge, projectId: "p1" });
  const result = await tools.browser_list_tabs.handler({});
  assert.equal(result.isError, true);
  assert.deepEqual(bridge.activity, [
    "start:p1:browser_list_tabs",
    "end:p1:browser_list_tabs",
  ]);
});

test("browser_upload_file rejects paths outside the project and missing files", async () => {
  const guest = createGuestStub();
  const uploads = [];
  const bridge = createBridgeStub(guest, {
    setFileInputFiles: async (_guest, _expression, files) => {
      uploads.push(files);
    },
  });
  const tools = createBrowserToolDefinitions({ bridge, projectId: "p1" });

  const outside = await tools.browser_upload_file.handler({
    paths: ["../../outside.txt"],
    ref: "e1",
  });
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /outside the project root/);

  const missing = await tools.browser_upload_file.handler({
    paths: ["definitely-not-here.bin"],
    ref: "e1",
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /File not found/);

  const notInput = await tools.browser_upload_file.handler({
    paths: ["package.json"],
    ref: "e1",
  });
  assert.equal(notInput.isError, true);
  assert.match(notInput.content[0].text, /not an <input/);
  assert.equal(uploads.length, 0);

  const fileGuest = createGuestStub({
    executeJavaScript: async () => ({
      element: { tag: "input", text: "" },
      inViewport: true,
      x: 1,
      y: 1,
    }),
  });
  const okTools = createBrowserToolDefinitions({
    bridge: createBridgeStub(fileGuest, {
      setFileInputFiles: async (_guest, _expression, files) => {
        uploads.push(files);
      },
    }),
    projectId: "p1",
  });
  const ok = await okTools.browser_upload_file.handler({
    paths: ["package.json"],
    selector: "input[type=file]",
  });
  assert.equal(ok.isError, undefined);
  assert.equal(uploads.length, 1);
  assert.match(uploads[0][0], /package\.json$/);
});

test("browser_network_requests formats entries and flags unavailable capture", async () => {
  const guest = createGuestStub();
  const entries = [
    {
      durationMs: 12,
      encodedBytes: 512,
      id: "1",
      method: "GET",
      resourceType: "Document",
      status: 200,
      url: "http://localhost/",
    },
    {
      canceled: false,
      error: "net::ERR_CONNECTION_REFUSED",
      failed: true,
      id: "2",
      method: "POST",
      resourceType: "Fetch",
      status: null,
      url: "http://localhost/api/save",
    },
    {
      id: "3",
      method: "GET",
      resourceType: "XHR",
      status: 500,
      url: "http://localhost/api/list",
    },
  ];
  const bridge = createBridgeStub(guest, {
    getNetworkEntries: async () => ({
      capturing: false,
      entries,
      reason: "Another debugger is already attached",
    }),
  });
  const tools = createBrowserToolDefinitions({ bridge, projectId: "p1" });

  const all = await tools.browser_network_requests.handler({});
  const text = all.content[0].text;
  assert.match(text, /3 request\(s\)/);
  assert.match(text, /live capture is unavailable \(Another debugger/);
  assert.match(text, /\[1\] GET http:\/\/localhost\/ → 200 Document 12ms 512B/);
  assert.match(
    text,
    /\[2\] POST .* → FAILED net::ERR_CONNECTION_REFUSED Fetch/,
  );

  const failed = await tools.browser_network_requests.handler({
    failedOnly: true,
  });
  assert.match(failed.content[0].text, /2 request\(s\)/);
  assert.doesNotMatch(failed.content[0].text, /\[1\]/);

  const filtered = await tools.browser_network_requests.handler({
    urlIncludes: "/api/list",
  });
  assert.match(filtered.content[0].text, /1 request\(s\)/);
});

test("browser_network_response_body distinguishes text and binary bodies", async () => {
  const guest = createGuestStub();
  const bridge = createBridgeStub(guest, {
    getResponseBody: async (_guest, requestId) =>
      requestId === "img"
        ? {
            base64Encoded: true,
            body: "AAAA",
            entry: { mimeType: "image/png", url: "http://x/i.png" },
          }
        : {
            base64Encoded: false,
            body: "x".repeat(500),
            entry: {
              method: "GET",
              mimeType: "text/plain",
              status: 200,
              url: "http://x/t",
            },
          },
  });
  const tools = createBrowserToolDefinitions({ bridge, projectId: "p1" });

  const binary = await tools.browser_network_response_body.handler({
    requestId: "img",
  });
  assert.equal(JSON.parse(binary.content[0].text).binary, true);

  const text = await tools.browser_network_response_body.handler({
    maxChars: 200,
    requestId: "t",
  });
  assert.match(text.content[0].text, /GET http:\/\/x\/t → 200 text\/plain/);
  assert.match(text.content[0].text, /500 chars, truncated to 200/);
});

test("file input lookup expression is valid JavaScript", () => {
  for (const locator of [{ ref: "e9" }, { selector: "input[type=file]" }]) {
    assert.doesNotThrow(
      () =>
        new Function(`return (${buildFileInputLookupExpression(locator)});`),
    );
  }
});
