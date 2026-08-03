import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createModelOption,
  dedupeModelOptions,
  getModelReasoningEfforts,
  getModelSpeedTiers,
  isVisibleOpenAiModelOption,
  normalizeClaudeCodeModel,
  normalizeModelSpeed,
  normalizeModelSpeedTiers,
  normalizeReasoningEfforts,
  selectLowCostAnthropicModel,
  selectLowCostOpenAiModel,
  sortCursorModelOptions,
} from "./model-options.js";

test("returns reasoning efforts only for reasoning-capable OpenAI models", () => {
  assert.deepEqual(getModelReasoningEfforts("openai", "gpt-5.4-codex"), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(getModelReasoningEfforts("openai", " O3-Mini "), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(getModelReasoningEfforts("openai", "gpt-4o"), []);
  assert.deepEqual(getModelReasoningEfforts("openai", ""), []);
});

test("detects reasoning support across Anthropic model id formats", () => {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  assert.deepEqual(getModelReasoningEfforts("anthropic", "opus"), efforts);
  assert.deepEqual(
    getModelReasoningEfforts("anthropic", "claude-sonnet-4-5"),
    efforts,
  );
  assert.deepEqual(
    getModelReasoningEfforts("anthropic", "claude-3-7-sonnet"),
    efforts,
  );
  assert.deepEqual(
    getModelReasoningEfforts("anthropic", "claude-3-5-sonnet"),
    [],
  );
});

test("limits Grok reasoning efforts to grok models without composer", () => {
  assert.deepEqual(getModelReasoningEfforts("grok", "grok-4"), [
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(getModelReasoningEfforts("grok", "grok-composer"), []);
  assert.deepEqual(getModelReasoningEfforts("grok", "composer-1"), []);
  assert.deepEqual(getModelReasoningEfforts("cursor", "grok-4"), []);
});

test("offers speed tiers only for OpenAI gpt-5.4 and gpt-5.5 families", () => {
  assert.deepEqual(getModelSpeedTiers("openai", "gpt-5.4"), [
    "standard",
    "fast",
  ]);
  assert.deepEqual(getModelSpeedTiers("openai", "gpt-5.5-codex"), [
    "standard",
    "fast",
  ]);
  assert.deepEqual(getModelSpeedTiers("openai", "gpt-5.3"), []);
  assert.deepEqual(getModelSpeedTiers("anthropic", "gpt-5.4"), []);
});

test("normalizes reasoning efforts from strings and objects while deduping", () => {
  assert.deepEqual(
    normalizeReasoningEfforts([
      "low",
      { effort: "high" },
      { value: "medium" },
      { id: "max" },
      "bogus",
      "low",
      42,
    ]),
    ["low", "high", "medium", "max"],
  );
  assert.deepEqual(normalizeReasoningEfforts("low"), []);
});

test("normalizes model speed and speed tiers with standard fallback", () => {
  assert.equal(normalizeModelSpeed("fast"), "fast");
  assert.equal(normalizeModelSpeed("turbo"), "standard");
  assert.equal(normalizeModelSpeed(undefined), "standard");
  assert.deepEqual(normalizeModelSpeedTiers(["fast", "fast", "standard"]), [
    "standard",
    "fast",
  ]);
  assert.deepEqual(normalizeModelSpeedTiers([{ tier: "fast" }]), [
    "standard",
    "fast",
  ]);
  assert.deepEqual(normalizeModelSpeedTiers(["standard"]), []);
  assert.deepEqual(normalizeModelSpeedTiers("fast"), []);
});

test("creates a model option with formatted label and normalized fields", () => {
  assert.deepEqual(
    createModelOption(
      "openai",
      " gpt-5.4-mini ",
      "",
      ["low", "low", "bogus"],
      ["fast"],
      272000.9,
    ),
    {
      contextWindow: 272000,
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      reasoningEfforts: ["low"],
      speedTiers: ["standard", "fast"],
    },
  );
  assert.deepEqual(createModelOption("anthropic", "opus", "opus"), {
    id: "opus",
    label: "Claude Opus",
  });
});

test("dedupes model options by id while merging labels, efforts, and context windows", () => {
  assert.deepEqual(
    dedupeModelOptions([
      { id: "gpt-5.4", label: "", reasoningEfforts: ["low"] },
      {
        contextWindow: 400000,
        id: "gpt-5.4",
        label: "Custom",
        reasoningEfforts: ["high"],
      },
      { id: "", label: "skipped" },
    ]),
    [
      {
        contextWindow: 400000,
        id: "gpt-5.4",
        label: "GPT-5.4",
        reasoningEfforts: ["low", "high"],
      },
    ],
  );
});

test("sorts Cursor models with auto first, composer second, then original order", () => {
  const sorted = sortCursorModelOptions([
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "composer", label: "Composer" },
    { id: "auto", label: "Cursor Auto" },
    { id: "sonnet", label: "Sonnet" },
  ]);
  assert.deepEqual(
    sorted.map((model) => model.id),
    ["auto", "composer", "gpt-5.4", "sonnet"],
  );
});

test("selects the cheapest OpenAI model by candidate priority preserving casing", () => {
  assert.equal(
    selectLowCostOpenAiModel([{ id: "GPT-5.4-Mini" }, { id: "gpt-5.4-nano" }]),
    "gpt-5.4-nano",
  );
  assert.equal(
    selectLowCostOpenAiModel([{ id: "GPT-5.4-Mini" }]),
    "GPT-5.4-Mini",
  );
  assert.equal(selectLowCostOpenAiModel([{ id: "gpt-4o" }]), "");
});

test("selects a low cost Anthropic model with haiku word fallback", () => {
  assert.equal(selectLowCostAnthropicModel([{ id: "haiku" }]), "haiku");
  assert.equal(
    selectLowCostAnthropicModel([{ id: "claude-haiku-4-5" }]),
    "claude-haiku-4-5",
  );
  assert.equal(selectLowCostAnthropicModel([{ id: "claude-opus-4" }]), "");
});

test("normalizes Claude Code model ids to family aliases", () => {
  assert.equal(normalizeClaudeCodeModel(""), "sonnet");
  assert.equal(normalizeClaudeCodeModel("claude-opus-4-6"), "opus");
  assert.equal(normalizeClaudeCodeModel("claude-opus-4-6[1m]"), "opus[1m]");
  assert.equal(normalizeClaudeCodeModel("Claude-Sonnet-4-5"), "sonnet");
  assert.equal(normalizeClaudeCodeModel("claude-haiku-4-5"), "haiku");
  assert.equal(
    normalizeClaudeCodeModel("claude-brainstorm-1"),
    "claude-brainstorm-1",
  );
  assert.equal(normalizeClaudeCodeModel("custom"), "custom");
});

test("hides the codex auto review model option by id or label", () => {
  assert.equal(
    isVisibleOpenAiModelOption({ id: "codex-auto-review", label: "Anything" }),
    false,
  );
  assert.equal(
    isVisibleOpenAiModelOption({ id: "gpt-5.4", label: " Codex Auto Review " }),
    false,
  );
  assert.equal(
    isVisibleOpenAiModelOption({ id: "gpt-5.4", label: "GPT-5.4" }),
    true,
  );
  assert.equal(isVisibleOpenAiModelOption({}), true);
  assert.equal(isVisibleOpenAiModelOption(null), true);
});
