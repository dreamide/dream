import {
  execCliCommand,
  getCliVersion,
  isCliCommandAvailable,
} from "../shared/cli.js";
import { readCodexAccessToken, readCodexModelsCache } from "./codex-auth.js";
import { fetchCursorAcpModels, toDreamCursorModelId } from "./cursor-acp.js";
import {
  getCursorCliUnavailableMessage,
  getCursorCliVersion,
  isCursorCliAvailable,
} from "./cursor-cli.js";
import {
  getGrokModelsFromInitializeResult,
  initializeGrokAcp,
  spawnGrokAcp,
} from "./grok-acp.js";
import {
  createModelOption,
  dedupeModelOptions,
  fetchClaudeCodeModelOptionsFromModelsDev,
  fetchOpenCodeContextWindowsFromModelsDev,
  getModelReasoningEfforts,
  getModelSpeedTiers,
  isVisibleOpenAiModelOption,
  normalizeModelSpeedTiers,
  normalizeReasoningEfforts,
  sortCursorModelOptions,
} from "./model-options.js";

const OPENAI_CODEX_CHATGPT_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models";
const CODEX_CLIENT_VERSION = "1.0.0";
const CURSOR_AUTO_MODEL = "auto";

const dedupeAndSort = (models) => {
  return dedupeModelOptions(models)
    .sort((a, b) => a.id.localeCompare(b.id))
    .reverse();
};

const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  "g",
);

const stripAnsi = (value) =>
  String(value ?? "").replace(ANSI_ESCAPE_PATTERN, "");

const formatOpenCodeModelLabel = (id) => {
  const [providerId, modelId] = id.split("/", 2);
  if (!providerId || !modelId) {
    return id;
  }

  const providerLabel = providerId
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) =>
      part.length <= 3
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
  return `${providerLabel} / ${modelId}`;
};

const parseOpenCodeModelsOutput = (value, contextWindows = new Map()) => {
  const clean = stripAnsi(value);
  const ids = new Set();
  const modelPattern =
    /(?:^|[\s│|])([a-zA-Z0-9][a-zA-Z0-9_.-]*\/[^\s│|,;"'`]+)/g;
  while (true) {
    const match = modelPattern.exec(clean);
    if (!match) {
      break;
    }

    const id = match[1]
      .replace(/[)\]}.,:;]+$/g, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();
    if (!id || id.includes("://")) {
      continue;
    }
    ids.add(id);
  }

  return Array.from(ids).map((id) =>
    createModelOption(
      "opencode",
      id,
      formatOpenCodeModelLabel(id),
      [],
      [],
      contextWindows.get(id),
    ),
  );
};

const createCursorDefaultModels = () => [
  createModelOption("cursor", CURSOR_AUTO_MODEL, "Cursor Auto"),
];

const getOpenAiModelContextWindow = (entry) => {
  for (const value of [
    entry?.context_window,
    entry?.contextWindow,
    entry?.limit?.context,
    entry?.max_context_window,
    entry?.maxContextWindow,
  ]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return undefined;
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
      getOpenAiModelContextWindow(entry),
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
        context_window: entry.context_window ?? cachedEntry?.context_window,
        contextWindow: entry.contextWindow ?? cachedEntry?.contextWindow,
        max_context_window:
          entry.max_context_window ?? cachedEntry?.max_context_window,
        maxContextWindow:
          entry.maxContextWindow ?? cachedEntry?.maxContextWindow,
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

export const fetchCursorModels = async ({ force = false } = {}) => {
  const installed = await isCursorCliAvailable({ force });
  if (!installed) {
    return {
      error: getCursorCliUnavailableMessage(),
      installed: false,
      models: [],
      source: "unavailable",
      version: null,
    };
  }
  const version = await getCursorCliVersion({ force });

  // Chats run over ACP, which only accepts the model ids it lists itself, so
  // the picker must offer those rather than the flat ids of `agent models`.
  try {
    const models = dedupeModelOptions(
      (await fetchCursorAcpModels()).flatMap((entry) => {
        const acpModelId =
          typeof entry?.modelId === "string" ? entry.modelId.trim() : "";
        if (!acpModelId) return [];
        const id = toDreamCursorModelId(acpModelId);
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        return [
          createModelOption(
            "cursor",
            id,
            id === CURSOR_AUTO_MODEL ? "Cursor Auto" : name || acpModelId,
          ),
        ];
      }),
    );
    if (models.length > 0) {
      return {
        installed: true,
        models: sortCursorModelOptions(models),
        source: "cli",
        version,
      };
    }
  } catch {
    // Not logged in, or an older Cursor without ACP model listing. Auto
    // still works, so offer it alone.
  }

  return {
    installed: true,
    models: sortCursorModelOptions(createCursorDefaultModels()),
    source: "cli",
    version,
  };
};

export const fetchGrokModels = async ({ force = false } = {}) => {
  const installed = await isCliCommandAvailable("grok");
  if (!installed) {
    return {
      error: "Grok Build CLI is not installed or not available on PATH.",
      installed: false,
      models: [],
      source: "unavailable",
      version: null,
    };
  }

  const version = await getCliVersion("grok", { force });
  let connection;
  try {
    connection = await spawnGrokAcp();
    const initializeResult = await initializeGrokAcp(connection);
    const models = dedupeAndSort(
      getGrokModelsFromInitializeResult(initializeResult).flatMap((entry) => {
        const id =
          typeof entry?.modelId === "string" ? entry.modelId.trim() : "";
        if (!id) return [];

        return [
          createModelOption(
            "grok",
            id,
            entry.name ?? id,
            normalizeReasoningEfforts(entry?._meta?.reasoningEfforts),
            [],
            entry?._meta?.totalContextTokens,
          ),
        ];
      }),
    );

    if (models.length === 0) {
      return {
        error: "Grok Build returned no models.",
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
          : "Unable to fetch Grok Build models.",
      installed: true,
      models: [],
      source: "unavailable",
      version,
    };
  } finally {
    connection?.close();
  }
};

export const fetchOpenCodeModels = async ({ force = false } = {}) => {
  const installed = await isCliCommandAvailable("opencode");
  if (!installed) {
    return {
      error: "OpenCode CLI is not installed or not available on PATH.",
      installed: false,
      models: [],
      source: "unavailable",
      version: null,
    };
  }
  const version = await getCliVersion("opencode", { force });

  try {
    const args = ["models", ...(force ? ["--refresh"] : [])];
    const [result, contextWindows] = await Promise.all([
      execCliCommand("opencode", args, {
        maxBuffer: 10 * 1024 * 1024,
      }),
      fetchOpenCodeContextWindowsFromModelsDev(),
    ]);
    const models = dedupeAndSort(
      parseOpenCodeModelsOutput(
        `${result.stdout}\n${result.stderr}`,
        contextWindows,
      ),
    );
    if (models.length === 0) {
      return {
        error:
          "OpenCode returned no models. Run `opencode auth login` or configure opencode.json, then refresh.",
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
          : "Unable to fetch OpenCode models.",
      installed: true,
      models: [],
      source: "unavailable",
      version,
    };
  }
};

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
