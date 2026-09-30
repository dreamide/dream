// Request schemas: the contract with the renderer's route client
// (src/lib/api-client.ts), which takes its request types from here.
import { z } from "zod";
import { PROVIDER_IDS } from "../../shared/provider-capabilities.js";

/** The agent CLIs Dream can check for and install updates of. */
export const CLI_UPDATE_PROVIDERS = /** @type {const} */ ([
  "anthropic",
  "cursor",
  "grok",
  "openai",
  "opencode",
]);

const providerIdSchema = z.enum(PROVIDER_IDS);

export const providerUsageLimitsRequestSchema = z.object({
  provider: providerIdSchema,
  projectPath: z.string().optional(),
});

export const providerModelsRequestSchema = z
  .object({
    force: z.boolean().optional(),
    provider: providerIdSchema.optional(),
  })
  .optional();

export const cliUpdatesRequestSchema = z.object({
  force: z.boolean().optional(),
  providers: z.array(z.enum(CLI_UPDATE_PROVIDERS)).max(10),
});

export const cliUpgradeRequestSchema = z.object({
  provider: z.enum(CLI_UPDATE_PROVIDERS),
});
