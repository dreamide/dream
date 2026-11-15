import { apiClient } from "@/lib/api-client";
// The provider's skill catalog: which skills a provider can load for a
// project on its Host, fetched from that Host and cached briefly. How skills
// are mentioned in the composer's text lives in composer-draft.ts.
import type { ProjectScope } from "@/lib/project-resource-cache";
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

// The same path on two Hosts is two projects, with two catalogs.
const cacheKey = (
  provider: AiProvider,
  { hostId, projectPath }: ProjectScope,
) => `${provider}\0${hostId}\0${projectPath}`;

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
  scope: ProjectScope,
) => skillCache.get(cacheKey(provider, scope))?.value ?? null;

/** The catalog for `scope`: the project's path on its Host (`projectScope`). */
export const fetchProviderSkills = async (
  provider: AiProvider,
  scope: ProjectScope,
  { force = false }: { force?: boolean } = {},
): Promise<ProviderSkillsResponse> => {
  const empty: ProviderSkillsResponse = { errors: [], provider, skills: [] };
  if (!providerSupportsSkills(provider)) {
    return empty;
  }

  const key = cacheKey(provider, scope);
  const cached = skillCache.get(key);
  if (!force && cached?.value && Date.now() - cached.at < SKILL_CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached?.pending && !force) {
    return cached.pending;
  }

  const pending = (async () => {
    try {
      const payload = await apiClient.skills(
        { force, projectPath: scope.projectPath, provider },
        { hostId: scope.hostId },
      );
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
