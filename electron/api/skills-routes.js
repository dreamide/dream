import { z } from "zod";
import { listProviderSkills } from "./skills/index.js";

const skillsRequestSchema = z.object({
  force: z.boolean().optional(),
  mcpServers: z.array(z.any()).optional(),
  projectPath: z.string().optional(),
  provider: z.enum(["openai", "anthropic", "opencode", "cursor", "grok"]),
});

export const registerSkillsRoutes = (app) => {
  app.post("/api/skills", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      rawBody = {};
    }

    const parsed = skillsRequestSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      return c.text("Invalid skills request.", 400);
    }

    const result = await listProviderSkills({
      force: parsed.data.force ?? false,
      mcpServers: parsed.data.mcpServers ?? [],
      projectPath: parsed.data.projectPath?.trim() || undefined,
      provider: parsed.data.provider,
    });
    return c.json(result);
  });
};
