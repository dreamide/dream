import {
  type ApiRequestOf,
  apiClient,
  getApiErrorMessage,
} from "@/lib/api-client";
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

export const SKILL_TOGGLE_PROVIDERS: AiProvider[] = ["anthropic", "openai"];

/** A failed skill request, with the server's reason or `fallback`. */
const skillRequest = async <T>(
  request: Promise<T>,
  fallback: string,
): Promise<T> => {
  try {
    return await request;
  } catch (error) {
    throw new Error(getApiErrorMessage(error, fallback));
  }
};

export const createSkillRequest = async (
  input: ApiRequestOf<"createSkill">,
) => {
  const result = await skillRequest(
    apiClient.createSkill(input),
    "Creating the skill failed.",
  );
  invalidateProviderSkills();
  return result;
};

export const setSkillEnabledRequest = async (
  input: ApiRequestOf<"setSkillEnabled">,
) => {
  await skillRequest(
    apiClient.setSkillEnabled(input),
    "Updating the skill failed.",
  );
  invalidateProviderSkills();
};

export type { SkillFileContents } from "@/lib/api-client";

export const readSkillFileRequest = (input: ApiRequestOf<"readSkill">) =>
  skillRequest(apiClient.readSkill(input), "Reading the skill failed.");

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
