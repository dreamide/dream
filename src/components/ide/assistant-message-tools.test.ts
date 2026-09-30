import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import {
  getChipToolKind,
  getToolKind,
  isRedundantDirectWebToolSearchPart,
  parseMcpToolName,
} from "@/components/ide/assistant-message-tools";

type MessagePart = UIMessage["parts"][number];

const createToolPart = (
  type: string,
  overrides: Record<string, unknown> = {},
): MessagePart =>
  ({
    state: "output-available",
    toolCallId: "tool-call-1",
    type,
    ...overrides,
  }) as MessagePart;

test("a tool part is the kind the stream stamped on it", () => {
  const stamped = createToolPart("dynamic-tool", {
    toolMetadata: { kind: "write" },
    toolName: "runCommand",
  });
  assert.equal(getToolKind(stamped), "write");
  assert.equal(getChipToolKind(stamped), "write");
});

test("a part saved before kinds were stamped is classified by its name", () => {
  assert.equal(
    getToolKind(createToolPart("dynamic-tool", { toolName: "runCommand" })),
    "command",
  );
  // A stamp that is not a kind is ignored rather than trusted.
  assert.equal(
    getToolKind(
      createToolPart("tool-Read", { toolMetadata: { kind: "teleport" } }),
    ),
    "read",
  );
});

test("questions, plans and todos have kinds but render without a chip", () => {
  for (const [type, kind] of [
    ["tool-AskUserQuestion", "question"],
    ["tool-ExitPlanMode", "planMode"],
    ["tool-TodoWrite", "todo"],
    ["tool-TaskCreate", "taskCreate"],
  ] as const) {
    const part = createToolPart(type);
    assert.equal(getToolKind(part), kind, type);
    assert.equal(getChipToolKind(part), null, type);
  }
});

test("parseMcpToolName splits server and command from mcp tool names", () => {
  assert.deepEqual(parseMcpToolName("mcp__github__create_issue"), {
    command: "create_issue",
    server: "github",
  });
  assert.deepEqual(parseMcpToolName("mcp__a__b__c"), {
    command: "b__c",
    server: "a",
  });
  assert.equal(parseMcpToolName("web-search"), null);
  assert.equal(parseMcpToolName("mcp__incomplete"), null);
});

test("getChipToolKind classifies known tool aliases", () => {
  assert.equal(getChipToolKind(createToolPart("tool-Bash")), "command");
  assert.equal(getChipToolKind(createToolPart("tool-Read")), "read");
  assert.equal(getChipToolKind(createToolPart("tool-Grep")), "search");
  assert.equal(getChipToolKind(createToolPart("tool-Task")), "agent");
  assert.equal(getChipToolKind(createToolPart("tool-MultiEdit")), "write");
  assert.equal(getChipToolKind(createToolPart("tool-WebSearch")), "webFetch");
  assert.equal(getChipToolKind(createToolPart("tool-ListFiles")), "list");
  assert.equal(
    getChipToolKind(createToolPart("tool-ToolSearch")),
    "toolSearch",
  );
});

test("getChipToolKind recognizes mcp tools via dynamic-tool names", () => {
  assert.equal(
    getChipToolKind(
      createToolPart("dynamic-tool", { toolName: "mcp__linear__list_issues" }),
    ),
    "mcp",
  );
  assert.equal(getChipToolKind(createToolPart("tool-mcp__db__query")), "mcp");
});

test("getChipToolKind returns null for non-tool parts and unknown tools", () => {
  assert.equal(
    getChipToolKind({ text: "hello", type: "text" } as MessagePart),
    null,
  );
  assert.equal(getChipToolKind(createToolPart("tool-SomethingUnknown")), null);
});

test("flags tool searches that only query direct web tools as redundant", () => {
  assert.equal(
    isRedundantDirectWebToolSearchPart(
      createToolPart("tool-ToolSearch", { input: { query: "web_search" } }),
    ),
    true,
  );
  assert.equal(
    isRedundantDirectWebToolSearchPart(
      createToolPart("tool-ToolSearch", { input: "WebFetch" }),
    ),
    true,
  );
});

test("flags tool searches whose results reference only direct web tools", () => {
  assert.equal(
    isRedundantDirectWebToolSearchPart(
      createToolPart("tool-ToolSearch", {
        input: { query: "browsing" },
        output: { matches: [{ tool_name: "web_fetch" }, "WebSearch"] },
      }),
    ),
    true,
  );
  assert.equal(
    isRedundantDirectWebToolSearchPart(
      createToolPart("tool-ToolSearch", {
        input: { query: "browsing" },
        output: { matches: [{ tool_name: "web_fetch" }, { name: "database" }] },
      }),
    ),
    false,
  );
});

test("does not flag errored or non-tool-search parts as redundant", () => {
  assert.equal(
    isRedundantDirectWebToolSearchPart(
      createToolPart("tool-ToolSearch", {
        errorText: "search failed",
        input: { query: "web_search" },
      }),
    ),
    false,
  );
  assert.equal(
    isRedundantDirectWebToolSearchPart(
      createToolPart("tool-Bash", { input: { query: "web_search" } }),
    ),
    false,
  );
  assert.equal(
    isRedundantDirectWebToolSearchPart(
      createToolPart("tool-ToolSearch", { input: { query: "databases" } }),
    ),
    false,
  );
});
