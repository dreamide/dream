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
} from "./providers/provider-models.js";
import {
  fetchAnthropicUsageLimits,
  fetchOpenAiUsageLimits,
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
  provider: z.enum(["openai", "anthropic"]),
});

export const registerProviderRoutes = (app) => {
  app.post("/api/provider-models", async (c) => {
    const [openai, anthropic] = await Promise.all([
      fetchOpenAiModels(),
      fetchAnthropicModels(),
    ]);

    return c.json({
      anthropic,
      fetchedAt: new Date().toISOString(),
      openai,
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

    const result =
      parsed.data.provider === "openai"
        ? await fetchOpenAiUsageLimits()
        : await fetchAnthropicUsageLimits();

    return c.json(result);
  });
};
