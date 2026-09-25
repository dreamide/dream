/**
 * Provider skill catalog.
 *
 * Dream never injects SKILL.md content into prompts. Skills are discovered
 * so the composer can offer them and so the send-time dispatch can rewrite a
 * `$name` mention into the syntax each agent expands natively.
 */

import { onCodexSkillsChanged } from "../chat/codex-app-server-client.js";
import { discoverClaudeSkills } from "./claude-skills.js";
import { discoverCodexSkills } from "./codex-skills.js";
import { discoverCursorSkills } from "./cursor-skills.js";
import { discoverOpenCodeSkills } from "./opencode-skills.js";

const CACHE_TTL_MS = 30_000;
const cache = new Map();

const cacheKey = (provider, projectPath) =>
  `${provider}::${projectPath ? projectPath.trim() : ""}`;

const DISCOVERERS = {
  anthropic: discoverClaudeSkills,
  cursor: discoverCursorSkills,
  openai: discoverCodexSkills,
  opencode: discoverOpenCodeSkills,
};

export const SKILL_PROVIDERS = Object.keys(DISCOVERERS);

export const invalidateSkillCache = (provider) => {
  if (!provider) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${provider}::`)) {
      cache.delete(key);
    }
  }
};

onCodexSkillsChanged(() => invalidateSkillCache("openai"));

/**
 * @returns {Promise<{ provider: string, skills: ProviderSkill[], errors: string[] }>}
 */
export const listProviderSkills = async ({
  force = false,
  mcpServers = [],
  projectPath,
  provider,
}) => {
  const discover = DISCOVERERS[provider];
  if (!discover) {
    return { errors: [], provider, skills: [] };
  }

  const key = cacheKey(provider, projectPath);
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached?.pending) {
    return cached.pending;
  }

  const pending = discover({ mcpServers, projectPath })
    .then((result) => {
      const value = {
        errors: result.errors ?? [],
        provider,
        skills: (result.skills ?? []).map((skill) => ({ ...skill, provider })),
      };
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((error) => {
      cache.delete(key);
      return {
        errors: [error instanceof Error ? error.message : String(error)],
        provider,
        skills: [],
      };
    });
  cache.set(key, { at: cached?.at ?? 0, pending, value: cached?.value });
  return pending;
};
