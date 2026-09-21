import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import { TASK_OUTPUT_MAX_CHARS } from "@/lib/task-defaults";
import { extractStepOutput } from "./task-output";

const message = (role: UIMessage["role"], parts: unknown[]): UIMessage =>
  ({ id: crypto.randomUUID(), parts, role }) as UIMessage;

test("uses the text of the last assistant message", () => {
  assert.equal(
    extractStepOutput([
      message("user", [{ text: "Do it", type: "text" }]),
      message("assistant", [{ text: "First answer", type: "text" }]),
      message("user", [{ text: "Revise", type: "text" }]),
      message("assistant", [
        { text: "thinking", type: "reasoning" },
        { text: "Part one", type: "text" },
        { text: "Part two", type: "text" },
      ]),
    ]),
    "Part one\n\nPart two",
  );
});

test("skips trailing assistant messages without text", () => {
  assert.equal(
    extractStepOutput([
      message("assistant", [{ text: "The answer", type: "text" }]),
      message("assistant", [{ text: "   ", type: "text" }]),
    ]),
    "The answer",
  );
  assert.equal(extractStepOutput([]), "");
});

test("prefers a plan submitted through ExitPlanMode", () => {
  assert.equal(
    extractStepOutput([
      message("assistant", [
        {
          input: { plan: "1. The real plan" },
          state: "input-available",
          toolCallId: "call-1",
          type: "tool-ExitPlanMode",
        },
        { text: "Here is my plan.", type: "text" },
      ]),
    ]),
    "1. The real plan",
  );
});

test("caps very long output", () => {
  const output = extractStepOutput([
    message("assistant", [
      { text: "x".repeat(TASK_OUTPUT_MAX_CHARS + 500), type: "text" },
    ]),
  ]);
  assert.ok(output.length < TASK_OUTPUT_MAX_CHARS + 50);
  assert.match(output, /\[truncated\]$/);
});
