import assert from "node:assert/strict";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { test } from "vitest";
import {
  createProviderGraphExecutor,
  readAgentResponseText,
  resolveNodeAgent,
} from "./executor.js";

const streamResponse = (chunks) =>
  createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        for (const chunk of chunks) {
          writer.write(chunk);
        }
      },
    }),
  });

const textChunks = (id, text) => [
  { type: "start" },
  { type: "text-start", id },
  { delta: text, id, type: "text-delta" },
  { id, type: "text-end" },
  { type: "finish" },
];

test("resolveNodeAgent layers node settings over the run default", () => {
  const defaults = {
    model: "claude-sonnet",
    modelSpeed: "standard",
    provider: "anthropic",
    reasoningEffort: "medium",
  };
  assert.deepEqual(resolveNodeAgent({}, defaults), {
    agentMode: "build",
    model: "claude-sonnet",
    modelSpeed: "standard",
    provider: "anthropic",
    reasoningEffort: "medium",
  });
  assert.equal(
    resolveNodeAgent({ agentMode: "plan" }, defaults).agentMode,
    "plan",
  );
  // Switching provider without a model must not inherit the old model.
  const switched = resolveNodeAgent({ provider: "openai" }, defaults);
  assert.equal(switched.provider, "openai");
  assert.equal(switched.model, "");
  assert.equal(resolveNodeAgent({ provider: "bogus" }, {}).provider, null);
});

test("readAgentResponseText collects assistant text from a UI message stream", async () => {
  const response = streamResponse([
    ...textChunks("t1", "Working...\n"),
    ...textChunks(
      "t2",
      '<workflow-result>{"data":{"status":"ok"}}</workflow-result>',
    ),
  ]);
  const text = await readAgentResponseText(response);
  assert.match(text, /Working\.\.\./);
  assert.match(text, /"status":"ok"/);
});

test("readAgentResponseText surfaces stream errors and non-OK responses", async () => {
  await assert.rejects(
    readAgentResponseText(
      streamResponse([
        { type: "start" },
        { errorText: "provider exploded", type: "error" },
      ]),
    ),
    /provider exploded/,
  );
  await assert.rejects(
    readAgentResponseText(
      new Response("Claude CLI is not installed", { status: 400 }),
    ),
    /Claude CLI is not installed/,
  );
});

test("readAgentResponseText aborts when the signal fires", async () => {
  const controller = new AbortController();
  const response = createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: "start" });
        writer.write({ id: "t", type: "text-start" });
        writer.write({ delta: "partial", id: "t", type: "text-delta" });
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
        writer.write({ id: "t", type: "text-end" });
        writer.write({ type: "finish" });
      },
    }),
  });
  await assert.rejects(
    readAgentResponseText(response, { signal: controller.signal }),
    (error) => error.name === "AbortError",
  );
});

test("provider executor builds a single user message and returns text", async () => {
  const seen = [];
  const executor = createProviderGraphExecutor({
    dispatch: async ({ agent, messages, projectPath, signal }) => {
      seen.push({ agent, messages, projectPath, aborted: signal?.aborted });
      return streamResponse(textChunks("t", "done"));
    },
  });
  const result = await executor.execute({
    graph: { defaultAgent: { model: "gpt-5", provider: "openai" } },
    node: { agent: { agentMode: "plan" }, name: "Plan" },
    projectPath: "C:\\projects\\one",
    prompt: "Do the thing",
    signal: new AbortController().signal,
  });
  assert.equal(result.text, "done");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agent.provider, "openai");
  assert.equal(seen[0].agent.agentMode, "plan");
  assert.equal(seen[0].messages[0].role, "user");
  assert.equal(seen[0].messages[0].parts[0].text, "Do the thing");

  await assert.rejects(
    executor.execute({
      graph: { defaultAgent: {} },
      node: { agent: {}, name: "Nope" },
      projectPath: "C:\\projects\\one",
      prompt: "x",
    }),
    /no provider\/model configured/,
  );
});
