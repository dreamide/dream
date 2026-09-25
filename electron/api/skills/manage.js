/**
 * Writes for the Skills settings page: scaffolding a new skill folder and
 * flipping a skill's enabled state through the provider's own mechanism.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { getCodexAppServerClient } from "../chat/codex-app-server-client.js";
import { getClaudeConfigDirectory } from "./claude-skills.js";
import { invalidateSkillCache } from "./index.js";
import { getHomeDirectory, readTextFileIfSmall } from "./scan.js";

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_NAME_MAX_LENGTH = 64;
const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Where a new skill can be written. "agents" roots are the cross-vendor
 * location read by Codex, OpenCode and Cursor; Claude Code only reads its
 * own `.claude/skills`.
 */
export const SKILL_TARGETS = {
  "project-agents": { relative: [".agents", "skills"], scope: "project" },
  "project-claude": { relative: [".claude", "skills"], scope: "project" },
  "user-agents": { relative: [".agents", "skills"], scope: "user" },
  "user-claude": { relative: ["skills"], scope: "user-claude" },
};

export const resolveSkillTargetDirectory = (target, { projectPath }) => {
  const definition = SKILL_TARGETS[target];
  if (!definition) {
    throw new Error(`Unknown skill target "${target}".`);
  }
  if (definition.scope === "project") {
    if (!projectPath) {
      throw new Error("A project is required for project skills.");
    }
    return path.join(path.resolve(projectPath), ...definition.relative);
  }
  if (definition.scope === "user-claude") {
    return path.join(getClaudeConfigDirectory(), ...definition.relative);
  }
  return path.join(getHomeDirectory(), ...definition.relative);
};

export const toSkillName = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX_LENGTH)
    .replace(/-+$/g, "");

const yamlQuote = (value) => JSON.stringify(String(value ?? ""));

export const buildSkillMarkdown = ({
  body,
  description,
  name,
  userInvocationOnly = false,
}) => {
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${yamlQuote(description)}`,
  ];
  if (userInvocationOnly) {
    lines.push("disable-model-invocation: true");
  }
  lines.push("---", "");
  const trimmedBody = String(body ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  lines.push(
    trimmedBody || `# ${name}\n\nDescribe what the agent should do here.`,
  );
  return `${lines.join("\n")}\n`;
};

export const validateSkillInput = ({ description, name }) => {
  if (!SKILL_NAME_PATTERN.test(name) || name.length > SKILL_NAME_MAX_LENGTH) {
    return "Skill names use lowercase letters, digits and single hyphens (1-64 characters).";
  }
  const trimmedDescription = String(description ?? "").trim();
  if (!trimmedDescription) {
    return "A description is required: it is how agents decide when to use the skill.";
  }
  if (trimmedDescription.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    return `Descriptions are limited to ${SKILL_DESCRIPTION_MAX_LENGTH} characters.`;
  }
  return null;
};

/**
 * Creates `<target>/<name>/SKILL.md` in every requested target. Refuses to
 * overwrite an existing skill folder.
 */
export const createSkill = async ({
  body,
  description,
  name,
  projectPath,
  targets,
  userInvocationOnly = false,
}) => {
  const validationError = validateSkillInput({ description, name });
  if (validationError) {
    throw new Error(validationError);
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("Choose at least one location for the skill.");
  }

  const directories = targets.map((target) =>
    path.join(resolveSkillTargetDirectory(target, { projectPath }), name),
  );
  for (const directory of directories) {
    try {
      await fs.stat(directory);
      throw new Error(`A skill already exists at ${directory}.`);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const markdown = buildSkillMarkdown({
    body,
    description: String(description).trim(),
    name,
    userInvocationOnly,
  });
  const created = [];
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, "SKILL.md");
    await fs.writeFile(filePath, markdown, "utf8");
    created.push(filePath);
  }
  invalidateSkillCache();
  return { paths: created };
};

const readJsonObject = async (filePath) => {
  const text = await readTextFileIfSmall(filePath);
  if (text === null) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    throw new Error(`${filePath} is not valid JSON; not modifying it.`);
  }
};

/**
 * Claude Code has no per-skill switch besides `skillOverrides` in its
 * settings files. The user-level file is used so the choice follows the
 * user across projects, matching where the CLI's /skills menu writes.
 */
export const setClaudeSkillEnabled = async ({ enabled, name }) => {
  const settingsPath = path.join(getClaudeConfigDirectory(), "settings.json");
  const settings = await readJsonObject(settingsPath);
  const overrides =
    settings.skillOverrides && typeof settings.skillOverrides === "object"
      ? { ...settings.skillOverrides }
      : {};
  if (enabled) {
    delete overrides[name];
  } else {
    overrides[name] = "off";
  }
  const next = { ...settings };
  if (Object.keys(overrides).length > 0) {
    next.skillOverrides = overrides;
  } else {
    delete next.skillOverrides;
  }
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(
    settingsPath,
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  return { settingsPath };
};

export const setCodexSkillEnabled = async ({
  enabled,
  mcpServers = [],
  name,
  skillPath,
}) => {
  const client = await getCodexAppServerClient({ mcpServers });
  await client.sendRequest("skills/config/write", {
    enabled,
    ...(skillPath ? { path: skillPath } : { name }),
  });
  return {};
};

export const setSkillEnabled = async ({
  enabled,
  mcpServers,
  name,
  provider,
  skillPath,
}) => {
  let result;
  switch (provider) {
    case "anthropic":
      result = await setClaudeSkillEnabled({ enabled, name });
      break;
    case "openai":
      result = await setCodexSkillEnabled({
        enabled,
        mcpServers,
        name,
        skillPath,
      });
      break;
    default:
      throw new Error(
        `${provider} has no per-skill switch; remove or rename the skill folder instead.`,
      );
  }
  invalidateSkillCache(provider);
  return result;
};
