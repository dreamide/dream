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
  fetchAnthropicModels,
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
  provider: z.enum(["openai", "anthropic", "opencode"]),
  projectPath: z.string().optional(),
});

const providerModelsRequestSchema = z
  .object({
    force: z.boolean().optional(),
    provider: z.enum(["openai", "anthropic", "opencode"]).optional(),
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
    const [openai, anthropic, opencode] =
      provider === "openai"
        ? [await fetchOpenAiModels({ force }), null, null]
        : provider === "anthropic"
          ? [null, await fetchAnthropicModels({ force }), null]
          : provider === "opencode"
            ? [null, null, await fetchOpenCodeModels({ force })]
            : await Promise.all([
                fetchOpenAiModels({ force }),
                fetchAnthropicModels({ force }),
                fetchOpenCodeModels({ force }),
              ]);

    return c.json({
      ...(anthropic ? { anthropic } : {}),
      fetchedAt: new Date().toISOString(),
      ...(openai ? { openai } : {}),
      ...(opencode ? { opencode } : {}),
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

    if (parsed.data.provider === "opencode") {
      return c.json(
        await fetchOpenCodeUsageStats({
          projectPath: parsed.data.projectPath,
        }),
      );
    }

    const result =
      parsed.data.provider === "openai"
        ? await fetchOpenAiUsageLimits()
        : await fetchAnthropicUsageLimits();

    return c.json(result);
  });
};
