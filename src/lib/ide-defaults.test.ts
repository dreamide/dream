import assert from "node:assert/strict";
import { test } from "vitest";
import {
  DEFAULT_SETTINGS,
  getModelsForProvider,
  getPreferredDefaultModel,
  getProviderForModel,
  normalizeClaudeCodeModelId,
  normalizeDefaultModelSettings,
  resolveModelSpeedForModel,
  resolveReasoningEffortForModel,
} from "@/lib/ide-defaults";
import type { AppSettings } from "@/types/ide";

const createSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});

test("normalizeClaudeCodeModelId maps aliases onto claude code model ids", () => {
  assert.equal(normalizeClaudeCodeModelId("Opus"), "opus");
  assert.equal(normalizeClaudeCodeModelId("opus[1M]"), "opus[1m]");
  assert.equal(normalizeClaudeCodeModelId("Sonnet[1m]"), "sonnet[1m]");
  assert.equal(normalizeClaudeCodeModelId("HAIKU"), "haiku");
  assert.equal(normalizeClaudeCodeModelId("claude-fable-5"), "claude-fable-5");
  assert.equal(normalizeClaudeCodeModelId("gpt-5"), "gpt-5");
  assert.equal(normalizeClaudeCodeModelId("   "), "");
});

test("getModelsForProvider trims, dedupes, and drops empty entries", () => {
  const settings = createSettings({
    openAiSelectedModels: [" gpt-5 ", "gpt-5", "", "gpt-4o"],
  });

  assert.deepEqual(getModelsForProvider("openai", settings), [
    "gpt-5",
    "gpt-4o",
  ]);
  assert.deepEqual(getModelsForProvider("cursor", settings), []);
});

test("getModelsForProvider normalizes anthropic model ids", () => {
  const settings = createSettings({
    anthropicSelectedModels: ["Opus", "opus", "Sonnet[1m]", "claude-fable-5"],
  });

  assert.deepEqual(getModelsForProvider("anthropic", settings), [
    "opus",
    "sonnet[1m]",
    "claude-fable-5",
  ]);
});

test("getProviderForModel finds the connected provider owning the model", () => {
  const settings = createSettings({
    anthropicSelectedModels: ["opus"],
    openAiSelectedModels: ["gpt-5"],
  });

  assert.equal(getProviderForModel("gpt-5", settings), "openai");
  assert.equal(getProviderForModel("Opus", settings), "anthropic");
  assert.equal(getProviderForModel("grok-4", settings), null);
  assert.equal(getProviderForModel("   ", settings), null);
});

test("getPreferredDefaultModel keeps a valid default and falls back otherwise", () => {
  const settings = createSettings({
    anthropicSelectedModels: ["sonnet"],
    defaultModel: "sonnet",
    openAiSelectedModels: ["gpt-5"],
  });

  assert.equal(getPreferredDefaultModel(settings), "sonnet");
  assert.equal(
    getPreferredDefaultModel(
      createSettings({
        defaultModel: "deleted-model",
        openAiSelectedModels: ["gpt-5"],
      }),
    ),
    "gpt-5",
  );
  assert.equal(getPreferredDefaultModel(createSettings()), "");
});

test("getPreferredDefaultModel resolves claude aliases for the anthropic list", () => {
  const settings = createSettings({
    anthropicSelectedModels: ["opus"],
    defaultModel: "Claude Opus".replace(" ", "-"),
  });

  // "Claude-Opus" normalizes to "opus", which is connected.
  assert.equal(getPreferredDefaultModel(settings), "opus");
});

test("resolveModelSpeedForModel only honors speeds the model supports", () => {
  assert.equal(resolveModelSpeedForModel("fast", ["standard", "fast"]), "fast");
  assert.equal(resolveModelSpeedForModel("fast", []), "standard");
  assert.equal(
    resolveModelSpeedForModel("warp", ["standard", "fast"]),
    "standard",
  );
});

test("resolveReasoningEffortForModel picks supported efforts and hides medium", () => {
  const efforts = ["low", "medium", "high"] as const;

  assert.equal(resolveReasoningEffortForModel("high", [...efforts]), "high");
  // medium is the implicit default and is represented as null
  assert.equal(resolveReasoningEffortForModel("medium", [...efforts]), null);
  assert.equal(resolveReasoningEffortForModel("bogus", [...efforts]), null);
  assert.equal(resolveReasoningEffortForModel("bogus", ["low", "high"]), "low");
  assert.equal(resolveReasoningEffortForModel("high", []), null);
});

test("normalizeDefaultModelSettings repairs stale defaults", () => {
  const normalized = normalizeDefaultModelSettings(
    createSettings({
      defaultGitGenerationModel: "gone-model",
      defaultModel: "removed-model",
      defaultModelSpeed: "warp" as unknown as AppSettings["defaultModelSpeed"],
      defaultReasoningEffort:
        "nope" as unknown as AppSettings["defaultReasoningEffort"],
      openAiSelectedModels: ["gpt-5"],
    }),
  );

  assert.equal(normalized.defaultModel, "gpt-5");
  assert.equal(normalized.defaultGitGenerationModel, "gpt-5");
  assert.equal(normalized.defaultModelSpeed, "standard");
  assert.equal(normalized.defaultReasoningEffort, null);
});

test("normalizeDefaultModelSettings keeps valid selections intact", () => {
  const normalized = normalizeDefaultModelSettings(
    createSettings({
      anthropicSelectedModels: ["opus"],
      defaultGitGenerationModel: "gpt-5",
      defaultModel: "opus",
      defaultModelSpeed: "fast",
      defaultReasoningEffort: "high",
      openAiSelectedModels: ["gpt-5"],
    }),
  );

  assert.equal(normalized.defaultModel, "opus");
  assert.equal(normalized.defaultGitGenerationModel, "gpt-5");
  assert.equal(normalized.defaultModelSpeed, "fast");
  assert.equal(normalized.defaultReasoningEffort, "high");
});
