import { z } from "zod";
import { isProviderId, PROVIDER_IDS } from "../shared/provider-capabilities.js";
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
import { getProvider, listProviders } from "./providers/registry.js";
import {
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

const providerIdSchema = z.enum(PROVIDER_IDS);

const providerUsageLimitsRequestSchema = z.object({
  provider: providerIdSchema,
  projectPath: z.string().optional(),
});

const providerModelsRequestSchema = z
  .object({
    force: z.boolean().optional(),
    provider: providerIdSchema.optional(),
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
    const providers = isProviderId(parsed.data?.provider)
      ? [getProvider(parsed.data.provider)]
      : listProviders();
    const results = await Promise.all(
      providers.map(async (provider) => [
        provider.id,
        await provider.fetchModels({ force }),
      ]),
    );

    return c.json({
      ...Object.fromEntries(results),
      fetchedAt: new Date().toISOString(),
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

    return c.json(await getProvider(parsed.data.provider).fetchUsageLimits());
  });
};
