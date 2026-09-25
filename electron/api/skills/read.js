/**
 * Reads a skill's SKILL.md (or command file) for the settings preview.
 *
 * Only files the provider's own discovery listed can be read, so the route
 * cannot be pointed at arbitrary paths.
 */

import path from "node:path";
import { parseFrontMatter } from "./frontmatter.js";
import { listProviderSkills } from "./index.js";
import { readTextFileIfSmall } from "./scan.js";

const samePath = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

export const readSkillFile = async ({
  mcpServers = [],
  projectPath,
  provider,
  skillPath,
}) => {
  if (!skillPath) {
    throw new Error("This skill has no file to preview.");
  }
  const { skills } = await listProviderSkills({
    mcpServers,
    projectPath,
    provider,
  });
  const known = skills.find(
    (skill) => skill.path && samePath(skill.path, skillPath),
  );
  if (!known) {
    throw new Error("That file is not one of this provider's skills.");
  }

  const text = await readTextFileIfSmall(known.path);
  if (text === null) {
    throw new Error("The skill file could not be read.");
  }
  const { attributes, body } = parseFrontMatter(text);
  return { attributes, body, path: known.path, text };
};
