import type { PipelineStepId } from "@/types/ide";

export type PipelineStepLabelKey =
  | "columnBacklog"
  | "columnPlan"
  | "columnBuild"
  | "columnReview"
  | "columnMerge";

export interface PipelineStepDescriptor {
  id: PipelineStepId;
  /** Key inside the `pipeline` i18n namespace. */
  labelKey: PipelineStepLabelKey;
}

export const PIPELINE_STEPS: readonly PipelineStepDescriptor[] = [
  { id: "backlog", labelKey: "columnBacklog" },
  { id: "plan", labelKey: "columnPlan" },
  { id: "build", labelKey: "columnBuild" },
  { id: "review", labelKey: "columnReview" },
  { id: "merge", labelKey: "columnMerge" },
];

export const PIPELINE_STEP_LABEL_KEYS = {
  backlog: "columnBacklog",
  build: "columnBuild",
  merge: "columnMerge",
  plan: "columnPlan",
  review: "columnReview",
} as const satisfies Record<PipelineStepId, PipelineStepLabelKey>;
