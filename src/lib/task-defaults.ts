import type {
  Task,
  TaskConfig,
  TaskRunStepId,
  TaskStepConfig,
  TaskStepId,
  TaskStepRun,
} from "@/types/ide";

export const TASK_STEP_IDS = [
  "backlog",
  "plan",
  "build",
  "review",
  "merge",
] as const satisfies readonly TaskStepId[];

export const TASK_RUN_STEP_IDS = [
  "plan",
  "build",
  "review",
  "merge",
] as const satisfies readonly TaskRunStepId[];

export const isTaskStepId = (value: unknown): value is TaskStepId =>
  typeof value === "string" &&
  (TASK_STEP_IDS as readonly string[]).includes(value);

export const isTaskRunStepId = (value: unknown): value is TaskRunStepId =>
  typeof value === "string" &&
  (TASK_RUN_STEP_IDS as readonly string[]).includes(value);

/** The step after `step`, or `null` when `step` is the last one. */
export const getNextTaskStep = (step: TaskStepId): TaskRunStepId | null => {
  const index = TASK_STEP_IDS.indexOf(step);
  const next = TASK_STEP_IDS[index + 1];
  return next && next !== "backlog" ? next : null;
};

/** Run steps strictly before `step`, in step order. */
export const getEarlierTaskRunSteps = (step: TaskStepId): TaskRunStepId[] => {
  const index = TASK_STEP_IDS.indexOf(step);
  return TASK_RUN_STEP_IDS.filter(
    (entry) => TASK_STEP_IDS.indexOf(entry) < index,
  );
};

export const TASK_OUTPUT_MAX_CHARS = 24_000;

export const DEFAULT_TASK_PROMPTS: Record<TaskRunStepId, string> = {
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
  merge: `You are the final (ship) step of a task pipeline, getting the work ready to hand over. Prepare branch {{branch}} for merging into {{baseRef}}: commit any outstanding work, bring in the latest {{baseRef}}, resolve conflicts, and re-run the project's checks. Do NOT merge into {{baseRef}} and do NOT push.

# {{task.title}}

## Review notes
{{review.output}}

Finish with a short readiness summary.`,
};

export const DEFAULT_TASK_CONFIG: TaskConfig = {
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

export const createDefaultTaskConfig = (): TaskConfig => ({
  plan: { ...DEFAULT_TASK_CONFIG.plan },
  build: { ...DEFAULT_TASK_CONFIG.build },
  review: { ...DEFAULT_TASK_CONFIG.review },
  merge: { ...DEFAULT_TASK_CONFIG.merge },
});

export const getTaskStepPrompt = (
  step: TaskRunStepId,
  config: Pick<TaskStepConfig, "prompt">,
): string => {
  const custom = config.prompt?.trim();
  return custom ? (config.prompt ?? "") : DEFAULT_TASK_PROMPTS[step];
};

export const TASK_PROMPT_VARIABLES = [
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

export type TaskPromptVariable = (typeof TASK_PROMPT_VARIABLES)[number];

/** Latest run of `step` that produced output. */
const getLatestOutput = (runs: TaskStepRun[], step: TaskRunStepId): string => {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run?.step === step && run.output) {
      return run.output;
    }
  }
  return "";
};

export interface RenderTaskPromptInput {
  feedback?: string | null;
  /** The run handing off to this step, if any. */
  previousRun?: Pick<TaskStepRun, "output" | "step"> | null;
  task: Pick<Task, "baseRef" | "branch" | "description" | "runs" | "title">;
  template: string;
}

/**
 * Fills `{{variable}}` placeholders. Unknown or empty variables render as an
 * empty string. When the template never mentions `{{previous.output}}` but a
 * previous step produced output, a handoff block is appended so the context
 * is never silently dropped by a custom prompt.
 */
export const renderTaskPrompt = ({
  feedback,
  previousRun,
  task,
  template,
}: RenderTaskPromptInput): string => {
  const previousOutput = previousRun?.output?.trim() ?? "";
  const feedbackText = feedback?.trim() ?? "";
  const values: Record<TaskPromptVariable, string> = {
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
        ? values[name as TaskPromptVariable]
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

export type TaskReviewVerdict = "approve" | "changes";

// Markdown decoration and an optional "Verdict:" label before the verdict.
const VERDICT_LINE_PREFIX_PATTERN = /^[\s>#*_`-]*(?:verdict\b[\s*_`:–—-]*)?/i;
const LEADING_CHANGES_PATTERN = /^CHANGES?[\s_-]+REQUESTED\b/i;
// Approval must be shouted as the prompt asks, so prose like "Approve of the
// naming" in a finding can never wave a task through.
const LEADING_APPROVE_PATTERN = /^APPROVED?\b/;
const ANY_CHANGES_PATTERN = /\bCHANGES?[\s_-]+REQUESTED\b/i;
const SHOUTED_APPROVE_PATTERN = /\bAPPROVED?\b/;

/**
 * Reads the verdict the review prompt asks for. A line that leads with the
 * verdict wins over words that merely appear in the findings; `null` means the
 * reviewer gave no recognizable verdict.
 */
export const getTaskReviewVerdict = (
  output: string | null | undefined,
): TaskReviewVerdict | null => {
  if (!output?.trim()) {
    return null;
  }

  for (const line of output.split(/\r?\n/)) {
    const lead = line.replace(VERDICT_LINE_PREFIX_PATTERN, "");
    if (LEADING_CHANGES_PATTERN.test(lead)) {
      return "changes";
    }
    if (LEADING_APPROVE_PATTERN.test(lead)) {
      return "approve";
    }
  }

  if (ANY_CHANGES_PATTERN.test(output)) {
    return "changes";
  }
  return SHOUTED_APPROVE_PATTERN.test(output) ? "approve" : null;
};
