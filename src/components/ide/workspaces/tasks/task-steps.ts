import type { TaskStepId } from "@/types/ide";

export type TaskStepLabelKey =
  | "columnBacklog"
  | "columnPlan"
  | "columnBuild"
  | "columnReview"
  | "columnMerge";

export interface TaskStepDescriptor {
  id: TaskStepId;
  /** Key inside the `tasks` i18n namespace. */
  labelKey: TaskStepLabelKey;
}

export const TASK_STEPS: readonly TaskStepDescriptor[] = [
  { id: "backlog", labelKey: "columnBacklog" },
  { id: "plan", labelKey: "columnPlan" },
  { id: "build", labelKey: "columnBuild" },
  { id: "review", labelKey: "columnReview" },
  { id: "merge", labelKey: "columnMerge" },
];

export const TASK_STEP_LABEL_KEYS = {
  backlog: "columnBacklog",
  build: "columnBuild",
  merge: "columnMerge",
  plan: "columnPlan",
  review: "columnReview",
} as const satisfies Record<TaskStepId, TaskStepLabelKey>;
