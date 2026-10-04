import { z } from "zod";
import {
  readCodexAccessToken,
  readCodexChatGptAuthTokens,
} from "./providers/codex-auth.js";
import {
  CLAUDE_REASONING_EFFORT_MAP,
  getModelReasoningEfforts,
  normalizeClaudeCodeModel,
} from "./providers/model-options.js";
import {
  fetchAmpModels,
  fetchAnthropicModels,
  fetchCursorModels,
  fetchGrokModels,
  fetchOpenAiModels,
  fetchOpenCodeModels,
} from "./providers/provider-models.js";
import {
  fetchAnthropicUsageLimits,
  fetchOpenAiUsageLimits,
  fetchOpenCodeUsageStats,
  findRateLimitsObject,
  storeProviderUsageLimitSnapshot,
} from "./providers/usage-limits.js";
import { isCliCommandAvailable } from "./shared/cli.js";

export {
  CLAUDE_REASONING_EFFORT_MAP,
  findRateLimitsObject,
  getModelReasoningEfforts,
  isCliCommandAvailable,
  normalizeClaudeCodeModel,
  readCodexAccessToken,
  readCodexChatGptAuthTokens,
  storeProviderUsageLimitSnapshot,
};

const providerUsageLimitsRequestSchema = z.object({
  provider: z.enum([
    "openai",
    "anthropic",
    "opencode",
    "cursor",
    "grok",
    "amp",
  ]),
  projectPath: z.string().optional(),
});

const providerModelsRequestSchema = z
  .object({
    force: z.boolean().optional(),
    provider: z
      .enum(["openai", "anthropic", "opencode", "cursor", "grok", "amp"])
      .optional(),
  })
  .optional();

export const registerProviderRoutes = (app) => {
  app.post("/api/provider-models", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      rawBody = undefined;
    }

    const parsed = providerModelsRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text("Invalid provider models request.", 400);
    }

    const force = parsed.data?.force ?? false;
    const provider = parsed.data?.provider;
    const fetchers = {
      amp: () => fetchAmpModels({ force }),
      anthropic: () => fetchAnthropicModels({ force }),
      cursor: () => fetchCursorModels({ force }),
      grok: () => fetchGrokModels({ force }),
      openai: () => fetchOpenAiModels({ force }),
      opencode: () => fetchOpenCodeModels({ force }),
    };
    const requestedProviders = provider ? [provider] : Object.keys(fetchers);
    const modelsByProvider = Object.fromEntries(
      await Promise.all(
        requestedProviders.map(async (key) => [key, await fetchers[key]()]),
      ),
    );
    const { openai, anthropic, opencode, cursor, grok, amp } = modelsByProvider;

    return c.json({
      ...(anthropic ? { anthropic } : {}),
      ...(cursor ? { cursor } : {}),
      fetchedAt: new Date().toISOString(),
      ...(openai ? { openai } : {}),
      ...(opencode ? { opencode } : {}),
      ...(grok ? { grok } : {}),
      ...(amp ? { amp } : {}),
    });
  });

  app.post("/api/provider-usage-limits", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON body.", 400);
    }

    const parsed = providerUsageLimitsRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text("Invalid usage limits request.", 400);
    }

    if (parsed.data.provider === "cursor") {
      return c.json({
        error: "Cursor CLI usage limits are unavailable.",
        fetchedAt: new Date().toISOString(),
        provider: "cursor",
        status: "unavailable",
      });
    }

    if (parsed.data.provider === "grok" || parsed.data.provider === "amp") {
      const label = parsed.data.provider === "amp" ? "Amp" : "Grok Build";
      return c.json({
        error: `${label} usage limits are unavailable.`,
        fetchedAt: new Date().toISOString(),
        provider: parsed.data.provider,
        status: "unavailable",
      });
    }

    if (parsed.data.provider === "opencode") {
      return c.json(await fetchOpenCodeUsageStats());
    }

    const result =
      parsed.data.provider === "openai"
        ? await fetchOpenAiUsageLimits()
        : await fetchAnthropicUsageLimits();

    return c.json(result);
  });
};
