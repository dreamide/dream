import {
  execCliCommand,
  getCliVersion,
  isCliCommandAvailable,
} from "../shared/cli.js";
import {
  execAntigravityCliCommand,
  getAntigravityCliUnavailableMessage,
  getAntigravityCliVersion,
  isAntigravityCliAvailable,
} from "./antigravity-cli.js";
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

/**
 * A provider's models, by the sequence every provider follows: is its CLI
 * installed, which version, then `read`. `read` returns the models, or
 * `{ error }` when a precondition fails (not logged in). No models, or a
 * read that throws, is an error the model picker shows; the version is
 * reported whenever the CLI is there.
 */
export const readProviderModels = async ({
  emptyError,
  failedError,
  isInstalled,
  notInstalledError,
  read,
  version,
}) => {
  if (!(await isInstalled())) {
    return {
      error: notInstalledError,
      installed: false,
      models: [],
      source: "unavailable",
      version: null,
    };
  }
  const cliVersion = await version();
  const unavailable = (error) => ({
    error,
    installed: true,
    models: [],
    source: "unavailable",
    version: cliVersion,
  });
  try {
    const result = await read();
    if (!Array.isArray(result)) return unavailable(result.error);
    if (result.length === 0) return unavailable(emptyError);
    return {
      installed: true,
      models: result,
      source: "cli",
      version: cliVersion,
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : failedError);
  }
};

export const fetchOpenAiModels = ({ force = false } = {}) =>
  readProviderModels({
    emptyError: "Codex returned no models.",
    failedError: "Unable to fetch Codex models.",
    isInstalled: () => isCliCommandAvailable("codex"),
    notInstalledError: "Codex CLI is not installed or not available on PATH.",
    read: async () => {
      const accessToken = await readCodexAccessToken();
      if (!accessToken) {
        return { error: "Run `codex login` to fetch Codex models." };
      }
      return fetchOpenAiModelsWithCodexChatgpt(accessToken);
    },
    version: () => getCliVersion("codex", { force }),
  });

export const fetchCursorModels = ({ force = false } = {}) =>
  readProviderModels({
    emptyError: "Cursor returned no models.",
    failedError: "Unable to fetch Cursor models.",
    isInstalled: () => isCursorCliAvailable({ force }),
    notInstalledError: getCursorCliUnavailableMessage(),
    // Chats run over ACP, which only accepts the model ids it lists itself,
    // so the picker must offer those rather than the flat ids of
    // `agent models`.
    read: async () => {
      try {
        const models = dedupeModelOptions(
          (await fetchCursorAcpModels()).flatMap((entry) => {
            const acpModelId =
              typeof entry?.modelId === "string" ? entry.modelId.trim() : "";
            if (!acpModelId) return [];
            const id = toDreamCursorModelId(acpModelId);
            const name =
              typeof entry.name === "string" ? entry.name.trim() : "";
            return [
              createModelOption(
                "cursor",
                id,
                id === CURSOR_AUTO_MODEL ? "Cursor Auto" : name || acpModelId,
              ),
            ];
          }),
        );
        if (models.length > 0) return sortCursorModelOptions(models);
      } catch {
        // Not logged in, or an older Cursor without ACP model listing.
      }
      // Auto still works, so offer it alone.
      return sortCursorModelOptions(createCursorDefaultModels());
    },
    version: () => getCursorCliVersion({ force }),
  });

export const fetchGrokModels = ({ force = false } = {}) =>
  readProviderModels({
    emptyError: "Grok Build returned no models.",
    failedError: "Unable to fetch Grok Build models.",
    isInstalled: () => isCliCommandAvailable("grok"),
    notInstalledError:
      "Grok Build CLI is not installed or not available on PATH.",
    read: async () => {
      let connection;
      try {
        connection = await spawnGrokAcp();
        const initializeResult = await initializeGrokAcp(connection);
        return dedupeAndSort(
          getGrokModelsFromInitializeResult(initializeResult).flatMap(
            (entry) => {
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
            },
          ),
        );
      } finally {
        connection?.close();
      }
    },
    version: () => getCliVersion("grok", { force }),
  });

export const fetchOpenCodeModels = ({ force = false } = {}) =>
  readProviderModels({
    emptyError:
      "OpenCode returned no models. Run `opencode auth login` or configure opencode.json, then refresh.",
    failedError: "Unable to fetch OpenCode models.",
    isInstalled: () => isCliCommandAvailable("opencode"),
    notInstalledError:
      "OpenCode CLI is not installed or not available on PATH.",
    read: async () => {
      const args = ["models", ...(force ? ["--refresh"] : [])];
      const [result, contextWindows] = await Promise.all([
        execCliCommand("opencode", args, {
          maxBuffer: 10 * 1024 * 1024,
        }),
        fetchOpenCodeContextWindowsFromModelsDev(),
      ]);
      return dedupeAndSort(
        parseOpenCodeModelsOutput(
          `${result.stdout}\n${result.stderr}`,
          contextWindows,
        ),
      );
    },
    version: () => getCliVersion("opencode", { force }),
  });

export const fetchAnthropicModels = ({ force = false } = {}) =>
  readProviderModels({
    emptyError: "Claude Code returned no supported models.",
    failedError: "Unable to fetch Claude Code models.",
    isInstalled: () => isCliCommandAvailable("claude"),
    notInstalledError:
      "Claude Code CLI is not installed or not available on PATH.",
    read: () => fetchClaudeCodeModelOptionsFromModelsDev(),
    version: () => getCliVersion("claude", { force }),
  });

export const parseAntigravityModelsOutput = (output) => {
  const clean = stripAnsi(output);
  const models = [];
  const lines = clean.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("Fetching available models") ||
      trimmed.startsWith("Usage:")
    ) {
      continue;
    }
    let id;
    let label;
    if (trimmed.includes("\t")) {
      const parts = trimmed.split(/\t+/);
      id = parts[0]?.trim();
      label = parts.slice(1).join("\t").trim() || id;
    } else {
      const firstSpace = trimmed.indexOf(" ");
      if (firstSpace !== -1) {
        id = trimmed.slice(0, firstSpace).trim();
        label = trimmed.slice(firstSpace + 1).trim() || id;
      } else {
        id = trimmed;
        label = trimmed;
      }
    }

    if (!id || id.toLowerCase() === "model" || id.toLowerCase() === "id") {
      continue;
    }
    const modelId = id;
    const contextWindow = modelId.startsWith("gemini-") ? 1_000_000 : undefined;
    models.push(
      createModelOption(
        "antigravity",
        modelId,
        label,
        getModelReasoningEfforts("antigravity", modelId),
        getModelSpeedTiers("antigravity", modelId),
        contextWindow,
      ),
    );
  }
  return models;
};

export const fetchAntigravityModels = ({ force = false } = {}) =>
  readProviderModels({
    emptyError: "Antigravity returned no models.",
    failedError: "Unable to fetch Antigravity models.",
    isInstalled: () => isAntigravityCliAvailable({ force }),
    notInstalledError: getAntigravityCliUnavailableMessage(),
    read: async () => {
      const result = await execAntigravityCliCommand(["models"], {
        closeStdin: true,
        timeout: 15_000,
      });
      return dedupeAndSort(parseAntigravityModelsOutput(result.stdout));
    },
    version: () => getAntigravityCliVersion({ force }),
  });
