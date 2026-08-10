import assert from "node:assert/strict";
import { test } from "vitest";
import {
  dedupeModelOptions,
  estimateTokenCount,
  formatModelIdLabel,
  getModelContextWindow,
  getModelReasoningEfforts,
  getModelSpeedTiers,
  type ModelOption,
  normalizeModelSpeed,
  normalizeModelSpeedTiers,
  sortCursorModelOptions,
} from "@/lib/models";

const createOption = (overrides: Partial<ModelOption> = {}): ModelOption => ({
  id: "gpt-5",
  label: "GPT-5",
  ...overrides,
});

test("getModelContextWindow matches known model families and falls back to 128k", () => {
  assert.equal(getModelContextWindow("sonnet"), 1_000_000);
  assert.equal(getModelContextWindow("opus[1m]"), 1_000_000);
  assert.equal(getModelContextWindow("haiku"), 200_000);
  assert.equal(getModelContextWindow("claude-fable-5"), 1_000_000);
  assert.equal(getModelContextWindow("claude-sonnet-4-6"), 1_000_000);
  assert.equal(getModelContextWindow("claude-3-5-sonnet"), 200_000);
  assert.equal(getModelContextWindow("gpt-5.4-codex"), 272_000);
  assert.equal(getModelContextWindow("gpt-5"), 200_000);
  assert.equal(getModelContextWindow("gpt-4o-mini"), 128_000);
  assert.equal(getModelContextWindow("  GPT-5  "), 200_000);
  assert.equal(getModelContextWindow("mystery-model"), 128_000);
});

test("getModelReasoningEfforts covers openai reasoning and non-reasoning models", () => {
  assert.deepEqual(getModelReasoningEfforts("openai", "gpt-5.4-codex"), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(getModelReasoningEfforts("openai", "o3-mini"), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(getModelReasoningEfforts("openai", "gpt-4o"), []);
  assert.deepEqual(getModelReasoningEfforts("openai", ""), []);
});

test("getModelReasoningEfforts recognizes anthropic and grok model formats", () => {
  const anthropicEfforts = ["low", "medium", "high", "xhigh", "max"];
  assert.deepEqual(
    getModelReasoningEfforts("anthropic", "sonnet"),
    anthropicEfforts,
  );
  assert.deepEqual(
    getModelReasoningEfforts("anthropic", "claude-fable-5"),
    anthropicEfforts,
  );
  assert.deepEqual(
    getModelReasoningEfforts("anthropic", "claude-3-7-sonnet"),
    anthropicEfforts,
  );
  assert.deepEqual(
    getModelReasoningEfforts("anthropic", "claude-3-5-sonnet"),
    [],
  );
  assert.deepEqual(getModelReasoningEfforts("grok", "grok-4"), [
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(getModelReasoningEfforts("grok", "grok-composer"), []);
});

test("getModelSpeedTiers only exposes fast tier for gpt-5.4/5.5 on openai", () => {
  assert.deepEqual(getModelSpeedTiers("openai", "gpt-5.4"), [
    "standard",
    "fast",
  ]);
  assert.deepEqual(getModelSpeedTiers("openai", "gpt-5.5-codex"), [
    "standard",
    "fast",
  ]);
  assert.deepEqual(getModelSpeedTiers("openai", "gpt-5"), []);
  assert.deepEqual(getModelSpeedTiers("anthropic", "gpt-5.4"), []);
});

test("formatModelIdLabel formats provider-specific model ids", () => {
  assert.equal(formatModelIdLabel("openai", "gpt-5.4-codex"), "GPT-5.4 Codex");
  assert.equal(formatModelIdLabel("openai", "gpt-4o"), "GPT-4o");
  assert.equal(formatModelIdLabel("openai", "o3-mini"), "o3 Mini");
  assert.equal(
    formatModelIdLabel("anthropic", "claude-fable-5"),
    "Claude Fable 5",
  );
  assert.equal(formatModelIdLabel("anthropic", "opus[1m]"), "Claude Opus 1M");
  assert.equal(formatModelIdLabel("anthropic", "sonnet"), "Claude Sonnet");
  assert.equal(formatModelIdLabel("amp", "smart"), "Smart");
  assert.equal(formatModelIdLabel("openai", "   "), "");
});

test("dedupeModelOptions merges duplicate ids and unions their capabilities", () => {
  const deduped = dedupeModelOptions([
    createOption({
      contextWindow: 200_000,
      reasoningEfforts: ["low"],
    }),
    createOption({
      contextWindow: 400_000,
      reasoningEfforts: ["high"],
      speedTiers: ["standard", "fast"],
    }),
    createOption({ id: "   ", label: "blank id is dropped" }),
  ]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, "gpt-5");
  assert.equal(deduped[0].contextWindow, 200_000);
  assert.deepEqual(deduped[0].reasoningEfforts, ["low", "high"]);
  assert.deepEqual(deduped[0].speedTiers, ["standard", "fast"]);
});

test("dedupeModelOptions derives a display label when the label echoes the id", () => {
  const deduped = dedupeModelOptions([
    createOption({ id: "claude-fable-5", label: "claude-fable-5" }),
  ]);

  assert.deepEqual(deduped, [
    { id: "claude-fable-5", label: "Claude Fable 5" },
  ]);
});

test("sortCursorModelOptions puts auto first, composer second, rest stable", () => {
  const sorted = sortCursorModelOptions([
    createOption({ id: "gpt-5", label: "GPT-5" }),
    createOption({ id: "cursor-composer", label: "Composer" }),
    createOption({ id: "sonnet", label: "Sonnet" }),
    createOption({ id: "auto", label: "Cursor Auto" }),
  ]);

  assert.deepEqual(
    sorted.map((model) => model.id),
    ["auto", "cursor-composer", "gpt-5", "sonnet"],
  );
});

test("estimateTokenCount uses four characters per token rounded up", () => {
  assert.equal(estimateTokenCount(""), 0);
  assert.equal(estimateTokenCount("abcd"), 1);
  assert.equal(estimateTokenCount("abcde"), 2);
  assert.equal(estimateTokenCount("a".repeat(400)), 100);
});

test("normalizeModelSpeed falls back to standard for unknown values", () => {
  assert.equal(normalizeModelSpeed("fast"), "fast");
  assert.equal(normalizeModelSpeed("standard"), "standard");
  assert.equal(normalizeModelSpeed("turbo"), "standard");
  assert.equal(normalizeModelSpeed(undefined), "standard");
});

test("normalizeModelSpeedTiers dedupes and only keeps tiers beyond standard", () => {
  assert.deepEqual(normalizeModelSpeedTiers(["fast"]), ["standard", "fast"]);
  assert.deepEqual(normalizeModelSpeedTiers(["fast", "fast", "standard"]), [
    "standard",
    "fast",
  ]);
  assert.deepEqual(normalizeModelSpeedTiers(["standard"]), []);
  assert.deepEqual(normalizeModelSpeedTiers(), []);
});
