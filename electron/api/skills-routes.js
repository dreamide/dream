import { z } from "zod";
import { listProviderSkills } from "./skills/index.js";
import { createSkill, setSkillEnabled } from "./skills/manage.js";
import { readSkillFile } from "./skills/read.js";

const providerSchema = z.enum([
  "openai",
  "anthropic",
  "opencode",
  "cursor",
  "grok",
]);

const skillsRequestSchema = z.object({
  force: z.boolean().optional(),
  mcpServers: z.array(z.any()).optional(),
  projectPath: z.string().optional(),
  provider: providerSchema,
});

const createSkillRequestSchema = z.object({
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

const setEnabledRequestSchema = z.object({
  enabled: z.boolean(),
  mcpServers: z.array(z.any()).optional(),
  name: z.string().min(1),
  path: z.string().optional(),
  provider: providerSchema,
});

const readSkillRequestSchema = z.object({
  mcpServers: z.array(z.any()).optional(),
  path: z.string().min(1),
  projectPath: z.string().optional(),
  provider: providerSchema,
});

const readJsonBody = async (c) => {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
};

export const registerSkillsRoutes = (app) => {
  app.post("/api/skills", async (c) => {
    const parsed = skillsRequestSchema.safeParse((await readJsonBody(c)) ?? {});
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

  app.post("/api/skills/read", async (c) => {
    const parsed = readSkillRequestSchema.safeParse(
      (await readJsonBody(c)) ?? {},
    );
    if (!parsed.success) {
      return c.text("Invalid skill read request.", 400);
    }

    try {
      const result = await readSkillFile({
        mcpServers: parsed.data.mcpServers ?? [],
        projectPath: parsed.data.projectPath?.trim() || undefined,
        provider: parsed.data.provider,
        skillPath: parsed.data.path,
      });
      return c.json(result);
    } catch (error) {
      return c.text(
        error instanceof Error ? error.message : "Reading the skill failed.",
        400,
      );
    }
  });

  app.post("/api/skills/create", async (c) => {
    const parsed = createSkillRequestSchema.safeParse(
      (await readJsonBody(c)) ?? {},
    );
    if (!parsed.success) {
      return c.text("Invalid create skill request.", 400);
    }

    try {
      const result = await createSkill({
        ...parsed.data,
        projectPath: parsed.data.projectPath?.trim() || undefined,
      });
      return c.json(result);
    } catch (error) {
      return c.text(
        error instanceof Error ? error.message : "Creating the skill failed.",
        400,
      );
    }
  });

  app.post("/api/skills/set-enabled", async (c) => {
    const parsed = setEnabledRequestSchema.safeParse(
      (await readJsonBody(c)) ?? {},
    );
    if (!parsed.success) {
      return c.text("Invalid skill update request.", 400);
    }

    try {
      const result = await setSkillEnabled({
        enabled: parsed.data.enabled,
        mcpServers: parsed.data.mcpServers ?? [],
        name: parsed.data.name,
        provider: parsed.data.provider,
        skillPath: parsed.data.path?.trim() || undefined,
      });
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.text(
        error instanceof Error ? error.message : "Updating the skill failed.",
        400,
      );
    }
  });
};
