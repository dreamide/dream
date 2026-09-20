import { ALL_PROVIDERS } from "@/lib/ide-defaults";
import { normalizeModelSpeed } from "@/lib/models";
import {
  createDefaultPipelineConfig,
  isPipelineRunStepId,
  isPipelineStepId,
  PIPELINE_OUTPUT_MAX_CHARS,
  PIPELINE_RUN_STEP_IDS,
} from "@/lib/pipeline-defaults";
import type {
  AiProvider,
  PipelineConfig,
  PipelineStepConfig,
  PipelineStepRun,
  PipelineTask,
  PipelineTaskCompletion,
} from "@/types/ide";
import { normalizeReasoningEffort } from "./ide-types";

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const isProvider = (value: unknown): value is AiProvider =>
  typeof value === "string" &&
  (ALL_PROVIDERS as readonly string[]).includes(value);

const normalizePipelineRun = (value: unknown): PipelineStepRun | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const run = value as Partial<PipelineStepRun>;
  const id = asNonEmptyString(run.id)?.trim();
  if (!id || !isPipelineRunStepId(run.step)) {
    return null;
  }

  return {
    chatId: asNonEmptyString(run.chatId),
    feedback: asNonEmptyString(run.feedback),
    finishedAt: asNonEmptyString(run.finishedAt),
    id,
    output:
      asNonEmptyString(run.output)?.slice(0, PIPELINE_OUTPUT_MAX_CHARS) ?? null,
    startedAt: asNonEmptyString(run.startedAt) ?? new Date().toISOString(),
    step: run.step,
  };
};

const normalizePipelineCompletion = (
  value: unknown,
): PipelineTaskCompletion | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const completion = value as Partial<PipelineTaskCompletion>;
  const kind = completion.kind;
  if (
    kind !== "merged" &&
    kind !== "pr" &&
    kind !== "removed" &&
    kind !== "legacy"
  ) {
    return null;
  }

  return {
    at: asNonEmptyString(completion.at) ?? new Date().toISOString(),
    kind,
    mergeCommit: asNonEmptyString(completion.mergeCommit),
    prUrl: asNonEmptyString(completion.prUrl),
  };
};

const normalizePipelineTask = (value: unknown): PipelineTask | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const task = value as Partial<PipelineTask>;
  const id = asNonEmptyString(task.id)?.trim();
  if (!id) {
    return null;
  }

  const createdAt =
    asNonEmptyString(task.createdAt) ?? new Date().toISOString();
  const seenRunIds = new Set<string>();
  const runs: PipelineStepRun[] = [];
  for (const rawRun of Array.isArray(task.runs) ? task.runs : []) {
    const run = normalizePipelineRun(rawRun);
    if (run && !seenRunIds.has(run.id)) {
      seenRunIds.add(run.id);
      runs.push(run);
    }
  }

  return {
    baseRef: asNonEmptyString(task.baseRef),
    branch: asNonEmptyString(task.branch),
    completion: normalizePipelineCompletion(task.completion),
    createdAt,
    description: typeof task.description === "string" ? task.description : "",
    id,
    runs,
    step: isPipelineStepId(task.step) ? task.step : "backlog",
    title: typeof task.title === "string" ? task.title : "",
    updatedAt: asNonEmptyString(task.updatedAt) ?? createdAt,
    worktreePath: asNonEmptyString(task.worktreePath),
    worktreeProjectId: asNonEmptyString(task.worktreeProjectId),
  };
};

/**
 * Upgrades a card from the retired Kanban board. Legacy cards had a single
 * chat and free-form columns; they map onto the closest pipeline step and keep
 * running in the parent project (no worktree).
 *
 * Keep in sync with `migrateKanbanCard` in `electron/persisted-state.js`.
 */
export const migrateKanbanCard = (value: unknown): unknown => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const card = value as Record<string, unknown>;
  const createdAt =
    asNonEmptyString(card.createdAt) ?? new Date().toISOString();
  const updatedAt = asNonEmptyString(card.updatedAt) ?? createdAt;
  const chatId = asNonEmptyString(card.chatId);
  const step =
    card.column === "inProgress"
      ? "build"
      : card.column === "review"
        ? "review"
        : card.column === "done"
          ? "merge"
          : "backlog";
  const finished = step === "review" || step === "merge";

  return {
    completion:
      step === "merge"
        ? { at: updatedAt, kind: "legacy", mergeCommit: null, prUrl: null }
        : null,
    createdAt,
    description: card.description,
    id: card.id,
    runs:
      chatId && step !== "backlog"
        ? [
            {
              chatId,
              feedback: null,
              finishedAt: finished ? updatedAt : null,
              id: `legacy-${String(card.id)}`,
              output: null,
              startedAt: createdAt,
              step: "build",
            },
          ]
        : [],
    step,
    title: card.title,
    updatedAt,
  };
};

export const normalizePipelineTasks = (
  value: unknown,
  legacyKanbanCards?: unknown,
): PipelineTask[] => {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(legacyKanbanCards)
      ? legacyKanbanCards.map(migrateKanbanCard)
      : [];

  const seenIds = new Set<string>();
  const tasks: PipelineTask[] = [];

  for (const rawTask of source) {
    const task = normalizePipelineTask(rawTask);
    if (!task || seenIds.has(task.id)) {
      continue;
    }

    seenIds.add(task.id);
    tasks.push(task);
  }

  return tasks;
};

const normalizePipelineStepConfig = (
  value: unknown,
  fallback: PipelineStepConfig,
): PipelineStepConfig => {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const config = value as Partial<PipelineStepConfig>;
  const rawModel =
    config.model && typeof config.model === "object" ? config.model : null;
  const modelId = rawModel ? asNonEmptyString(rawModel.model) : null;

  return {
    agentMode:
      config.agentMode === "plan" || config.agentMode === "build"
        ? config.agentMode
        : fallback.agentMode,
    autoAdvance:
      typeof config.autoAdvance === "boolean"
        ? config.autoAdvance
        : fallback.autoAdvance,
    model:
      rawModel && modelId && isProvider(rawModel.provider)
        ? {
            model: modelId,
            modelSpeed: normalizeModelSpeed(rawModel.modelSpeed),
            provider: rawModel.provider,
            reasoningEffort: normalizeReasoningEffort(rawModel.reasoningEffort),
          }
        : null,
    permissionMode:
      config.permissionMode === "standard" ||
      config.permissionMode === "full-access"
        ? config.permissionMode
        : fallback.permissionMode,
    prompt: asNonEmptyString(config.prompt),
  };
};

export const normalizePipelineConfig = (value: unknown): PipelineConfig => {
  const config = createDefaultPipelineConfig();
  if (!value || typeof value !== "object") {
    return config;
  }

  const raw = value as Record<string, unknown>;
  for (const step of PIPELINE_RUN_STEP_IDS) {
    config[step] = normalizePipelineStepConfig(raw[step], config[step]);
  }
  return config;
};
