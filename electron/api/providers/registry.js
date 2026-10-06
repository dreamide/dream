// The provider registry: one record per agent provider, holding everything
// the rest of the server used to branch on `provider === "..."` for.
//
//   checkReady()        is the CLI installed and logged in
//   stream(options)     run a chat turn (a Response streaming the turn)
//   generateText(opts)  one-shot prompt -> text, for titles and git text
//   titleModel(fallback) the model to title a chat with; null = local title
//   fetchModels / fetchUsageLimits
//   capabilities        shared with the renderer (provider-capabilities.js)
//
// Adding a provider is one record here plus one row in the capabilities.
// The stream and runner functions are wrapped lazily because several of
// them sit behind import cycles (the Codex stream reaches into git actions,
// which reach back into this registry).
import {
  getProviderCapabilities,
  PROVIDER_IDS,
} from "../../shared/provider-capabilities.js";
import { streamClaudeResponse } from "../chat/claude-stream.js";
import { streamCodexAppServerResponse } from "../chat/codex-app-server.js";
import { streamCursorResponse } from "../chat/cursor-stream.js";
import { streamGrokResponse } from "../chat/grok-stream.js";
import { streamOpenCodeResponse } from "../chat/opencode-stream.js";
import { isCliCommandAvailable } from "../shared/cli.js";
import { createTimedCache } from "../shared/cli-catalog.js";
import { readCodexAccessToken } from "./codex-auth.js";
import {
  getCursorCliUnavailableMessage,
  isCursorCliAvailable,
} from "./cursor-cli.js";
import {
  runClaudePrompt,
  runCodexPrompt,
  runCursorPrompt,
  runGrokTextPrompt,
  runOpenCodePrompt,
} from "./generate-text.js";
import {
  fetchAnthropicModels,
  fetchCursorModels,
  fetchGrokModels,
  fetchOpenAiModels,
  fetchOpenCodeModels,
} from "./provider-models.js";
import {
  fetchAnthropicUsageLimits,
  fetchGrokUsageLimits,
  fetchOpenAiUsageLimits,
  fetchOpenCodeUsageStats,
} from "./usage-limits.js";

const notReady = (message, status = 400) => ({ message, status });

// Usage limits under the CLI catalog's policy (cli-catalog.js): every open
// usage popover polls, and OpenCode's answer starts a server, so an answer
// is shared for 30 seconds and a read under way by everyone who asks.
const USAGE_LIMITS_TTL_MS = 30_000;
const usageLimits = createTimedCache({
  isMiss: () => false,
  ttlMs: USAGE_LIMITS_TTL_MS,
});
const sharedUsageLimits = (id, read) => () => usageLimits.get(id, read);

const requireCli = (command, message) => async () =>
  (await isCliCommandAvailable(command)) ? null : notReady(message);

const requireTitleModel = (providerLabel) => (fallbackModel) => {
  const model = fallbackModel?.trim();
  if (!model) {
    throw new Error(`No ${providerLabel} title model is available.`);
  }
  return model;
};

const checkCodexReady = async () => {
  if (!(await isCliCommandAvailable("codex"))) {
    return notReady("Codex CLI is not installed or not available on PATH.");
  }
  if (!(await readCodexAccessToken())) {
    return notReady(
      "Codex login not found. Run `codex login` and try again.",
      401,
    );
  }
  return null;
};

const checkCursorReady = async () =>
  (await isCursorCliAvailable())
    ? null
    : notReady(getCursorCliUnavailableMessage());

const withCapabilities = (record) => ({
  ...getProviderCapabilities(record.id),
  ...record,
});

const providers = {
  openai: withCapabilities({
    id: "openai",
    checkReady: checkCodexReady,
    stream: (options) => streamCodexAppServerResponse(options),
    generateText: (options) => runCodexPrompt(options),
    titleModel: requireTitleModel("OpenAI"),
    fetchModels: (options) => fetchOpenAiModels(options),
    fetchUsageLimits: sharedUsageLimits("openai", () =>
      fetchOpenAiUsageLimits(),
    ),
  }),
  anthropic: withCapabilities({
    id: "anthropic",
    checkReady: requireCli(
      "claude",
      "Claude Code CLI is not installed or not available on PATH.",
    ),
    stream: (options) => streamClaudeResponse(options),
    generateText: (options) => runClaudePrompt(options),
    titleModel: (fallbackModel) => fallbackModel?.trim() || "haiku",
    fetchModels: (options) => fetchAnthropicModels(options),
    fetchUsageLimits: sharedUsageLimits("anthropic", () =>
      fetchAnthropicUsageLimits(),
    ),
  }),
  opencode: withCapabilities({
    id: "opencode",
    checkReady: requireCli(
      "opencode",
      "OpenCode CLI is not installed or not available on PATH.",
    ),
    stream: (options) => streamOpenCodeResponse(options),
    generateText: (options) => runOpenCodePrompt(options),
    titleModel: requireTitleModel("OpenCode"),
    fetchModels: (options) => fetchOpenCodeModels(options),
    fetchUsageLimits: sharedUsageLimits("opencode", () =>
      fetchOpenCodeUsageStats(),
    ),
  }),
  cursor: withCapabilities({
    id: "cursor",
    checkReady: checkCursorReady,
    stream: (options) => streamCursorResponse(options),
    generateText: (options) => runCursorPrompt(options),
    // Cursor has no cheap one-shot mode worth a title round trip.
    titleModel: () => null,
    fetchModels: (options) => fetchCursorModels(options),
    fetchUsageLimits: async () => ({
      error: "Cursor CLI usage limits are unavailable.",
      fetchedAt: new Date().toISOString(),
      provider: "cursor",
      status: "unavailable",
    }),
  }),
  grok: withCapabilities({
    id: "grok",
    checkReady: requireCli(
      "grok",
      "Grok Build CLI is not installed or not available on PATH. Install it, then run `grok login`.",
    ),
    stream: (options) => streamGrokResponse(options),
    generateText: (options) => runGrokTextPrompt(options),
    titleModel: (fallbackModel) => fallbackModel?.trim() || null,
    fetchModels: (options) => fetchGrokModels(options),
    fetchUsageLimits: sharedUsageLimits("grok", () => fetchGrokUsageLimits()),
  }),
};

export const getProvider = (id) => {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Unknown agent provider: ${String(id)}`);
  }
  return provider;
};

export const listProviders = () => PROVIDER_IDS.map(getProvider);
