/**
 * Antigravity skill discovery.
 *
 * Antigravity CLI (`agy`) loads skills from:
 * - Project roots: `.gemini/skills`, `.agents/skills` (and aliases `.agent/`, `_agents/`, `_agent/`),
 *   plus project plugins in the same directories.
 * - User roots: `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills`,
 *   `~/.agents/skills`, and user plugins under `~/.gemini/config/plugins` and `~/.gemini/antigravity-cli/plugins`.
 * - System roots: `~/.gemini/antigravity-cli/builtin/skills`.
 *
 * Precedence order: project > user > plugin > system.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  collectProjectAncestors,
  directoryExists,
  getHomeDirectory,
  readTextFileIfSmall,
  scanSkillRoot,
  sortSkills,
} from "./scan.js";

const WORKSPACE_SKILL_ROOTS = [
  { directory: [".gemini", "skills"], source: "gemini" },
  { directory: [".agents", "skills"], source: "agents" },
  { directory: [".agent", "skills"], source: "agents" },
  { directory: ["_agents", "skills"], source: "agents" },
  { directory: ["_agent", "skills"], source: "agents" },
];

const WORKSPACE_PLUGIN_ROOTS = [
  { directory: [".gemini", "plugins"], source: "gemini" },
  { directory: [".agents", "plugins"], source: "agents" },
  { directory: [".agent", "plugins"], source: "agents" },
  { directory: ["_agents", "plugins"], source: "agents" },
  { directory: ["_agent", "plugins"], source: "agents" },
];

const PLUGIN_MANIFEST_FILENAMES = [
  [".antigravity-plugin", "plugin.json"],
  [".gemini-plugin", "plugin.json"],
  ["plugin.json"],
];

export const getAntigravityConfigDirectory = () =>
  process.env.ANTIGRAVITY_CONFIG_DIR?.trim() ||
  process.env.GEMINI_CONFIG_DIR?.trim() ||
  path.join(getHomeDirectory(), ".gemini", "config");

export const getAntigravityCliDirectory = () =>
  process.env.ANTIGRAVITY_CLI_DIR?.trim() ||
  process.env.GEMINI_CLI_DIR?.trim() ||
  path.join(getHomeDirectory(), ".gemini", "antigravity-cli");

export const readAntigravityConfig = async (configDir) => {
  const configPath = path.join(configDir, "config.json");
  const text = await readTextFileIfSmall(configPath);
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

const readPluginManifest = async (pluginDir) => {
  for (const relativePath of PLUGIN_MANIFEST_FILENAMES) {
    const manifestPath = path.join(pluginDir, ...relativePath);
    const text = await readTextFileIfSmall(manifestPath);
    if (text !== null) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      } catch {
        // Continue checking fallback manifest paths
      }
    }
  }
  return null;
};

export const scanPluginSkillsDirectory = async ({
  config,
  defaultScope = "plugin",
  defaultSource = "gemini",
  directory,
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

    let enabled = true;
    const configPlugin = config?.plugins?.[pluginId];
    if (typeof configPlugin?.enabled === "boolean") {
      enabled = configPlugin.enabled;
    } else {
      const manifest = await readPluginManifest(pluginDir);
      if (manifest?.disabled === true) {
        enabled = false;
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
        enabled: enabled ? skill.enabled : false,
        pluginId,
        scope: defaultScope,
      });
    }
  }

  return pluginSkills;
};

/**
 * Deduplicates Antigravity skills preserving precedence (project > user > plugin > system).
 * Plugin skills are identified by pluginId and skill name so distinct plugins can offer
 * the same skill name without colliding with each other or global/workspace skills.
 */
export const dedupeAntigravitySkills = (skills) => {
  const seen = new Set();
  const deduped = [];
  for (const skill of skills) {
    const key = skill.pluginId
      ? `plugin:${skill.pluginId.toLowerCase()}:${skill.name.toLowerCase()}`
      : skill.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(skill);
    }
  }
  return deduped;
};

export const discoverAntigravitySkills = async ({ projectPath } = {}) => {
  const home = getHomeDirectory();
  const configDir = getAntigravityConfigDirectory();
  const cliDir = getAntigravityCliDirectory();
  const config = await readAntigravityConfig(configDir);

  const ancestors = projectPath
    ? await collectProjectAncestors(projectPath)
    : [];

  const projectSkillPromises = [];
  const projectPluginPromises = [];

  for (const ancestor of ancestors) {
    for (const root of WORKSPACE_SKILL_ROOTS) {
      projectSkillPromises.push(
        scanSkillRoot({
          directory: path.join(ancestor, ...root.directory),
          scope: "project",
          source: root.source,
        }),
      );
    }

    for (const root of WORKSPACE_PLUGIN_ROOTS) {
      projectPluginPromises.push(
        scanPluginSkillsDirectory({
          config,
          defaultScope: "plugin",
          defaultSource: root.source,
          directory: path.join(ancestor, ...root.directory),
        }),
      );
    }
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
      directory: path.join(home, ".gemini", "skills"),
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
      config,
      defaultScope: "plugin",
      defaultSource: "gemini",
      directory: path.join(configDir, "plugins"),
    }),
    scanPluginSkillsDirectory({
      config,
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

  return { errors: [], skills: sortSkills(dedupeAntigravitySkills(combined)) };
};
