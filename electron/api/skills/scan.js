/**
 * Filesystem discovery for Agent Skills (SKILL.md folders) and Claude-style
 * command files (`commands/<name>.md`).
 *
 * Every provider ends up with the same `ProviderSkill` shape so the renderer
 * and the send-time dispatch never need provider-specific parsing.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontMatter, summarizeMarkdownBody } from "./frontmatter.js";

export const SKILL_FILE_NAME = "SKILL.md";
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_SKILLS_PER_ROOT = 500;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".trash",
  "node_modules",
  "scripts",
  "references",
  "assets",
]);

export const getHomeDirectory = () =>
  process.env.DREAM_SKILLS_HOME ||
  process.env.HOME ||
  process.env.USERPROFILE ||
  os.homedir();

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asString = (value) => (typeof value === "string" ? value.trim() : "");

const asBoolean = (value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["true", "yes", "on"].includes(lower)) {
      return true;
    }
    if (["false", "no", "off"].includes(lower)) {
      return false;
    }
  }
  return undefined;
};

export const readTextFileIfSmall = async (filePath) => {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) {
      return null;
    }
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
};

export const directoryExists = async (directory) => {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Walks from `startDirectory` upwards and returns every directory up to and
 * including the repository root (the first ancestor holding `.git`). When no
 * repository is found only `startDirectory` is returned.
 */
export const collectProjectAncestors = async (startDirectory) => {
  const start = path.resolve(startDirectory);
  const ancestors = [];
  let current = start;
  for (;;) {
    ancestors.push(current);
    let hasGit = false;
    try {
      await fs.stat(path.join(current, ".git"));
      hasGit = true;
    } catch {
      hasGit = false;
    }
    if (hasGit) {
      return ancestors;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return [start];
    }
    current = parent;
  }
};

/**
 * Builds a ProviderSkill from a SKILL.md (or command .md) file.
 */
export const buildSkillFromFile = ({
  filePath,
  text,
  scope,
  source,
  kind = "skill",
  nameOverride,
}) => {
  const { attributes, body } = parseFrontMatter(text);
  const directory = path.dirname(filePath);
  const directoryName = path.basename(directory);
  const frontMatterName = asString(attributes.name);
  const name =
    nameOverride ||
    (kind === "command"
      ? path.basename(filePath, path.extname(filePath))
      : directoryName || frontMatterName);
  if (!name) {
    return null;
  }

  const description =
    asString(attributes.description) || summarizeMarkdownBody(body);
  const metadata = isRecord(attributes.metadata) ? attributes.metadata : {};
  const disableModelInvocation = asBoolean(
    attributes["disable-model-invocation"],
  );
  const userInvocable = asBoolean(attributes["user-invocable"]);
  const autoInvoke = asBoolean(metadata["opencode/autoinvoke"]);

  return {
    argumentHint: asString(attributes["argument-hint"]) || undefined,
    description,
    directory,
    displayName:
      frontMatterName && frontMatterName !== name ? frontMatterName : undefined,
    enabled: true,
    kind,
    name,
    path: filePath,
    scope,
    source,
    userInvocable: userInvocable === false ? false : undefined,
    userInvocationOnly:
      disableModelInvocation === true || autoInvoke === false
        ? true
        : undefined,
  };
};

/**
 * Finds `<root>/**\/SKILL.md` up to `maxDepth` directory levels below root.
 * Depth 1 is the standard `<root>/<name>/SKILL.md` layout; deeper levels
 * cover synced (`synced/<id>/<name>`) and nested (`apps/web/.cursor/skills`)
 * layouts used by some clients.
 */
export const scanSkillRoot = async ({
  directory,
  scope,
  source,
  maxDepth = 3,
}) => {
  const root = path.resolve(directory);
  if (!(await directoryExists(root))) {
    return [];
  }

  const skills = [];
  const queue = [{ depth: 0, directory: root }];

  while (queue.length > 0 && skills.length < MAX_SKILLS_PER_ROOT) {
    const current = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    const skillFile = entries.find(
      (entry) => entry.isFile() && entry.name === SKILL_FILE_NAME,
    );
    if (skillFile && current.depth > 0) {
      const filePath = path.join(current.directory, SKILL_FILE_NAME);
      const text = await readTextFileIfSmall(filePath);
      if (text !== null) {
        const skill = buildSkillFromFile({ filePath, scope, source, text });
        if (skill) {
          skills.push(skill);
        }
      }
      // A skill folder's subdirectories are resources, not more skills.
      continue;
    }

    if (current.depth >= maxDepth) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      queue.push({
        depth: current.depth + 1,
        directory: path.join(current.directory, entry.name),
      });
    }
  }

  return skills;
};

/**
 * Finds Claude-style command files: `<root>/<name>.md` and one level of
 * namespace folders (`<root>/<group>/<name>.md`).
 */
export const scanCommandRoot = async ({ directory, scope, source }) => {
  const root = path.resolve(directory);
  if (!(await directoryExists(root))) {
    return [];
  }

  const commands = [];
  const visit = async (currentDirectory, depth) => {
    let entries;
    try {
      entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) {
          await visit(entryPath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const text = await readTextFileIfSmall(entryPath);
      if (text === null) {
        continue;
      }
      const command = buildSkillFromFile({
        filePath: entryPath,
        kind: "command",
        scope,
        source,
        text,
      });
      if (command) {
        commands.push(command);
      }
    }
  };

  await visit(root, 0);
  return commands;
};

/**
 * Keeps the first skill seen for each name. Callers order their roots by
 * precedence so the winning root comes first.
 */
export const dedupeSkillsByName = (skills) => {
  const byName = new Map();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, skill);
    }
  }
  return [...byName.values()];
};

export const sortSkills = (skills) =>
  [...skills].sort((a, b) => a.name.localeCompare(b.name));
