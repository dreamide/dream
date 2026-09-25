import type {
  AiProvider,
  ProviderSkill,
  ProviderSkillsResponse,
} from "@/types/ide";

export const SKILL_RESULT_LIMIT = 50;

/** Providers whose CLIs load Agent Skills. */
export const SKILL_PROVIDER_SUPPORT: Record<AiProvider, boolean> = {
  anthropic: true,
  cursor: true,
  grok: false,
  openai: true,
  opencode: true,
};

export const providerSupportsSkills = (provider: AiProvider) =>
  SKILL_PROVIDER_SUPPORT[provider] ?? false;

/**
 * `$name` mentions. Leaves currency amounts (`$50`, `$1.2k`) as prose: the
 * name must contain a letter and may not start with a digit.
 */
export const SKILL_MENTION_PATTERN =
  /(^|[\s([{])\$(?![0-9])([a-zA-Z0-9][a-zA-Z0-9:_-]*[a-zA-Z0-9]|[a-zA-Z])(?=$|[\s),.;:!?\]}])/g;

export type ActiveSkillToken = {
  end: number;
  query: string;
  start: number;
};

/**
 * The `$query` token the caret is inside, if any. Mirrors the `@` file
 * mention rule: the `$` must start the text or follow whitespace/bracket.
 */
export const getActiveSkillToken = (
  text: string,
  caretIndex: number,
): ActiveSkillToken | null => {
  const beforeCaret = text.slice(0, caretIndex);
  const dollarIndex = beforeCaret.lastIndexOf("$");
  if (dollarIndex === -1) {
    return null;
  }

  const characterBefore =
    dollarIndex > 0 ? beforeCaret.at(dollarIndex - 1) : "";
  if (characterBefore && !/\s|[([{]/.test(characterBefore)) {
    return null;
  }

  const query = beforeCaret.slice(dollarIndex + 1);
  if (/\s/.test(query) || /^[0-9]/.test(query)) {
    return null;
  }
  if (!/^[a-zA-Z0-9:_-]*$/.test(query)) {
    return null;
  }

  return { end: caretIndex, query, start: dollarIndex };
};

/** What the menu shows: the provider's display name when it has one. */
export const getSkillLabel = (skill: ProviderSkill) =>
  skill.displayName?.trim() || skill.name;

export const isSkillOfferedInMenu = (skill: ProviderSkill) =>
  skill.enabled && skill.userInvocable !== false;

const getSkillScore = (skill: ProviderSkill, query: string) => {
  if (!query) {
    return 0;
  }

  const normalizedQuery = query.toLowerCase();
  const name = skill.name.toLowerCase();
  const displayName = (skill.displayName ?? "").toLowerCase();
  const description = (
    skill.shortDescription ??
    skill.description ??
    ""
  ).toLowerCase();

  if (name === normalizedQuery) {
    return 0;
  }
  if (name.startsWith(normalizedQuery)) {
    return 1;
  }
  if (displayName.startsWith(normalizedQuery)) {
    return 2;
  }
  if (name.includes(normalizedQuery) || displayName.includes(normalizedQuery)) {
    return 3;
  }
  if (description.includes(normalizedQuery)) {
    return 4;
  }
  return null;
};

export const searchProviderSkills = (
  skills: ProviderSkill[],
  query: string,
  limit = SKILL_RESULT_LIMIT,
) =>
  skills
    .filter(isSkillOfferedInMenu)
    .flatMap((skill) => {
      const score = getSkillScore(skill, query);
      return score === null ? [] : [{ score, skill }];
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        getSkillLabel(left.skill).localeCompare(getSkillLabel(right.skill)),
    )
    .slice(0, limit)
    .map(({ skill }) => skill);

export type SkillMentionRange = {
  end: number;
  name: string;
  skill: ProviderSkill;
  start: number;
};

/**
 * `$name` ranges in `text` whose name matches a known skill.
 */
export const findSkillMentions = (
  text: string,
  skills: ProviderSkill[],
): SkillMentionRange[] => {
  if (!text || skills.length === 0) {
    return [];
  }

  const byName = new Map(
    skills.map((skill) => [skill.name.toLowerCase(), skill] as const),
  );
  const ranges: SkillMentionRange[] = [];
  const pattern = new RegExp(SKILL_MENTION_PATTERN.source, "g");
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const name = match[2];
    const skill = byName.get(name.toLowerCase());
    if (skill) {
      const start = match.index + match[1].length;
      ranges.push({ end: start + name.length + 1, name, skill, start });
    }
    match = pattern.exec(text);
  }
  return ranges;
};

export const hasPossibleSkillMention = (text: string) =>
  new RegExp(SKILL_MENTION_PATTERN.source).test(text);

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
