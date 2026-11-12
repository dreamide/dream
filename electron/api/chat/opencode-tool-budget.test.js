import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getOpenCodeMcpToolKey,
  orderOpenCodeMcpServers,
  planOpenCodeToolBudget,
  resolveOpenCodeDisabledTools,
} from "./opencode-tool-budget.js";

const names = (prefix, count) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

test("tool keys follow OpenCode's sanitized server_tool naming", () => {
  assert.equal(
    getOpenCodeMcpToolKey("hackzero-mcp", "list.x"),
    "hackzero-mcp_list_x",
  );
  assert.equal(getOpenCodeMcpToolKey("my server", "get"), "my_server_get");
});

test("nothing is hidden when every tool fits", () => {
  const plan = planOpenCodeToolBudget({
    limit: 20,
    reservedCount: 10,
    servers: [
      { name: "a", tools: names("t", 5) },
      { name: "b", tools: null },
    ],
  });
  assert.deepEqual(plan, { disabled: [], hidden: [] });
});

test("lower-priority tools past the limit are hidden individually", () => {
  const plan = planOpenCodeToolBudget({
    limit: 10,
    reservedCount: 4,
    servers: [
      { name: "first", tools: names("t", 4) },
      { name: "second", tools: names("u", 5) },
      { name: "third", tools: names("v", 2) },
    ],
  });
  assert.deepEqual(plan.disabled, [
    "second_u2",
    "second_u3",
    "second_u4",
    "third_v0",
    "third_v1",
  ]);
  assert.deepEqual(plan.hidden, [
    { count: 3, server: "second" },
    { count: 2, server: "third" },
  ]);
});

test("unlisted servers are hidden whole once the budget is exhausted", () => {
  const plan = planOpenCodeToolBudget({
    limit: 5,
    reservedCount: 3,
    servers: [
      { name: "oauth server", tools: null },
      { name: "known", tools: names("t", 3) },
    ],
  });
  assert.deepEqual(plan.disabled, ["known_t2", "oauth_server_*"]);
  assert.deepEqual(plan.hidden, [
    { count: 1, server: "known" },
    { count: null, server: "oauth server" },
  ]);
});

test("built-ins alone over the limit hide every MCP tool", () => {
  const plan = planOpenCodeToolBudget({
    limit: 5,
    reservedCount: 8,
    servers: [{ name: "a", tools: ["x"] }],
  });
  assert.deepEqual(plan.disabled, ["a_x"]);
});

test("browser tools come first, then Dream's servers, then the rest", () => {
  assert.deepEqual(
    orderOpenCodeMcpServers(
      ["zeta", "umami", "dream-browser", "alpha", "hackzero-mcp"],
      ["hackzero-mcp", "umami", "missing", "dream-browser"],
    ),
    ["dream-browser", "hackzero-mcp", "umami", "alpha", "zeta"],
  );
});

const fakeClient = ({ status, mcp, ids }) => ({
  config: { get: async () => ({ data: { mcp } }) },
  mcp: { status: async () => ({ data: status }) },
  tool: { ids: async () => ({ data: ids }) },
});

test("resolve returns no overrides when no MCP server is connected", async () => {
  const tools = await resolveOpenCodeDisabledTools({
    client: fakeClient({
      ids: ["read"],
      mcp: { a: { type: "remote", url: "http://127.0.0.1:1/mcp" } },
      status: { a: { status: "failed", error: "down" } },
    }),
    directory: "/project",
  });
  assert.deepEqual(tools, {});
});

test("resolve hides unlistable servers when built-ins fill the budget", async () => {
  const tools = await resolveOpenCodeDisabledTools({
    client: fakeClient({
      ids: names("builtin", 10),
      // An entry without a command cannot be listed, so its size is unknown.
      mcp: { opaque: { type: "local", command: [] } },
      status: { opaque: { status: "connected" } },
    }),
    directory: "/project",
    limit: 12,
  });
  assert.deepEqual(tools, { "opaque_*": false });
});

test("resolve proceeds without overrides when OpenCode cannot be inspected", async () => {
  const tools = await resolveOpenCodeDisabledTools({
    client: {
      config: { get: async () => ({ data: {} }) },
      mcp: {
        status: async () => {
          throw new Error("server gone");
        },
      },
      tool: { ids: async () => ({ data: [] }) },
    },
    directory: "/project",
  });
  assert.deepEqual(tools, {});
});
