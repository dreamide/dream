import { isProviderId } from "../shared/provider-capabilities.js";
import { fetchLatestCliVersions, upgradeCli } from "./providers/cli-updates.js";
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
  cliUpdatesRequestSchema,
  cliUpgradeRequestSchema,
  providerModelsRequestSchema,
  providerUsageLimitsRequestSchema,
} from "./providers/schemas.js";
import {
  findRateLimitsObject,
  storeProviderUsageLimitSnapshot,
} from "./providers/usage-limits.js";
import { isCliCommandAvailable } from "./shared/cli.js";
import { handleJsonRoute } from "./shared/json-route.js";

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

// These routes never throw for a provider problem: each answers with its
// own status in the body. A thrown error is a bug, so it is a 500.
const PROVIDER_ROUTE = { errorStatus: 500 };

export const registerProviderRoutes = (app) => {
  // Long-running: resolves when the CLI's updater exits (up to 10 minutes).
  app.post("/api/cli-upgrade", (c) =>
    handleJsonRoute(
      c,
      cliUpgradeRequestSchema,
      ({ provider }) => upgradeCli(provider),
      { ...PROVIDER_ROUTE, invalidMessage: "Invalid CLI upgrade request." },
    ),
  );

  app.post("/api/cli-updates", (c) =>
    handleJsonRoute(
      c,
      cliUpdatesRequestSchema,
      async ({ force, providers }) => ({
        checkedAt: new Date().toISOString(),
        latest: await fetchLatestCliVersions({
          force: force ?? false,
          providers: Array.from(new Set(providers)),
        }),
      }),
      { ...PROVIDER_ROUTE, invalidMessage: "Invalid CLI updates request." },
    ),
  );

  app.post("/api/provider-models", (c) =>
    handleJsonRoute(
      c,
      providerModelsRequestSchema,
      async (data) => {
        const force = data?.force ?? false;
        const providers = isProviderId(data?.provider)
          ? [getProvider(data.provider)]
          : listProviders();
        const results = await Promise.all(
          providers.map(async (provider) => [
            provider.id,
            await provider.fetchModels({ force }),
          ]),
        );
        return {
          ...Object.fromEntries(results),
          fetchedAt: new Date().toISOString(),
        };
      },
      {
        ...PROVIDER_ROUTE,
        invalidMessage: "Invalid provider models request.",
        // No body asks for every provider.
        missingBody: undefined,
      },
    ),
  );

  app.post("/api/provider-usage-limits", (c) =>
    handleJsonRoute(
      c,
      providerUsageLimitsRequestSchema,
      ({ provider }) => getProvider(provider).fetchUsageLimits(),
      { ...PROVIDER_ROUTE, invalidMessage: "Invalid usage limits request." },
    ),
  );
};
