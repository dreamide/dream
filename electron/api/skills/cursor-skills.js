/**
 * Cursor skill discovery.
 *
 * Cursor reads `.cursor/skills` and `.agents/skills` natively and, for
 * compatibility, `.claude/skills` and `.codex/skills`, in both the project
 * and the home directory. Project roots are walked recursively so nested
 * packages (`apps/web/.cursor/skills`) are found too.
 */

import path from "node:path";
import {
  dedupeSkillsByName,
  getHomeDirectory,
  scanSkillRoot,
  sortSkills,
} from "./scan.js";

const CURSOR_SKILL_ROOTS = [
  { directory: [".cursor", "skills"], source: "cursor" },
  { directory: [".agents", "skills"], source: "agents" },
  { directory: [".claude", "skills"], source: "claude" },
  { directory: [".codex", "skills"], source: "codex" },
];

export const discoverCursorSkills = async ({ projectPath } = {}) => {
  const home = getHomeDirectory();
  const roots = [];

  if (projectPath) {
    for (const root of CURSOR_SKILL_ROOTS) {
      roots.push(
        scanSkillRoot({
          directory: path.join(projectPath, ...root.directory),
          maxDepth: 2,
          scope: "project",
          source: root.source,
        }),
      );
    }
  }
  for (const root of CURSOR_SKILL_ROOTS) {
    roots.push(
      scanSkillRoot({
        directory: path.join(home, ...root.directory),
        scope: "user",
        source: root.source,
      }),
    );
  }

  const results = await Promise.all(roots);
  return { errors: [], skills: sortSkills(dedupeSkillsByName(results.flat())) };
};
