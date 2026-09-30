import { handleJsonRoute } from "./shared/json-route.js";
import { listProviderSkills } from "./skills/index.js";
import { createSkill, setSkillEnabled } from "./skills/manage.js";
import { readSkillFile } from "./skills/read.js";
import {
  createSkillRequestSchema,
  readSkillRequestSchema,
  setSkillEnabledRequestSchema,
  skillsRequestSchema,
} from "./skills/schemas.js";

// A missing or non-JSON body reads as `{}`, so the schema names what is
// missing.
const SKILL_ROUTE = { missingBody: {} };

export const registerSkillsRoutes = (app) => {
  app.post("/api/skills", (c) =>
    handleJsonRoute(
      c,
      skillsRequestSchema,
      (data) =>
        listProviderSkills({
          force: data.force ?? false,
          mcpServers: data.mcpServers ?? [],
          projectPath: data.projectPath?.trim() || undefined,
          provider: data.provider,
        }),
      {
        ...SKILL_ROUTE,
        errorStatus: 500,
        invalidMessage: "Invalid skills request.",
      },
    ),
  );

  app.post("/api/skills/read", (c) =>
    handleJsonRoute(
      c,
      readSkillRequestSchema,
      (data) =>
        readSkillFile({
          mcpServers: data.mcpServers ?? [],
          projectPath: data.projectPath?.trim() || undefined,
          provider: data.provider,
          skillPath: data.path,
        }),
      {
        ...SKILL_ROUTE,
        errorMessage: "Reading the skill failed.",
        invalidMessage: "Invalid skill read request.",
      },
    ),
  );

  app.post("/api/skills/create", (c) =>
    handleJsonRoute(
      c,
      createSkillRequestSchema,
      (data) =>
        createSkill({
          ...data,
          projectPath: data.projectPath?.trim() || undefined,
        }),
      {
        ...SKILL_ROUTE,
        errorMessage: "Creating the skill failed.",
        invalidMessage: "Invalid create skill request.",
      },
    ),
  );

  app.post("/api/skills/set-enabled", (c) =>
    handleJsonRoute(
      c,
      setSkillEnabledRequestSchema,
      async (data) => ({
        ok: true,
        ...(await setSkillEnabled({
          enabled: data.enabled,
          mcpServers: data.mcpServers ?? [],
          name: data.name,
          provider: data.provider,
          skillPath: data.path?.trim() || undefined,
        })),
      }),
      {
        ...SKILL_ROUTE,
        errorMessage: "Updating the skill failed.",
        invalidMessage: "Invalid skill update request.",
      },
    ),
  );
};
