/**
 * Codex skill discovery.
 *
 * The app-server owns the catalog (`skills/list`), including bundled system
 * skills, plugin skills and `[[skills.config]]` enable/disable state, so it
 * is asked first. When it cannot be started the documented directories are
 * scanned instead: `.agents/skills` from the working directory up to the
 * repository root, `~/.agents/skills`, the legacy `~/.codex/skills`, and
 * `/etc/codex/skills`.
 */

import path from "node:path";
import { getCodexAppServerClient } from "../chat/codex-app-server-client.js";
import {
  collectProjectAncestors,
  dedupeSkillsByName,
  getHomeDirectory,
  scanSkillRoot,
  sortSkills,
} from "./scan.js";

const asString = (value) => (typeof value === "string" ? value.trim() : "");

const mapCodexScope = (scope) => {
  switch (asString(scope).toLowerCase()) {
    case "repo":
    case "project":
      return "project";
    case "user":
      return "user";
    case "admin":
      return "admin";
    case "system":
      return "system";
    default:
      return "user";
  }
};

export const parseCodexSkillsListResponse = (response, cwd) => {
  const entries = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.skills)
      ? [{ cwd, errors: response.errors, skills: response.skills }]
      : [];

  const normalizedCwd = cwd ? path.resolve(cwd) : null;
  const matching =
    entries.find(
      (entry) =>
        normalizedCwd &&
        typeof entry?.cwd === "string" &&
        path.resolve(entry.cwd) === normalizedCwd,
    ) ?? null;
  const selected = matching ? [matching] : entries;

  const skills = [];
  const errors = [];
  for (const entry of selected) {
    for (const raw of Array.isArray(entry?.skills) ? entry.skills : []) {
      const name = asString(raw?.name);
      const skillPath = asString(raw?.path);
      if (!name) {
        continue;
      }
      const scope = mapCodexScope(raw?.scope);
      skills.push({
        argumentHint: undefined,
        description:
          asString(raw?.description) || asString(raw?.shortDescription),
        directory: skillPath ? path.dirname(skillPath) : "",
        displayName: asString(raw?.interface?.displayName) || undefined,
        enabled: raw?.enabled !== false,
        kind: "skill",
        name,
        path: skillPath,
        pluginId: asString(raw?.pluginId) || undefined,
        scope: raw?.pluginId ? "plugin" : scope,
        shortDescription: asString(raw?.shortDescription) || undefined,
        source: "codex",
        userInvocable: undefined,
        userInvocationOnly:
          raw?.policy?.allowImplicitInvocation === false ? true : undefined,
      });
    }
    for (const error of Array.isArray(entry?.errors) ? entry.errors : []) {
      const message = asString(error?.message) || asString(error);
      if (message) {
        errors.push(message);
      }
    }
  }

  return { errors, skills: sortSkills(dedupeSkillsByName(skills)) };
};

export const scanCodexSkillDirectories = async ({ projectPath } = {}) => {
  const home = getHomeDirectory();
  const ancestors = projectPath
    ? await collectProjectAncestors(projectPath)
    : [];

  const roots = ancestors.map((directory) =>
    scanSkillRoot({
      directory: path.join(directory, ".agents", "skills"),
      maxDepth: 2,
      scope: "project",
      source: "agents",
    }),
  );
  roots.push(
    scanSkillRoot({
      directory: path.join(home, ".agents", "skills"),
      scope: "user",
      source: "agents",
    }),
    scanSkillRoot({
      directory: path.join(home, ".codex", "skills"),
      scope: "user",
      source: "codex",
    }),
  );
  if (process.platform !== "win32") {
    roots.push(
      scanSkillRoot({
        directory: "/etc/codex/skills",
        scope: "admin",
        source: "codex",
      }),
    );
  }

  const results = await Promise.all(roots);
  return { errors: [], skills: sortSkills(dedupeSkillsByName(results.flat())) };
};

export const discoverCodexSkills = async ({
  mcpServers = [],
  projectPath,
} = {}) => {
  try {
    const client = await getCodexAppServerClient({ mcpServers });
    const response = await client.sendRequest("skills/list", {
      ...(projectPath ? { cwds: [projectPath] } : {}),
    });
    return parseCodexSkillsListResponse(response, projectPath);
  } catch (error) {
    const fallback = await scanCodexSkillDirectories({ projectPath });
    return {
      ...fallback,
      errors: [
        `Codex app-server skills/list failed; listed skill folders directly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
};
