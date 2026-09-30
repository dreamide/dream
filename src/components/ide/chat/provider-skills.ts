// The provider's skill catalog: which skills a provider can load for a
// project, fetched from the main process and cached briefly. How skills are
// mentioned in the composer's text lives in composer-draft.ts.
import type { AiProvider, ProviderSkillsResponse } from "@/types/ide";
import { getProviderCapabilities } from "../../../../electron/shared/provider-capabilities.js";

/** Providers whose CLIs load Agent Skills (see provider-capabilities.js). */
export const providerSupportsSkills = (provider: AiProvider) =>
  getProviderCapabilities(provider).skills !== null;

type SkillCacheEntry = {
  at: number;
  pending: Promise<ProviderSkillsResponse> | null;
  value: ProviderSkillsResponse | null;
};

const SKILL_CACHE_TTL_MS = 30_000;
const skillCache = new Map<string, SkillCacheEntry>();
const skillCacheListeners = new Set<() => void>();

const cacheKey = (provider: AiProvider, projectPath: string) =>
  `${provider}::${projectPath}`;

const notifySkillCacheListeners = () => {
  for (const listener of skillCacheListeners) {
    listener();
  }
};

export const subscribeToProviderSkills = (listener: () => void) => {
  skillCacheListeners.add(listener);
  return () => {
    skillCacheListeners.delete(listener);
  };
};

export const getCachedProviderSkills = (
  provider: AiProvider,
  projectPath: string,
) => skillCache.get(cacheKey(provider, projectPath))?.value ?? null;

export const fetchProviderSkills = async (
  provider: AiProvider,
  projectPath: string,
  { force = false }: { force?: boolean } = {},
): Promise<ProviderSkillsResponse> => {
  const empty: ProviderSkillsResponse = { errors: [], provider, skills: [] };
  if (!providerSupportsSkills(provider)) {
    return empty;
  }

  const key = cacheKey(provider, projectPath);
  const cached = skillCache.get(key);
  if (!force && cached?.value && Date.now() - cached.at < SKILL_CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached?.pending && !force) {
    return cached.pending;
  }

  const pending = (async () => {
    try {
      const response = await fetch("/api/skills", {
        body: JSON.stringify({ force, projectPath, provider }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        return empty;
      }
      const payload = (await response.json()) as ProviderSkillsResponse;
      return {
        errors: Array.isArray(payload.errors) ? payload.errors : [],
        provider,
        skills: Array.isArray(payload.skills) ? payload.skills : [],
      };
    } catch {
      return empty;
    }
  })();

  skillCache.set(key, {
    at: cached?.at ?? 0,
    pending,
    value: cached?.value ?? null,
  });
  const value = await pending;
  skillCache.set(key, { at: Date.now(), pending: null, value });
  notifySkillCacheListeners();
  return value;
};

export const invalidateProviderSkills = () => {
  skillCache.clear();
  notifySkillCacheListeners();
};
