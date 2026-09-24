import type { ProjectConfig } from "@/types/ide";

/** Placeholders a task's prompt can use, filled from the project it runs in. */
export const TASK_PROMPT_VARIABLES = [
  "project.name",
  "project.path",
  "branch",
  "baseRef",
] as const;

export type TaskPromptVariable = (typeof TASK_PROMPT_VARIABLES)[number];

export interface RenderTaskPromptInput {
  /** The checked-out branch, when known. */
  branch?: string | null;
  project: Pick<ProjectConfig, "name" | "path" | "worktree">;
  prompt: string;
}

/**
 * Fills `{{variable}}` placeholders from the project the task runs in.
 * Anything else in braces is left as written, so a prompt can talk about
 * templates without them disappearing.
 */
export const renderTaskPrompt = ({
  branch,
  project,
  prompt,
}: RenderTaskPromptInput): string => {
  const values: Record<TaskPromptVariable, string> = {
    baseRef: project.worktree?.baseRef?.trim() || "the base branch",
    branch:
      branch?.trim() ||
      project.worktree?.branch?.trim() ||
      "the current branch",
    "project.name": project.name,
    "project.path": project.path,
  };

  return prompt
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) =>
      Object.hasOwn(values, name) ? values[name as TaskPromptVariable] : match,
    )
    .trim();
};
