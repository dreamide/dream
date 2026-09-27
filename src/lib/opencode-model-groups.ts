import type { ModelOption } from "./models";

export interface OpenCodeModelGroup {
  /** The provider part of the model ids, e.g. `opencode-go`. */
  id: string;
  label: string;
  models: ModelOption[];
}

/** The tab Settings opens on when OpenCode offers it. */
export const DEFAULT_OPENCODE_MODEL_GROUP = "opencode-go";

// OpenCode's own providers lead, in this order; the rest follow by name.
const LEADING_GROUPS = [DEFAULT_OPENCODE_MODEL_GROUP, "opencode"];

const GROUP_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  xai: "xAI",
};

const OTHER_GROUP = "other";

const getGroupId = (modelId: string) => {
  const separator = modelId.indexOf("/");
  return separator > 0 ? modelId.slice(0, separator) : OTHER_GROUP;
};

const formatGroupLabel = (groupId: string) =>
  GROUP_LABELS[groupId] ??
  groupId
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

/**
 * The model name without its provider, which the tab already shows:
 * `Opencode GO / glm-5` -> `glm-5`.
 */
export const getOpenCodeModelName = (model: ModelOption) => {
  const separator = model.label.indexOf(" / ");
  return separator >= 0 ? model.label.slice(separator + 3) : model.label;
};

/** Splits OpenCode's `provider/model` ids into one group per provider. */
export const groupOpenCodeModels = (
  models: ModelOption[],
): OpenCodeModelGroup[] => {
  const groups = new Map<string, OpenCodeModelGroup>();
  for (const model of models) {
    const id = getGroupId(model.id);
    const group = groups.get(id) ?? {
      id,
      label: id === OTHER_GROUP ? "Other" : formatGroupLabel(id),
      models: [],
    };
    group.models.push(model);
    groups.set(id, group);
  }

  const rank = (group: OpenCodeModelGroup) => {
    const leading = LEADING_GROUPS.indexOf(group.id);
    if (leading >= 0) return leading;
    return group.id === OTHER_GROUP ? Number.MAX_SAFE_INTEGER : 100;
  };

  return Array.from(groups.values()).sort(
    (left, right) =>
      rank(left) - rank(right) || left.label.localeCompare(right.label),
  );
};
