import { describe, expect, it } from "vitest";
import { parseAntigravityModelsOutput } from "./provider-models.js";

describe("parseAntigravityModelsOutput", () => {
  it("parses tab-delimited model list correctly", () => {
    const output = [
      "gemini-3.8-flash-high\tGemini 3.8 Flash (high reasoning)",
      "gemini-3.8-flash-low\tGemini 3.8 Flash (low reasoning)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6",
      "gpt-oss-120b-medium\tGPT OSS 120B (medium reasoning)",
    ].join("\n");

    const models = parseAntigravityModelsOutput(output);
    expect(models).toHaveLength(4);

    expect(models[0].id).toBe("gemini-3.8-flash-high");
    expect(models[0].label).toBe("Gemini 3.8 Flash (high reasoning)");
    expect(models[0].contextWindow).toBe(1_000_000);
    expect(models[0].reasoningEfforts).toBeUndefined();

    expect(models[2].id).toBe("claude-sonnet-4-6");
    expect(models[2].label).toBe("Claude Sonnet 4.6");
    expect(models[2].contextWindow).toBeUndefined();
    expect(models[2].reasoningEfforts).toBeUndefined();
  });

  it("assigns reasoning efforts to generic models without fixed effort suffixes", () => {
    const output = "gemini-3.8-flash\tGemini 3.8 Flash\n";
    const models = parseAntigravityModelsOutput(output);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("gemini-3.8-flash");
    expect(models[0].reasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("handles models with space delimiter fallback", () => {
    const output = "custom-model Custom Model Label";
    const models = parseAntigravityModelsOutput(output);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("custom-model");
    expect(models[0].label).toBe("Custom Model Label");
  });

  it("ignores header lines and empty lines", () => {
    const output = "\nMODEL\tDESCRIPTION\n\ngemini-3.8-flash\tGemini Flash\n";
    const models = parseAntigravityModelsOutput(output);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("gemini-3.8-flash");
  });

  it("does not parse stderr warnings as models when given only stdout", () => {
    const stdout = "gemini-3.8-flash\tGemini Flash\n";
    const models = parseAntigravityModelsOutput(stdout);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("gemini-3.8-flash");
    expect(models.some((m) => m.id.startsWith("Warning"))).toBe(false);
  });
});
