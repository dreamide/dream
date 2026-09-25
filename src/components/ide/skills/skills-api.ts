import type { AiProvider } from "@/types/ide";
import { invalidateProviderSkills } from "../chat/provider-skills";

export type SkillTarget =
  | "project-agents"
  | "project-claude"
  | "user-agents"
  | "user-claude";

export const SKILL_TARGETS: SkillTarget[] = [
  "project-agents",
  "project-claude",
  "user-agents",
  "user-claude",
];

/** Which targets each provider actually reads. */
export const SKILL_TARGET_PROVIDERS: Record<SkillTarget, AiProvider[]> = {
  "project-agents": ["openai", "opencode", "cursor"],
  "project-claude": ["anthropic", "opencode", "cursor"],
  "user-agents": ["openai", "opencode", "cursor"],
  "user-claude": ["anthropic", "opencode", "cursor"],
};

export const SKILL_TOGGLE_PROVIDERS: AiProvider[] = ["anthropic", "openai"];

const readError = async (response: Response, fallback: string) => {
  const text = await response.text().catch(() => "");
  return new Error(text.trim() || fallback);
};

export const createSkillRequest = async (input: {
  body: string;
  description: string;
  name: string;
  projectPath?: string;
  targets: SkillTarget[];
  userInvocationOnly: boolean;
}) => {
  const response = await fetch("/api/skills/create", {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw await readError(response, "Creating the skill failed.");
  }
  invalidateProviderSkills();
  return (await response.json()) as { paths: string[] };
};

export const setSkillEnabledRequest = async (input: {
  enabled: boolean;
  name: string;
  path?: string;
  provider: AiProvider;
}) => {
  const response = await fetch("/api/skills/set-enabled", {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw await readError(response, "Updating the skill failed.");
  }
  invalidateProviderSkills();
};

export interface SkillFileContents {
  attributes: Record<string, unknown>;
  body: string;
  path: string;
  text: string;
}

export const readSkillFileRequest = async (input: {
  path: string;
  projectPath?: string;
  provider: AiProvider;
}): Promise<SkillFileContents> => {
  const response = await fetch("/api/skills/read", {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw await readError(response, "Reading the skill failed.");
  }
  return (await response.json()) as SkillFileContents;
};

export const toSkillName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

export const isValidSkillName = (value: string) =>
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && value.length <= 64;
