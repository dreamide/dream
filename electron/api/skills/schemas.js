// Request schemas: the contract with the renderer's route client
// (src/lib/api-client.ts), which takes its request types from here.
import { z } from "zod";

const providerSchema = z.enum([
  "openai",
  "anthropic",
  "opencode",
  "cursor",
  "grok",
]);

export const skillsRequestSchema = z.object({
  force: z.boolean().optional(),
  mcpServers: z.array(z.any()).optional(),
  projectPath: z.string().optional(),
  provider: providerSchema,
});

export const createSkillRequestSchema = z.object({
  body: z.string().default(""),
  description: z.string(),
  name: z.string().min(1),
  projectPath: z.string().optional(),
  targets: z
    .array(
      z.enum([
        "project-agents",
        "project-claude",
        "user-agents",
        "user-claude",
      ]),
    )
    .min(1),
  userInvocationOnly: z.boolean().optional(),
});

export const setSkillEnabledRequestSchema = z.object({
  enabled: z.boolean(),
  mcpServers: z.array(z.any()).optional(),
  name: z.string().min(1),
  path: z.string().optional(),
  provider: providerSchema,
});

export const readSkillRequestSchema = z.object({
  mcpServers: z.array(z.any()).optional(),
  path: z.string().min(1),
  projectPath: z.string().optional(),
  provider: providerSchema,
});
