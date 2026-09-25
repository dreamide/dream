/**
 * OpenCode skill discovery.
 *
 * `opencode debug skill` prints the resolved catalog (built-ins, user and
 * project skills, with precedence already applied) as JSON, so it is the
 * source of truth. The SDK version Dream bundles has no skills endpoint yet.
 * When the CLI is unavailable the documented roots are scanned instead.
 */

import path from "node:path";
import { execCliCommand, isCliCommandAvailable } from "../shared/cli.js";
import {
  collectProjectAncestors,
  dedupeSkillsByName,
  getHomeDirectory,
  scanSkillRoot,
  sortSkills,
} from "./scan.js";

const asString = (value) => (typeof value === "string" ? value.trim() : "");

const isInside = (filePath, directory) => {
  const relative = path.relative(
    path.resolve(directory),
    path.resolve(filePath),
  );
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
};

const resolveOpenCodeScope = ({ location, projectPath, home }) => {
  if (!location || location === "<built-in>") {
    return "system";
  }
  if (projectPath && isInside(location, projectPath)) {
    return "project";
  }
  if (home && isInside(location, home)) {
    return "user";
  }
  return "project";
};

const resolveOpenCodeSource = (location) => {
  const normalized = location.replace(/\\/g, "/");
  if (normalized.includes("/.claude/")) {
    return "claude";
  }
  if (normalized.includes("/.agents/")) {
    return "agents";
  }
  return "opencode";
};

export const parseOpenCodeDebugSkills = (text, { home, projectPath } = {}) => {
  const start = text.indexOf("[");
  if (start < 0) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const skills = [];
  for (const raw of parsed) {
    const name = asString(raw?.name);
    if (!name) {
      continue;
    }
    const location = asString(raw?.location);
    const isFile = location.length > 0 && location !== "<built-in>";
    skills.push({
      argumentHint: undefined,
      description: asString(raw?.description),
      directory: isFile ? path.dirname(location) : "",
      displayName: undefined,
      enabled: true,
      kind: "skill",
      name,
      path: isFile ? location : "",
      scope: resolveOpenCodeScope({ home, location, projectPath }),
      source: isFile ? resolveOpenCodeSource(location) : "opencode",
      userInvocable: undefined,
      userInvocationOnly: undefined,
    });
  }
  return sortSkills(dedupeSkillsByName(skills));
};

export const scanOpenCodeSkillDirectories = async ({ projectPath } = {}) => {
  const home = getHomeDirectory();
  const ancestors = projectPath
    ? await collectProjectAncestors(projectPath)
    : [];

  const roots = [];
  for (const directory of ancestors) {
    roots.push(
      scanSkillRoot({
        directory: path.join(directory, ".opencode", "skills"),
        maxDepth: 2,
        scope: "project",
        source: "opencode",
      }),
    );
  }
  roots.push(
    scanSkillRoot({
      directory: path.join(home, ".config", "opencode", "skills"),
      scope: "user",
      source: "opencode",
    }),
  );
  for (const directory of ancestors) {
    roots.push(
      scanSkillRoot({
        directory: path.join(directory, ".claude", "skills"),
        maxDepth: 2,
        scope: "project",
        source: "claude",
      }),
      scanSkillRoot({
        directory: path.join(directory, ".agents", "skills"),
        maxDepth: 2,
        scope: "project",
        source: "agents",
      }),
    );
  }
  roots.push(
    scanSkillRoot({
      directory: path.join(home, ".claude", "skills"),
      scope: "user",
      source: "claude",
    }),
    scanSkillRoot({
      directory: path.join(home, ".agents", "skills"),
      scope: "user",
      source: "agents",
    }),
  );

  const results = await Promise.all(roots);
  return { errors: [], skills: sortSkills(dedupeSkillsByName(results.flat())) };
};

export const discoverOpenCodeSkills = async ({ projectPath } = {}) => {
  const installed = await isCliCommandAvailable("opencode");
  if (installed) {
    try {
      const result = await execCliCommand("opencode", ["debug", "skill"], {
        ...(projectPath ? { cwd: projectPath } : {}),
        maxBuffer: 20 * 1024 * 1024,
        timeout: 20_000,
      });
      const skills = parseOpenCodeDebugSkills(String(result.stdout ?? ""), {
        home: getHomeDirectory(),
        projectPath,
      });
      if (skills.length > 0) {
        return { errors: [], skills };
      }
    } catch (error) {
      const fallback = await scanOpenCodeSkillDirectories({ projectPath });
      return {
        ...fallback,
        errors: [
          `opencode debug skill failed; listed skill folders directly: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
  }
  return scanOpenCodeSkillDirectories({ projectPath });
};
