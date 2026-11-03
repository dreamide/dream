import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import { createAgentTurn } from "./agent-turn.js";
import {
  createClaudeAgentAttachmentHook,
  createClaudePermissionHandler,
  keepClaudeAgentAttachedToTurn,
} from "./claude-stream.js";

const createTestTurn = () => {
  const parts = [];
  const turn = createAgentTurn({
    provider: "anthropic",
    writer: { merge: () => {}, write: (part) => parts.push(part) },
  });
  return { parts, turn };
};

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
  const { parts, turn } = createTestTurn();
  const handler = createClaudePermissionHandler(turn, {
    mode: "accept-edits",
    projectPath: process.cwd(),
  });

  // The MCP call waits for interactive approval; only check that the
  // approval request was emitted rather than an immediate deny.
  const controller = new AbortController();
  const pending = handler(
    "mcp__github__list_issues",
    {},
    { signal: controller.signal, toolUseID: "t1" },
  );
  const settled = await Promise.race([
    pending.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
  assert.equal(settled, "pending");
  assert.ok(
    parts.some(
      (part) =>
        part.type === "tool-approval-request" &&
        part.toolCallId === "t1" &&
        part.approvalId === "anthropic:t1",
    ),
  );
  controller.abort();
  await pending;
});

test("Skill tool invocations are allowed without an approval prompt", async () => {
  const { parts, turn } = createTestTurn();
  const handler = createClaudePermissionHandler(turn, {
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

test("attachment files are readable but not writable, and only this chat's", async () => {
  const projectPath = path.resolve("project");
  const attachments = path.resolve("state.attachments", "chat-1");
  const file = path.join(attachments, "abc", "report.xlsx");
  const { turn } = createTestTurn();
  const handler = createClaudePermissionHandler(turn, {
    mode: "accept-edits",
    projectPath,
    readableDirectories: [attachments],
  });
  const decide = async (toolName, input) =>
    (await handler(toolName, input, { toolUseID: "t1" })).behavior;

  assert.equal(await decide("Read", { file_path: file }), "allow");
  assert.equal(await decide("Grep", { path: attachments }), "allow");
  assert.equal(await decide("Write", { file_path: file }), "deny");
  assert.equal(await decide("Edit", { file_path: file }), "deny");

  // Another chat's files, and everything else outside the project.
  const otherChat = path.resolve("state.attachments", "chat-2", "x.xlsx");
  assert.equal(await decide("Read", { file_path: otherChat }), "deny");
  assert.equal(
    await decide("Read", { file_path: `${attachments}-extra/x.xlsx` }),
    "deny",
  );
  assert.equal(
    await decide("Read", {
      file_path: path.join(attachments, "..", "chat-2", "x.xlsx"),
    }),
    "deny",
  );
  // A relative path means the project, wherever it would land from the folder.
  assert.equal(
    await decide("Read", {
      file_path: `../${path.basename(attachments)}/abc/report.xlsx`,
    }),
    "deny",
  );
});

test("without attachments, reads outside the project stay denied", async () => {
  const { turn } = createTestTurn();
  const handler = createClaudePermissionHandler(turn, {
    mode: "accept-edits",
    projectPath: path.resolve("project"),
  });
  const result = await handler(
    "Read",
    { file_path: path.resolve("elsewhere", "x.txt") },
    { toolUseID: "t1" },
  );
  assert.equal(result.behavior, "deny");
});
