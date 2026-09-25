import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createClaudeAgentAttachmentHook,
  keepClaudeAgentAttachedToTurn,
} from "./claude-stream.js";

test("keeps Claude Agent tool calls attached to the active turn", () => {
  assert.deepEqual(
    keepClaudeAgentAttachedToTurn("Agent", {
      description: "Survey the repository",
      prompt: "Inspect the content system",
      subagent_type: "Explore",
    }),
    {
      description: "Survey the repository",
      prompt: "Inspect the content system",
      run_in_background: false,
      subagent_type: "Explore",
    },
  );
});

test("overrides explicit background Agent and legacy Task tool calls", () => {
  assert.equal(
    keepClaudeAgentAttachedToTurn("Agent", { run_in_background: true })
      .run_in_background,
    false,
  );
  assert.equal(
    keepClaudeAgentAttachedToTurn("Task", { run_in_background: true })
      .run_in_background,
    false,
  );
});

test("leaves non-agent tool input unchanged", () => {
  const input = { command: "pnpm typecheck", run_in_background: true };
  assert.equal(keepClaudeAgentAttachedToTurn("Bash", input), input);
});

test("PreToolUse hook rewrites background Agent calls via updatedInput", async () => {
  const hook = createClaudeAgentAttachmentHook();
  const result = await hook({
    tool_name: "Agent",
    tool_input: { prompt: "Explore the repo", run_in_background: true },
  });
  assert.deepEqual(result, {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { prompt: "Explore the repo", run_in_background: false },
    },
  });
});

test("PreToolUse hook passes through foreground Agent calls untouched", async () => {
  const hook = createClaudeAgentAttachmentHook();
  const result = await hook({
    tool_name: "Agent",
    tool_input: { prompt: "Explore the repo", run_in_background: false },
  });
  assert.deepEqual(result, { continue: true });
});

test("accept-edits mode prompts for MCP tools instead of denying them", async () => {
  const { createClaudePermissionHandler } = await import("./claude-stream.js");
  const parts = [];
  const writer = { write: (part) => parts.push(part) };
  const handler = createClaudePermissionHandler(writer, {
    mode: "accept-edits",
    projectPath: process.cwd(),
  });

  const denied = await handler("Bash", { command: "ls" }, { toolUseID: "t1" });
  assert.equal(denied.behavior, "deny");

  // The MCP call waits for interactive approval; only check that the
  // approval request was emitted rather than an immediate deny.
  const pending = handler("mcp__github__list_issues", {}, { toolUseID: "t2" });
  const settled = await Promise.race([
    pending.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
  assert.equal(settled, "pending");
  assert.ok(
    parts.some(
      (part) =>
        part.type === "tool-approval-request" && part.toolCallId === "t2",
    ),
  );
});

test("Skill tool invocations are allowed without an approval prompt", async () => {
  const { createClaudePermissionHandler } = await import("./claude-stream.js");
  const parts = [];
  const writer = { write: (part) => parts.push(part) };
  const handler = createClaudePermissionHandler(writer, {
    mode: "ask",
    projectPath: process.cwd(),
  });

  const result = await handler(
    "Skill",
    { skill: "deploy" },
    { toolUseID: "skill-1" },
  );
  assert.equal(result.behavior, "allow");
  assert.equal(result.toolUseID, "skill-1");
  assert.deepEqual(result.updatedInput, { skill: "deploy" });
  assert.equal(parts.length, 0);
});
