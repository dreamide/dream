import { describe, expect, it } from "vitest";
import type { ModelOption } from "./models";
import {
  getOpenCodeModelName,
  groupOpenCodeModels,
} from "./opencode-model-groups";

const model = (id: string, label: string): ModelOption => ({ id, label });

describe("groupOpenCodeModels", () => {
  it("puts OpenCode Go first, then OpenCode, then the rest by name", () => {
    const groups = groupOpenCodeModels([
      model("openai/gpt-5.5", "Openai / gpt-5.5"),
      model("opencode/claude-opus-5", "Opencode / claude-opus-5"),
      model("google/gemini-3.8-flash", "Google / gemini-3.8-flash"),
      model("opencode-go/glm-5", "Opencode GO / glm-5"),
      model("opencode-go/kimi-k3", "Opencode GO / kimi-k3"),
    ]);

    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ["opencode-go", "OpenCode Go"],
      ["opencode", "OpenCode"],
      ["google", "Google"],
      ["openai", "OpenAI"],
    ]);
    expect(groups[0].models.map((entry) => entry.id)).toEqual([
      "opencode-go/glm-5",
      "opencode-go/kimi-k3",
    ]);
  });

  it("names unknown providers from their id and collects ids with no provider last", () => {
    const groups = groupOpenCodeModels([
      model("local-llama", "local-llama"),
      model("my_provider/model-a", "My Provider / model-a"),
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "My Provider",
      "Other",
    ]);
  });

  it("returns no groups for no models", () => {
    expect(groupOpenCodeModels([])).toEqual([]);
  });
});

describe("getOpenCodeModelName", () => {
  it("drops the provider prefix the tab already shows", () => {
    expect(
      getOpenCodeModelName(model("opencode-go/glm-5", "Opencode GO / glm-5")),
    ).toBe("glm-5");
    expect(getOpenCodeModelName(model("local-llama", "local-llama"))).toBe(
      "local-llama",
    );
  });
});
