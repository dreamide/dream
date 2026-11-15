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

/** Each request goes to `hostId`: the Host whose skills are shown. */
export const createSkillRequest = async (
  input: ApiRequestOf<"createSkill">,
  hostId: string,
) => {
  const result = await skillRequest(
    apiClient.createSkill(input, { hostId }),
    "Creating the skill failed.",
  );
  invalidateProviderSkills();
  return result;
};

export const setSkillEnabledRequest = async (
  input: ApiRequestOf<"setSkillEnabled">,
  hostId: string,
) => {
  await skillRequest(
    apiClient.setSkillEnabled(input, { hostId }),
    "Updating the skill failed.",
  );
  invalidateProviderSkills();
};

export type { SkillFileContents } from "@/lib/api-client";

export const readSkillFileRequest = (
  input: ApiRequestOf<"readSkill">,
  hostId: string,
) =>
  skillRequest(
    apiClient.readSkill(input, { hostId }),
    "Reading the skill failed.",
  );

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
