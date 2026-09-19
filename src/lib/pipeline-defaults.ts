import type {
  PipelineConfig,
  PipelineRunStepId,
  PipelineStepConfig,
  PipelineStepId,
  PipelineStepRun,
  PipelineTask,
} from "@/types/ide";

export const PIPELINE_STEP_IDS = [
  "backlog",
  "plan",
  "build",
  "review",
  "merge",
] as const satisfies readonly PipelineStepId[];

export const PIPELINE_RUN_STEP_IDS = [
  "plan",
  "build",
  "review",
  "merge",
] as const satisfies readonly PipelineRunStepId[];

export const isPipelineStepId = (value: unknown): value is PipelineStepId =>
  typeof value === "string" &&
  (PIPELINE_STEP_IDS as readonly string[]).includes(value);

export const isPipelineRunStepId = (
  value: unknown,
): value is PipelineRunStepId =>
  typeof value === "string" &&
  (PIPELINE_RUN_STEP_IDS as readonly string[]).includes(value);

/** The step after `step`, or `null` when `step` is the last one. */
export const getNextPipelineStep = (
  step: PipelineStepId,
): PipelineRunStepId | null => {
  const index = PIPELINE_STEP_IDS.indexOf(step);
  const next = PIPELINE_STEP_IDS[index + 1];
  return next && next !== "backlog" ? next : null;
};

/** Run steps strictly before `step`, in pipeline order. */
export const getEarlierPipelineRunSteps = (
  step: PipelineStepId,
): PipelineRunStepId[] => {
  const index = PIPELINE_STEP_IDS.indexOf(step);
  return PIPELINE_RUN_STEP_IDS.filter(
    (entry) => PIPELINE_STEP_IDS.indexOf(entry) < index,
  );
};

export const PIPELINE_OUTPUT_MAX_CHARS = 24_000;

export const DEFAULT_PIPELINE_PROMPTS: Record<PipelineRunStepId, string> = {
  plan: `You are the planning step of a task pipeline.

# {{task.title}}
{{task.description}}

{{feedback}}

Explore the repository and produce a concrete implementation plan: the files to change, the changes to make, tests to add or update, and risks. Do not modify any files. Do not call ExitPlanMode. End your reply with the complete plan as your final message, because the next step only sees that message.`,
  build: `You are the build step of a task pipeline. Implement this task in the current working tree (branch {{branch}}).

# {{task.title}}
{{task.description}}

## Plan
{{plan.output}}

{{feedback}}

Run the project's tests and lint, commit your work, and finish with a summary of what changed and anything you could not verify.`,
  review: `You are the review step of a task pipeline. Review the changes on branch {{branch}} against {{baseRef}} for this task. Do not edit files.

# {{task.title}}
{{task.description}}

## Plan
{{plan.output}}

## Builder summary
{{previous.output}}

End with a verdict line, either APPROVE or CHANGES REQUESTED, followed by numbered findings that reference file:line.`,
  merge: `You are the merge-preparation step of a task pipeline. Prepare branch {{branch}} for merging into {{baseRef}}: commit any outstanding work, bring in the latest {{baseRef}}, resolve conflicts, and re-run the project's checks. Do NOT merge into {{baseRef}} and do NOT push.

# {{task.title}}

## Review notes
{{review.output}}

Finish with a short readiness summary.`,
};

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  plan: {
    agentMode: "plan",
    autoAdvance: false,
    model: null,
    permissionMode: "standard",
    prompt: null,
  },
  build: {
    agentMode: "build",
    autoAdvance: true,
    model: null,
    permissionMode: "full-access",
    prompt: null,
  },
  review: {
    agentMode: "plan",
    autoAdvance: false,
    model: null,
    permissionMode: "standard",
    prompt: null,
  },
  merge: {
    agentMode: "build",
    autoAdvance: false,
    model: null,
    permissionMode: "full-access",
    prompt: null,
  },
};

export const createDefaultPipelineConfig = (): PipelineConfig => ({
  plan: { ...DEFAULT_PIPELINE_CONFIG.plan },
  build: { ...DEFAULT_PIPELINE_CONFIG.build },
  review: { ...DEFAULT_PIPELINE_CONFIG.review },
  merge: { ...DEFAULT_PIPELINE_CONFIG.merge },
});

export const getPipelineStepPrompt = (
  step: PipelineRunStepId,
  config: Pick<PipelineStepConfig, "prompt">,
): string => {
  const custom = config.prompt?.trim();
  return custom ? (config.prompt ?? "") : DEFAULT_PIPELINE_PROMPTS[step];
};

export const PIPELINE_PROMPT_VARIABLES = [
  "task.title",
  "task.description",
  "previous.step",
  "previous.output",
  "plan.output",
  "review.output",
  "feedback",
  "branch",
  "baseRef",
] as const;

export type PipelinePromptVariable = (typeof PIPELINE_PROMPT_VARIABLES)[number];

/** Latest run of `step` that produced output. */
const getLatestOutput = (
  runs: PipelineStepRun[],
  step: PipelineRunStepId,
): string => {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run?.step === step && run.output) {
      return run.output;
    }
  }
  return "";
};

export interface RenderPipelinePromptInput {
  feedback?: string | null;
  /** The run handing off to this step, if any. */
  previousRun?: Pick<PipelineStepRun, "output" | "step"> | null;
  task: Pick<
    PipelineTask,
    "baseRef" | "branch" | "description" | "runs" | "title"
  >;
  template: string;
}

/**
 * Fills `{{variable}}` placeholders. Unknown or empty variables render as an
 * empty string. When the template never mentions `{{previous.output}}` but a
 * previous step produced output, a handoff block is appended so the context
 * is never silently dropped by a custom prompt.
 */
export const renderPipelinePrompt = ({
  feedback,
  previousRun,
  task,
  template,
}: RenderPipelinePromptInput): string => {
  const previousOutput = previousRun?.output?.trim() ?? "";
  const feedbackText = feedback?.trim() ?? "";
  const values: Record<PipelinePromptVariable, string> = {
    baseRef: task.baseRef ?? "the base branch",
    branch: task.branch ?? "the current branch",
    feedback: feedbackText ? `## Feedback to address\n${feedbackText}` : "",
    "plan.output": getLatestOutput(task.runs, "plan"),
    "previous.output": previousOutput,
    "previous.step": previousRun?.step ?? "",
    "review.output": getLatestOutput(task.runs, "review"),
    "task.description": task.description.trim(),
    "task.title": task.title.trim(),
  };

  const usedVariables = new Set<string>();
  let text = template.replace(
    /\{\{\s*([\w.]+)\s*\}\}/g,
    (_match, name: string) => {
      usedVariables.add(name);
      return Object.hasOwn(values, name)
        ? values[name as PipelinePromptVariable]
        : "";
    },
  );

  const previousStep = previousRun?.step;
  const previousAlreadyIncluded =
    usedVariables.has("previous.output") ||
    (previousStep === "plan" && usedVariables.has("plan.output")) ||
    (previousStep === "review" && usedVariables.has("review.output"));
  if (previousOutput && previousStep && !previousAlreadyIncluded) {
    text = `${text}\n\n## Handoff from ${previousStep}\n${previousOutput}`;
  }

  if (feedbackText && !usedVariables.has("feedback")) {
    text = `${text}\n\n${values.feedback}`;
  }

  return text.replace(/\n{3,}/g, "\n\n").trim();
};
