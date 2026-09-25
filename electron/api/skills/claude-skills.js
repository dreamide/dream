/**
 * Claude Code skill discovery.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `<dir>/.claude/skills` for the working directory and each ancestor up to
 * the repository root (project scope), plus legacy `commands/*.md` files in
 * the same two places. It does not read `.agents/skills`.
 *
 * The Agent SDK's init handshake only reports skill names, so the same
 * locations are scanned directly. The user root wins on name collisions,
 * matching the CLI's enterprise > personal > project precedence.
 */

import path from "node:path";
import {
  collectProjectAncestors,
  dedupeSkillsByName,
  getHomeDirectory,
  readTextFileIfSmall,
  scanCommandRoot,
  scanSkillRoot,
  sortSkills,
} from "./scan.js";

export const getClaudeConfigDirectory = () =>
  process.env.CLAUDE_CONFIG_DIR?.trim() ||
  path.join(getHomeDirectory(), ".claude");

const readJson = async (filePath) => {
  const text = await readTextFileIfSmall(filePath);
  if (text === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Reads `skillOverrides` from every Claude settings file that applies, later
 * files overriding earlier ones (user < project < local).
 */
export const readClaudeSkillOverrides = async ({
  configDirectory,
  ancestors,
}) => {
  const settingsFiles = [path.join(configDirectory, "settings.json")];
  for (const directory of [...ancestors].reverse()) {
    settingsFiles.push(
      path.join(directory, ".claude", "settings.json"),
      path.join(directory, ".claude", "settings.local.json"),
    );
  }

  const overrides = {};
  for (const filePath of settingsFiles) {
    const settings = await readJson(filePath);
    const map = settings?.skillOverrides;
    if (!map || typeof map !== "object") {
      continue;
    }
    for (const [name, value] of Object.entries(map)) {
      if (typeof value === "string") {
        overrides[name] = value.trim().toLowerCase();
      }
    }
  }
  return overrides;
};

export const applyClaudeSkillOverride = (skill, override) => {
  switch (override) {
    case "off":
      return { ...skill, enabled: false };
    case "user-invocable-only":
      return { ...skill, userInvocationOnly: true };
    default:
      return skill;
  }
};

export const discoverClaudeSkills = async ({ projectPath } = {}) => {
  const configDirectory = getClaudeConfigDirectory();
  const ancestors = projectPath
    ? await collectProjectAncestors(projectPath)
    : [];

  const roots = [
    scanSkillRoot({
      directory: path.join(configDirectory, "skills"),
      scope: "user",
      source: "claude",
    }),
    scanCommandRoot({
      directory: path.join(configDirectory, "commands"),
      scope: "user",
      source: "claude",
    }),
  ];
  for (const directory of ancestors) {
    roots.push(
      scanSkillRoot({
        directory: path.join(directory, ".claude", "skills"),
        maxDepth: 2,
        scope: "project",
        source: "claude",
      }),
      scanCommandRoot({
        directory: path.join(directory, ".claude", "commands"),
        scope: "project",
        source: "claude",
      }),
    );
  }

  const [overrides, ...results] = await Promise.all([
    readClaudeSkillOverrides({ ancestors, configDirectory }),
    ...roots,
  ]);

  const skills = dedupeSkillsByName(results.flat()).map((skill) =>
    applyClaudeSkillOverride(skill, overrides[skill.name]),
  );
  return { errors: [], skills: sortSkills(skills) };
};
