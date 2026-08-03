import assert from "node:assert/strict";
import { test } from "vitest";
import { keepClaudeAgentAttachedToTurn } from "./claude-stream.js";

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
