import { getCliVersion, isCliCommandAvailable } from "../shared/cli.js";
import { readCodexAccessToken, readCodexModelsCache } from "./codex-auth.js";
import {
  createModelOption,
  dedupeModelOptions,
  fetchClaudeCodeModelOptionsFromModelsDev,
  getModelReasoningEfforts,
  getModelSpeedTiers,
  isVisibleOpenAiModelOption,
  normalizeModelSpeedTiers,
  normalizeReasoningEfforts,
  selectLowCostAnthropicModel,
  selectLowCostOpenAiModel,
} from "./model-options.js";

const OPENAI_CODEX_CHATGPT_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models";
const CODEX_CLIENT_VERSION = "1.0.0";

const dedupeAndSort = (models) => {
  return dedupeModelOptions(models)
    .sort((a, b) => a.id.localeCompare(b.id))
    .reverse();
};

const createOpenAiModelOptionsFromCodexEntries = (entries) =>
  (entries ?? []).flatMap((entry) => {
    const rawId = entry?.slug ?? entry?.id;
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!id) return [];
    const reasoningEfforts = normalizeReasoningEfforts(
      entry.supported_reasoning_levels ?? entry.reasoningEfforts,
    );
    const speedTiers = normalizeModelSpeedTiers(
      entry.additional_speed_tiers ?? entry.speedTiers,
    );
    const model = createModelOption(
      "openai",
      id,
      entry.display_name ?? entry.label,
      reasoningEfforts.length > 0
        ? reasoningEfforts
        : getModelReasoningEfforts("openai", id),
      speedTiers.length > 0 ? speedTiers : getModelSpeedTiers("openai", id),
    );
    return isVisibleOpenAiModelOption(model) ? [model] : [];
  });

const fetchOpenAiModelsWithCodexChatgpt = async (accessToken) => {
  const cachedModels = await readCodexModelsCache();
  const cachedModelsById = new Map(
    cachedModels
      .map((entry) => [
        typeof entry?.slug === "string" ? entry.slug.trim() : "",
        entry,
      ])
      .filter(([id]) => id),
  );
  const url = new URL(OPENAI_CODEX_CHATGPT_MODELS_URL);
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`Codex model request failed (${response.status}).`);
  }
  const payload = await response.json();
  const modelIds = (payload.models ?? []).flatMap((entry) => {
    const id = entry.slug?.trim() ?? "";
    const cachedEntry = cachedModelsById.get(id);
    return createOpenAiModelOptionsFromCodexEntries([
      {
        ...entry,
        display_name: entry.display_name ?? cachedEntry?.display_name,
        supported_reasoning_levels:
          normalizeReasoningEfforts(entry.supported_reasoning_levels).length > 0
            ? entry.supported_reasoning_levels
            : cachedEntry?.supported_reasoning_levels,
        additional_speed_tiers:
          normalizeModelSpeedTiers(entry.additional_speed_tiers).length > 0
            ? entry.additional_speed_tiers
            : cachedEntry?.additional_speed_tiers,
      },
    ]);
  });
  return dedupeAndSort(modelIds);
};

export const fetchOpenAiModels = async ({ force = false } = {}) => {
  const installed = await isCliCommandAvailable("codex");
  if (!installed) {
    return {
      error: "Codex CLI is not installed or not available on PATH.",
      installed: false,
      models: [],
      source: "unavailable",
      version: null,
    };
  }
  const version = await getCliVersion("codex", { force });

  const accessToken = await readCodexAccessToken();
  if (!accessToken) {
    return {
      error: "Run `codex login` to fetch Codex models.",
      installed: true,
      models: [],
      source: "unavailable",
      version,
    };
  }

  try {
    const models = await fetchOpenAiModelsWithCodexChatgpt(accessToken);
    if (models.length === 0) {
      return {
        error: "Codex returned no models.",
        installed: true,
        models: [],
        source: "unavailable",
        version,
      };
    }

    return { installed: true, models, source: "cli", version };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Codex models.",
      installed: true,
      models: [],
      source: "unavailable",
      version,
    };
  }
};

export const fetchOpenAiLowCostModel = async () => {
  const accessToken = await readCodexAccessToken();
  if (accessToken) {
    try {
      const models = await fetchOpenAiModelsWithCodexChatgpt(accessToken);
      const model = selectLowCostOpenAiModel(models);
      if (model) {
        return model;
      }
    } catch {
      // Fall back to the local Codex model cache below.
    }
  }

  const cachedModels = createOpenAiModelOptionsFromCodexEntries(
    await readCodexModelsCache(),
  );
  return selectLowCostOpenAiModel(dedupeAndSort(cachedModels));
};

export const fetchAnthropicLowCostModel = async () =>
  selectLowCostAnthropicModel(await fetchClaudeCodeModelOptionsFromModelsDev());

export const fetchAnthropicModels = async ({ force = false } = {}) => {
  const installed = await isCliCommandAvailable("claude");
  if (!installed) {
    return {
      error: "Claude Code CLI is not installed or not available on PATH.",
      installed: false,
      models: [],
      source: "unavailable",
      version: null,
    };
  }
  const version = await getCliVersion("claude", { force });

  try {
    const models = await fetchClaudeCodeModelOptionsFromModelsDev();
    if (models.length === 0) {
      return {
        error: "Claude Code returned no supported models.",
        installed: true,
        models: [],
        source: "unavailable",
        version,
      };
    }

    return {
      installed: true,
      models,
      source: "cli",
      version,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Claude Code models.",
      installed: true,
      models: [],
      source: "unavailable",
      version,
    };
  }
};
