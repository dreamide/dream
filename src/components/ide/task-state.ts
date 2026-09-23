import { ALL_PROVIDERS } from "@/lib/ide-defaults";
import { normalizeModelSpeed } from "@/lib/models";
import {
  createDefaultTaskConfig,
  isTaskRunStepId,
  isTaskStepId,
  TASK_OUTPUT_MAX_CHARS,
  TASK_RUN_STEP_IDS,
} from "@/lib/task-defaults";
import type {
  AiProvider,
  Task,
  TaskCompletion,
  TaskConfig,
  TaskStepConfig,
  TaskStepRun,
} from "@/types/ide";
import { normalizeChatPermissionMode } from "../../../electron/shared/chat-permissions.js";
import { normalizeReasoningEffort } from "./ide-types";

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const isProvider = (value: unknown): value is AiProvider =>
  typeof value === "string" &&
  (ALL_PROVIDERS as readonly string[]).includes(value);

const normalizeTaskRun = (value: unknown): TaskStepRun | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const run = value as Partial<TaskStepRun>;
  const id = asNonEmptyString(run.id)?.trim();
  if (!id || !isTaskRunStepId(run.step)) {
    return null;
  }

  return {
    chatId: asNonEmptyString(run.chatId),
    commitError: asNonEmptyString(run.commitError),
    feedback: asNonEmptyString(run.feedback),
    finishedAt: asNonEmptyString(run.finishedAt),
    id,
    output:
      asNonEmptyString(run.output)?.slice(0, TASK_OUTPUT_MAX_CHARS) ?? null,
    startedAt: asNonEmptyString(run.startedAt) ?? new Date().toISOString(),
    step: run.step,
  };
};

const normalizeTaskCompletion = (value: unknown): TaskCompletion | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const completion = value as Partial<TaskCompletion>;
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

/**
 * `ownerProjectId` is the project a legacy task was stored on; tasks in the
 * app-wide list carry their own `projectId`.
 */
const normalizeTask = (
  value: unknown,
  ownerProjectId?: string,
): Task | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const task = value as Partial<Task>;
  const id = asNonEmptyString(task.id)?.trim();
  const projectId = ownerProjectId ?? asNonEmptyString(task.projectId)?.trim();
  if (!id || !projectId) {
    return null;
  }

  const createdAt =
    asNonEmptyString(task.createdAt) ?? new Date().toISOString();
  const seenRunIds = new Set<string>();
  const runs: TaskStepRun[] = [];
  for (const rawRun of Array.isArray(task.runs) ? task.runs : []) {
    const run = normalizeTaskRun(rawRun);
    if (run && !seenRunIds.has(run.id)) {
      seenRunIds.add(run.id);
      runs.push(run);
    }
  }

  return {
    baseRef: asNonEmptyString(task.baseRef),
    branch: asNonEmptyString(task.branch),
    completion: normalizeTaskCompletion(task.completion),
    createdAt,
    description: typeof task.description === "string" ? task.description : "",
    id,
    projectId,
    runs,
    step: isTaskStepId(task.step) ? task.step : "backlog",
    title: typeof task.title === "string" ? task.title : "",
    updatedAt: asNonEmptyString(task.updatedAt) ?? createdAt,
    worktreePath: asNonEmptyString(task.worktreePath),
    worktreeProjectId: asNonEmptyString(task.worktreeProjectId),
  };
};

/**
 * Upgrades a card from the retired Kanban board. Legacy cards had a single
 * chat and free-form columns; they map onto the closest task step and keep
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

/** Tasks as they used to be stored: on their project's `ui`. */
export interface LegacyProjectTasks {
  kanbanCards?: unknown;
  projectId: string;
  tasks: unknown;
}

/**
 * Builds the app-wide task list. `value` is that list as persisted; `legacy`
 * holds tasks still stored on their projects, which are appended so an upgrade
 * loses nothing. Tasks of unknown (removed) projects are dropped.
 */
export const normalizeTasks = (
  value: unknown,
  knownProjectIds: ReadonlySet<string>,
  legacy: LegacyProjectTasks[] = [],
): Task[] => {
  const seenIds = new Set<string>();
  const tasks: Task[] = [];
  const add = (rawTask: unknown, ownerProjectId?: string) => {
    const task = normalizeTask(rawTask, ownerProjectId);
    if (!task || seenIds.has(task.id) || !knownProjectIds.has(task.projectId)) {
      return;
    }

    seenIds.add(task.id);
    tasks.push(task);
  };

  for (const rawTask of Array.isArray(value) ? value : []) {
    add(rawTask);
  }

  for (const entry of legacy) {
    const source = Array.isArray(entry.tasks)
      ? entry.tasks
      : Array.isArray(entry.kanbanCards)
        ? entry.kanbanCards.map(migrateKanbanCard)
        : [];
    for (const rawTask of source) {
      add(rawTask, entry.projectId);
    }
  }

  return tasks;
};

const normalizeTaskStepConfig = (
  value: unknown,
  fallback: TaskStepConfig,
): TaskStepConfig => {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const config = value as Partial<TaskStepConfig> & { agentMode?: unknown };
  const rawModel =
    config.model && typeof config.model === "object" ? config.model : null;
  const modelId = rawModel ? asNonEmptyString(rawModel.model) : null;

  return {
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
    permissionMode: normalizeChatPermissionMode(
      config.permissionMode,
      config.agentMode,
      fallback.permissionMode,
    ),
    prompt: asNonEmptyString(config.prompt),
  };
};

export const normalizeTaskConfig = (value: unknown): TaskConfig => {
  const config = createDefaultTaskConfig();
  if (!value || typeof value !== "object") {
    return config;
  }

  const raw = value as Record<string, unknown>;
  for (const step of TASK_RUN_STEP_IDS) {
    config[step] = normalizeTaskStepConfig(raw[step], config[step]);
  }
  return config;
};
