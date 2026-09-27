import { z } from "zod";
import {
  CLI_UPDATE_PROVIDERS,
  fetchLatestCliVersions,
  upgradeCli,
} from "./providers/cli-updates.js";
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
  fetchAnthropicModels,
  fetchCursorModels,
  fetchGrokModels,
  fetchOpenAiModels,
  fetchOpenCodeModels,
} from "./providers/provider-models.js";
import {
  fetchAnthropicUsageLimits,
  fetchGrokUsageLimits,
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
  provider: z.enum(["openai", "anthropic", "opencode", "cursor", "grok"]),
  projectPath: z.string().optional(),
});

const providerModelsRequestSchema = z
  .object({
    force: z.boolean().optional(),
    provider: z
      .enum(["openai", "anthropic", "opencode", "cursor", "grok"])
      .optional(),
  })
  .optional();

const cliUpdatesRequestSchema = z.object({
  force: z.boolean().optional(),
  providers: z.array(z.enum(CLI_UPDATE_PROVIDERS)).max(10),
});

const cliUpgradeRequestSchema = z.object({
  provider: z.enum(CLI_UPDATE_PROVIDERS),
});

export const registerProviderRoutes = (app) => {
  // Long-running: resolves when the CLI's updater exits (up to 10 minutes).
  app.post("/api/cli-upgrade", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON body.", 400);
    }

    const parsed = cliUpgradeRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text("Invalid CLI upgrade request.", 400);
    }

    return c.json(await upgradeCli(parsed.data.provider));
  });

  app.post("/api/cli-updates", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON body.", 400);
    }

    const parsed = cliUpdatesRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text("Invalid CLI updates request.", 400);
    }

    const latest = await fetchLatestCliVersions({
      force: parsed.data.force ?? false,
      providers: Array.from(new Set(parsed.data.providers)),
    });

    return c.json({ checkedAt: new Date().toISOString(), latest });
  });

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
    const [openai, anthropic, opencode, cursor, grok] =
      provider === "openai"
        ? [await fetchOpenAiModels({ force }), null, null, null, null]
        : provider === "anthropic"
          ? [null, await fetchAnthropicModels({ force }), null, null, null]
          : provider === "opencode"
            ? [null, null, await fetchOpenCodeModels({ force }), null, null]
            : provider === "cursor"
              ? [null, null, null, await fetchCursorModels({ force }), null]
              : provider === "grok"
                ? [null, null, null, null, await fetchGrokModels({ force })]
                : await Promise.all([
                    fetchOpenAiModels({ force }),
                    fetchAnthropicModels({ force }),
                    fetchOpenCodeModels({ force }),
                    fetchCursorModels({ force }),
                    fetchGrokModels({ force }),
                  ]);

    return c.json({
      ...(anthropic ? { anthropic } : {}),
      ...(cursor ? { cursor } : {}),
      fetchedAt: new Date().toISOString(),
      ...(openai ? { openai } : {}),
      ...(opencode ? { opencode } : {}),
      ...(grok ? { grok } : {}),
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

    if (parsed.data.provider === "grok") {
      return c.json(await fetchGrokUsageLimits());
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
