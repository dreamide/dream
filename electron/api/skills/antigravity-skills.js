/**
 * Antigravity skill discovery.
 *
 * Antigravity CLI (`agy`) loads skills from:
 * - Project roots: `.gemini/skills`, `.agents/skills`, and `.gemini/plugins`, `.agents/plugins`
 * - User roots: `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills`, `~/.agents/skills`,
 *   and `~/.gemini/config/plugins`, `~/.gemini/antigravity-cli/plugins`
 * - System roots: `~/.gemini/antigravity-cli/builtin/skills`
 *
 * Precedence order: project > user > plugin > system.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  collectProjectAncestors,
  dedupeSkillsByName,
  directoryExists,
  getHomeDirectory,
  readTextFileIfSmall,
  scanSkillRoot,
  sortSkills,
} from "./scan.js";

export const getAntigravityConfigDirectory = () =>
  process.env.ANTIGRAVITY_CONFIG_DIR?.trim() ||
  process.env.GEMINI_CONFIG_DIR?.trim() ||
  path.join(getHomeDirectory(), ".gemini", "config");

export const getAntigravityCliDirectory = () =>
  process.env.ANTIGRAVITY_CLI_DIR?.trim() ||
  process.env.GEMINI_CLI_DIR?.trim() ||
  path.join(getHomeDirectory(), ".gemini", "antigravity-cli");

export const scanPluginSkillsDirectory = async ({
  directory,
  defaultScope = "plugin",
  defaultSource = "gemini",
}) => {
  const root = path.resolve(directory);
  if (!(await directoryExists(root))) {
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const pluginSkills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    if (entry.name.startsWith(".")) {
      continue;
    }

    const pluginId = entry.name;
    const pluginDir = path.join(root, pluginId);
    const skillsDir = path.join(pluginDir, "skills");

    let disabled = false;
    const pluginJsonPath = path.join(pluginDir, "plugin.json");
    const pluginJsonText = await readTextFileIfSmall(pluginJsonPath);
    if (pluginJsonText !== null) {
      try {
        const parsed = JSON.parse(pluginJsonText);
        if (parsed?.disabled === true) {
          disabled = true;
        }
      } catch {
        // Ignore malformed JSON
      }
    }

    const discovered = await scanSkillRoot({
      directory: skillsDir,
      scope: defaultScope,
      source: defaultSource,
    });

    for (const skill of discovered) {
      pluginSkills.push({
        ...skill,
        enabled: disabled ? false : skill.enabled,
        pluginId,
        scope: defaultScope,
      });
    }
  }

  return pluginSkills;
};

export const discoverAntigravitySkills = async ({ projectPath } = {}) => {
  const home = getHomeDirectory();
  const configDir = getAntigravityConfigDirectory();
  const cliDir = getAntigravityCliDirectory();

  const ancestors = projectPath
    ? await collectProjectAncestors(projectPath)
    : [];

  const projectSkillPromises = [];
  const projectPluginPromises = [];

  for (const ancestor of ancestors) {
    projectSkillPromises.push(
      scanSkillRoot({
        directory: path.join(ancestor, ".gemini", "skills"),
        scope: "project",
        source: "gemini",
      }),
      scanSkillRoot({
        directory: path.join(ancestor, ".agents", "skills"),
        scope: "project",
        source: "agents",
      }),
    );

    projectPluginPromises.push(
      scanPluginSkillsDirectory({
        defaultScope: "plugin",
        defaultSource: "gemini",
        directory: path.join(ancestor, ".gemini", "plugins"),
      }),
      scanPluginSkillsDirectory({
        defaultScope: "plugin",
        defaultSource: "agents",
        directory: path.join(ancestor, ".agents", "plugins"),
      }),
    );
  }

  const userSkillPromises = [
    scanSkillRoot({
      directory: path.join(configDir, "skills"),
      scope: "user",
      source: "gemini",
    }),
    scanSkillRoot({
      directory: path.join(cliDir, "skills"),
      scope: "user",
      source: "gemini",
    }),
    scanSkillRoot({
      directory: path.join(home, ".agents", "skills"),
      scope: "user",
      source: "agents",
    }),
  ];

  const userPluginPromises = [
    scanPluginSkillsDirectory({
      defaultScope: "plugin",
      defaultSource: "gemini",
      directory: path.join(configDir, "plugins"),
    }),
    scanPluginSkillsDirectory({
      defaultScope: "plugin",
      defaultSource: "gemini",
      directory: path.join(cliDir, "plugins"),
    }),
  ];

  const systemSkillPromises = [
    scanSkillRoot({
      directory: path.join(cliDir, "builtin", "skills"),
      scope: "system",
      source: "gemini",
    }),
  ];

  const [
    projectSkillResults,
    userSkillResults,
    projectPluginResults,
    userPluginResults,
    systemSkillResults,
  ] = await Promise.all([
    Promise.all(projectSkillPromises),
    Promise.all(userSkillPromises),
    Promise.all(projectPluginPromises),
    Promise.all(userPluginPromises),
    Promise.all(systemSkillPromises),
  ]);

  const projectSkills = projectSkillResults.flat();
  const userSkills = userSkillResults.flat();
  const pluginSkills = [
    ...projectPluginResults.flat(),
    ...userPluginResults.flat(),
  ];
  const systemSkills = systemSkillResults.flat();

  const combined = [
    ...projectSkills,
    ...userSkills,
    ...pluginSkills,
    ...systemSkills,
  ];

  const deduped = dedupeSkillsByName(combined);
  return { errors: [], skills: sortSkills(deduped) };
};
