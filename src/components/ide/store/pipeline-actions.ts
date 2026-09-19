import {
  createChatConfig,
  createPipelineTask,
  getDefaultModelSelection,
} from "@/lib/ide-defaults";
import {
  createDefaultPipelineConfig,
  getNextPipelineStep,
  getPipelineReviewVerdict,
  getPipelineStepPrompt,
  PIPELINE_STEP_IDS,
  renderPipelinePrompt,
} from "@/lib/pipeline-defaults";
import type {
  AppSettings,
  ChatConfig,
  PipelineRunStepId,
  PipelineStepConfig,
  PipelineStepModel,
  PipelineStepRun,
  PipelineTask,
  ProjectConfig,
} from "@/types/ide";
import { extractStepOutput } from "../workspaces/pipeline/pipeline-output";
import { updateProjectUiInList } from ".";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

const STEP_TITLE_PREFIX: Record<PipelineRunStepId, string> = {
  build: "Build",
  merge: "Merge",
  plan: "Plan",
  review: "Review",
};

const getProjectPipelineTasks = (
  project: { ui: { pipelineTasks?: PipelineTask[] } } | undefined,
) => project?.ui.pipelineTasks ?? [];

/** The run driving the task's current step, if that step has started. */
export const getCurrentPipelineRun = (
  task: Pick<PipelineTask, "runs" | "step">,
): PipelineStepRun | null => {
  for (let index = task.runs.length - 1; index >= 0; index -= 1) {
    const run = task.runs[index];
    if (run?.step === task.step) {
      return run;
    }
  }
  return null;
};

export interface PipelineTaskMatch {
  project: ProjectConfig;
  run: PipelineStepRun;
  task: PipelineTask;
}

/**
 * Finds the task owning `chatId`. Tasks live in the parent project while their
 * step chats may belong to a worktree project, so every project is scanned.
 */
export const findPipelineTaskByChatId = (
  projects: ProjectConfig[],
  chatId: string,
): PipelineTaskMatch | null => {
  for (const project of projects) {
    for (const task of getProjectPipelineTasks(project)) {
      const run = task.runs.find((entry) => entry.chatId === chatId);
      if (run) {
        return { project, run, task };
      }
    }
  }
  return null;
};

const replaceTaskInProjects = (
  projects: ProjectConfig[],
  projectId: string,
  taskId: string,
  updater: (task: PipelineTask) => PipelineTask,
): ProjectConfig[] =>
  updateProjectUiInList(projects, projectId, (entry) => ({
    ...entry.ui,
    pipelineTasks: getProjectPipelineTasks(entry).map((task) =>
      task.id === taskId ? updater(task) : task,
    ),
  }));

/**
 * Records a normally finished agent turn on the run linked to `chatId`, when
 * that run drives its task's current step. A later turn in the same step chat
 * (e.g. a revised plan) refreshes the output. Returns the same reference when
 * nothing changes.
 */
export const finishPipelineRunInProjects = (
  projects: ProjectConfig[],
  chatId: string,
  output: string,
  at: string,
): ProjectConfig[] => {
  const match = findPipelineTaskByChatId(projects, chatId);
  if (!match || match.task.completion) {
    return projects;
  }

  const currentRun = getCurrentPipelineRun(match.task);
  if (currentRun?.id !== match.run.id) {
    return projects;
  }

  return replaceTaskInProjects(
    projects,
    match.project.id,
    match.task.id,
    (task) => ({
      ...task,
      runs: task.runs.map((run) =>
        run.id === currentRun.id
          ? { ...run, finishedAt: at, output: output || run.output }
          : run,
      ),
      updatedAt: at,
    }),
  );
};

const unlinkPipelineRunsInProjects = (
  projects: ProjectConfig[],
  chatIds: Set<string>,
  timestamp: string,
): ProjectConfig[] => {
  let changed = false;
  const next = projects.map((project) => {
    const tasks = getProjectPipelineTasks(project);
    const isLinked = (run: PipelineStepRun) =>
      run.chatId !== null && chatIds.has(run.chatId);
    if (!tasks.some((task) => task.runs.some(isLinked))) {
      return project;
    }

    changed = true;
    return {
      ...project,
      ui: {
        ...project.ui,
        pipelineTasks: tasks.map((task) =>
          task.runs.some(isLinked)
            ? {
                ...task,
                // The output snapshot is kept so later steps can still use it.
                runs: task.runs.map((run) =>
                  isLinked(run) ? { ...run, chatId: null } : run,
                ),
                updatedAt: timestamp,
              }
            : task,
        ),
      },
    };
  });

  return changed ? next : projects;
};

/**
 * Model settings for a step chat: the step's own model when configured,
 * otherwise the same default selection a manually created chat would get.
 */
export const resolvePipelineStepAgent = (
  config: Pick<PipelineStepConfig, "model">,
  hostProject: ProjectConfig,
  settings: AppSettings,
): PipelineStepModel => {
  if (config.model?.model) {
    return config.model;
  }

  const defaultSelection = getDefaultModelSelection(settings);
  return defaultSelection.model
    ? defaultSelection
    : {
        model: hostProject.model,
        modelSpeed: hostProject.modelSpeed,
        provider: hostProject.provider,
        reasoningEffort: hostProject.reasoningEffort,
      };
};

/** Branch for a task's worktree, e.g. `pipeline/fix-login-1a2b3c`. */
export const getPipelineBranchName = (
  task: Pick<PipelineTask, "id" | "title">,
): string => {
  const slug =
    task.title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "task";
  return `pipeline/${slug}-${task.id.replace(/[^a-z0-9]/gi, "").slice(0, 6)}`;
};

const isLiveChat = (chats: ChatConfig[], chatId: string | null) =>
  chatId !== null &&
  chats.some((chat) => chat.id === chatId && chat.deletedAt === null);

interface RunStepOptions {
  feedback?: string | null;
  /** The run handing off to this step. */
  previousRun?: PipelineStepRun | null;
  /** Continue in this existing step chat instead of creating a new one. */
  reuseChatId?: string | null;
}

export const createPipelineActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "addPipelineTask"
  | "updatePipelineTask"
  | "deletePipelineTask"
  | "movePipelineTaskInBacklog"
  | "startPipelineTask"
  | "advancePipelineTask"
  | "sendPipelineTaskBack"
  | "retryPipelineStep"
  | "completePipelineTask"
  | "openPipelineStepChat"
  | "reopenPipelineWorktree"
  | "unlinkPipelineRunsForChats"
  | "setPipelineStepConfig"
  | "resetPipelineStepConfig"
  | "isPipelineChat"
  | "maybeAutoAdvancePipelineForChat"
> => {
  const findTask = (projectId: string, taskId: string) => {
    const project = get().projects.find((entry) => entry.id === projectId);
    const task = getProjectPipelineTasks(project).find(
      (entry) => entry.id === taskId,
    );
    return project && task ? { project, task } : null;
  };

  /**
   * Gives a task leaving the backlog its own git worktree, so parallel tasks
   * never collide and the merge step has a branch to land. The worktree opens
   * as a background project. Throws when the worktree cannot be created (e.g.
   * the project is not a git repository).
   */
  const ensureTaskWorktree = async (
    projectId: string,
    taskId: string,
  ): Promise<void> => {
    const found = findTask(projectId, taskId);
    if (!found) {
      return;
    }

    const { project, task } = found;
    // Tasks that already ran in place (migrated from the old board) stay
    // there, and a worktree project never nests another worktree.
    if (task.worktreeProjectId || task.runs.length > 0 || project.worktree) {
      return;
    }

    const created = await get().createWorktreeProject(projectId, {
      activate: false,
      branchName: getPipelineBranchName(task),
    });
    if (!created) {
      throw new Error("The worktree could not be created.");
    }

    const worktreeProject = get().projects.find(
      (entry) => entry.id === created.projectId,
    );
    set((state) => ({
      projects: replaceTaskInProjects(
        state.projects,
        projectId,
        taskId,
        (entry) => ({
          ...entry,
          baseRef: worktreeProject?.worktree?.baseRef ?? null,
          branch: worktreeProject?.worktree?.branch ?? null,
          worktreePath: worktreeProject?.path ?? null,
          worktreeProjectId: created.projectId,
        }),
      ),
    }));
  };

  /**
   * Moves the task to `step` and queues that step's prompt in a step chat.
   * Step chats are created directly (not through `addChat`) so starting a step
   * never steals focus from the project the user is looking at.
   */
  const runStep = (
    projectId: string,
    taskId: string,
    step: PipelineRunStepId,
    options: RunStepOptions = {},
  ): string | null => {
    const state = get();
    const found = findTask(projectId, taskId);
    if (!found || found.task.completion) {
      return null;
    }

    const { project, task } = found;
    const title = task.title.trim();
    if (!title) {
      return null;
    }

    const hostProject = task.worktreeProjectId
      ? state.projects.find((entry) => entry.id === task.worktreeProjectId)
      : project;
    if (!hostProject) {
      // The task's worktree project is closed; it must be reopened first.
      return null;
    }

    const config =
      project.ui.pipelineConfig?.[step] ?? createDefaultPipelineConfig()[step];
    const feedback = options.feedback?.trim() || null;
    const reuseChatId =
      options.reuseChatId &&
      isLiveChat(state.chats, options.reuseChatId) &&
      !state.streamingChatIds[options.reuseChatId] &&
      !state.pendingChatSubmitByChatId[options.reuseChatId]
        ? options.reuseChatId
        : null;

    let chatId: string;
    let nextChat: ChatConfig | null = null;
    let text: string;

    if (reuseChatId) {
      // The chat already holds the task and plan; only the new input matters.
      chatId = reuseChatId;
      text = [
        options.previousRun
          ? `This task was sent back from the ${options.previousRun.step} step.`
          : "Continue working on this task.",
        feedback ? `## Feedback to address\n${feedback}` : "",
        "When you are done, finish with an updated summary as your final message.",
      ]
        .filter(Boolean)
        .join("\n\n");
    } else {
      const agent = resolvePipelineStepAgent(
        config,
        hostProject,
        state.settings,
      );
      nextChat = createChatConfig(hostProject, {
        ...agent,
        agentMode: config.agentMode,
        permissionMode: config.permissionMode,
        title: `${STEP_TITLE_PREFIX[step]}: ${title}`,
      });
      chatId = nextChat.id;
      text = renderPipelinePrompt({
        feedback,
        previousRun: options.previousRun ?? null,
        task,
        template: getPipelineStepPrompt(step, config),
      });
    }

    const timestamp = new Date().toISOString();
    const run: PipelineStepRun = {
      chatId,
      feedback,
      finishedAt: null,
      id: crypto.randomUUID(),
      output: null,
      startedAt: timestamp,
      step,
    };

    set((current) => {
      const withChat = updateProjectUiInList(
        current.projects,
        hostProject.id,
        (entry) => ({
          ...entry.ui,
          activeChatId: chatId,
          openChatIds: entry.ui.multiChat
            ? entry.ui.openChatIds.includes(chatId)
              ? entry.ui.openChatIds
              : [...entry.ui.openChatIds, chatId]
            : [chatId],
          ...(entry.ui.multiChat ? {} : { chatColumnWidths: {} }),
        }),
      );

      return {
        ...(nextChat
          ? {
              chats: [...current.chats, nextChat],
              messagesByChatId: {
                ...current.messagesByChatId,
                [nextChat.id]: [],
              },
            }
          : {}),
        pendingChatSubmitByChatId: {
          ...current.pendingChatSubmitByChatId,
          [chatId]: { references: [], text },
        },
        projects: replaceTaskInProjects(
          withChat,
          projectId,
          taskId,
          (entry) => ({
            ...entry,
            runs: [...entry.runs, run],
            step,
            updatedAt: timestamp,
          }),
        ),
      };
    });

    return chatId;
  };

  /**
   * Marks the current run finished, snapshotting its output from the
   * transcript when the turn-finish hook did not already capture it.
   */
  const settleCurrentRun = async (
    projectId: string,
    taskId: string,
  ): Promise<PipelineStepRun | null> => {
    const found = findTask(projectId, taskId);
    const currentRun = found ? getCurrentPipelineRun(found.task) : null;
    if (!found || !currentRun) {
      return null;
    }

    let output = currentRun.output;
    if (!output && isLiveChat(get().chats, currentRun.chatId)) {
      try {
        const messages = await get().loadMessagesForChat(
          currentRun.chatId as string,
        );
        output = extractStepOutput(messages) || null;
      } catch {
        output = null;
      }
    }

    const settled: PipelineStepRun = {
      ...currentRun,
      finishedAt: currentRun.finishedAt ?? new Date().toISOString(),
      output,
    };
    set((state) => ({
      projects: replaceTaskInProjects(
        state.projects,
        projectId,
        taskId,
        (task) => ({
          ...task,
          runs: task.runs.map((run) => (run.id === settled.id ? settled : run)),
        }),
      ),
    }));
    return settled;
  };

  const isRunBusy = (run: PipelineStepRun | null) => {
    if (!run?.chatId) {
      return false;
    }
    const state = get();
    return Boolean(
      state.streamingChatIds[run.chatId] ||
        state.pendingChatSubmitByChatId[run.chatId],
    );
  };

  return {
    addPipelineTask: (projectId, input) => {
      const state = get();
      const project = state.projects.find((entry) => entry.id === projectId);
      const title = input.title.trim();
      if (!project || !title) {
        return null;
      }

      const task = createPipelineTask({
        description: input.description?.trim() ?? "",
        title,
      });

      set({
        projects: updateProjectUiInList(state.projects, projectId, (entry) => ({
          ...entry.ui,
          pipelineTasks: [...getProjectPipelineTasks(entry), task],
        })),
      });

      return task.id;
    },

    updatePipelineTask: (projectId, taskId, updates) => {
      if (!findTask(projectId, taskId)) {
        return;
      }

      set((state) => ({
        projects: replaceTaskInProjects(
          state.projects,
          projectId,
          taskId,
          (task) => ({
            ...task,
            description: updates.description ?? task.description,
            title: updates.title?.trim() || task.title,
            updatedAt: new Date().toISOString(),
          }),
        ),
      }));
    },

    deletePipelineTask: (projectId, taskId) => {
      if (!findTask(projectId, taskId)) {
        return;
      }

      set((state) => ({
        projects: updateProjectUiInList(state.projects, projectId, (entry) => ({
          ...entry.ui,
          pipelineTasks: getProjectPipelineTasks(entry).filter(
            (task) => task.id !== taskId,
          ),
        })),
      }));
    },

    movePipelineTaskInBacklog: (projectId, taskId, index) => {
      const found = findTask(projectId, taskId);
      if (!found || found.task.step !== "backlog") {
        return;
      }

      const tasks = getProjectPipelineTasks(found.project);
      const backlog = tasks.filter((task) => task.step === "backlog");
      const from = backlog.findIndex((task) => task.id === taskId);
      const to = Math.max(
        0,
        Math.min(
          Number.isFinite(index) ? Math.trunc(index) : backlog.length - 1,
          backlog.length - 1,
        ),
      );
      if (from === to) {
        return;
      }

      const reordered = [...backlog];
      reordered.splice(from, 1);
      reordered.splice(to, 0, found.task);
      // Refill the backlog slots in order; other steps keep their positions.
      let cursor = 0;
      const next = tasks.map((task) =>
        task.step === "backlog" ? (reordered[cursor++] as PipelineTask) : task,
      );

      set((state) => ({
        projects: updateProjectUiInList(state.projects, projectId, (entry) => ({
          ...entry.ui,
          pipelineTasks: next,
        })),
      }));
    },

    startPipelineTask: async (projectId, taskId) => {
      const found = findTask(projectId, taskId);
      if (!found || found.task.step !== "backlog") {
        return null;
      }

      await ensureTaskWorktree(projectId, taskId);
      // The task may have been started or deleted while git was working.
      if (findTask(projectId, taskId)?.task.step !== "backlog") {
        return null;
      }
      return runStep(projectId, taskId, "plan");
    },

    advancePipelineTask: async (projectId, taskId) => {
      const found = findTask(projectId, taskId);
      if (!found || found.task.completion) {
        return null;
      }

      const nextStep = getNextPipelineStep(found.task.step);
      if (!nextStep || isRunBusy(getCurrentPipelineRun(found.task))) {
        return null;
      }

      const previousRun = await settleCurrentRun(projectId, taskId);
      // The task may have moved while the transcript was loading.
      if (findTask(projectId, taskId)?.task.step !== found.task.step) {
        return null;
      }
      return runStep(projectId, taskId, nextStep, { previousRun });
    },

    sendPipelineTaskBack: async (projectId, taskId, toStep, note) => {
      const found = findTask(projectId, taskId);
      if (!found || found.task.completion) {
        return null;
      }

      const { task } = found;
      if (
        PIPELINE_STEP_IDS.indexOf(toStep) >=
        PIPELINE_STEP_IDS.indexOf(task.step)
      ) {
        return null;
      }
      if (isRunBusy(getCurrentPipelineRun(task))) {
        return null;
      }

      const previousRun = await settleCurrentRun(projectId, taskId);
      if (findTask(projectId, taskId)?.task.step !== task.step) {
        return null;
      }

      const feedback = [previousRun?.output?.trim(), note?.trim()]
        .filter(Boolean)
        .join("\n\n");
      const targetRun = [...task.runs]
        .reverse()
        .find((run) => run.step === toStep && run.chatId);

      return runStep(projectId, taskId, toStep, {
        feedback,
        previousRun,
        reuseChatId: targetRun?.chatId ?? null,
      });
    },

    retryPipelineStep: async (projectId, taskId) => {
      const found = findTask(projectId, taskId);
      if (!found || found.task.completion || found.task.step === "backlog") {
        return null;
      }

      const { task } = found;
      const currentRun = getCurrentPipelineRun(task);
      if (isRunBusy(currentRun)) {
        return null;
      }

      // Hand the retry the same input the failed attempt received.
      const currentIndex = currentRun ? task.runs.indexOf(currentRun) : -1;
      const previousRun =
        currentIndex > 0 ? (task.runs[currentIndex - 1] ?? null) : null;

      return runStep(projectId, taskId, task.step as PipelineRunStepId, {
        feedback: currentRun?.feedback ?? null,
        previousRun,
      });
    },

    completePipelineTask: (projectId, taskId, completion) => {
      if (!findTask(projectId, taskId)) {
        return;
      }

      set((state) => ({
        projects: replaceTaskInProjects(
          state.projects,
          projectId,
          taskId,
          (task) => ({
            ...task,
            completion,
            step: "merge",
            updatedAt: completion.at,
          }),
        ),
      }));
    },

    openPipelineStepChat: (projectId, taskId, runId) => {
      const found = findTask(projectId, taskId);
      if (!found) {
        return;
      }

      const state = get();
      const run = runId
        ? found.task.runs.find((entry) => entry.id === runId)
        : [...found.task.runs]
            .reverse()
            .find((entry) => isLiveChat(state.chats, entry.chatId));
      const chat = state.chats.find(
        (entry) => entry.id === run?.chatId && entry.deletedAt === null,
      );
      if (
        !chat ||
        !state.projects.some((entry) => entry.id === chat.projectId)
      ) {
        return;
      }

      if (state.activeProjectId !== chat.projectId) {
        get().setActiveProjectId(chat.projectId);
      }
      get().setActiveChatId(chat.projectId, chat.id);
      get().setProjectWorkspaceView(chat.projectId, "code");
    },

    reopenPipelineWorktree: async (projectId, taskId) => {
      const task = findTask(projectId, taskId)?.task;
      if (!task?.worktreeProjectId) {
        return false;
      }

      const isOpen = () =>
        get().projects.some((entry) => entry.id === task.worktreeProjectId);
      if (isOpen()) {
        return true;
      }

      const closedProject = get().closedProjects.find(
        (entry) => entry.id === task.worktreeProjectId,
      );
      if (!closedProject) {
        // The worktree was removed outside the pipeline.
        return false;
      }

      get().addProject(closedProject.path, { activate: false });
      return isOpen();
    },

    unlinkPipelineRunsForChats: (chatIds) => {
      const ids = new Set(chatIds);
      if (ids.size === 0) {
        return;
      }

      set((state) => {
        const timestamp = new Date().toISOString();
        const projects = unlinkPipelineRunsInProjects(
          state.projects,
          ids,
          timestamp,
        );
        const closedProjects = unlinkPipelineRunsInProjects(
          state.closedProjects,
          ids,
          timestamp,
        );
        if (
          projects === state.projects &&
          closedProjects === state.closedProjects
        ) {
          return state;
        }

        return { closedProjects, projects };
      });
    },

    setPipelineStepConfig: (projectId, step, updater) => {
      set((state) => {
        if (!state.projects.some((entry) => entry.id === projectId)) {
          return state;
        }

        return {
          projects: updateProjectUiInList(
            state.projects,
            projectId,
            (entry) => {
              const config =
                entry.ui.pipelineConfig ?? createDefaultPipelineConfig();
              return {
                ...entry.ui,
                pipelineConfig: { ...config, [step]: updater(config[step]) },
              };
            },
          ),
        };
      });
    },

    resetPipelineStepConfig: (projectId, step) => {
      get().setPipelineStepConfig(
        projectId,
        step,
        () => createDefaultPipelineConfig()[step],
      );
    },

    isPipelineChat: (chatId) =>
      findPipelineTaskByChatId(get().projects, chatId) !== null,

    maybeAutoAdvancePipelineForChat: (chatId) => {
      const match = findPipelineTaskByChatId(get().projects, chatId);
      if (!match || match.task.completion) {
        return;
      }

      const { project, run, task } = match;
      const currentRun = getCurrentPipelineRun(task);
      if (currentRun?.id !== run.id || !run.finishedAt) {
        return;
      }

      const config =
        project.ui.pipelineConfig?.[run.step] ??
        createDefaultPipelineConfig()[run.step];
      // Merging is always an explicit user action.
      if (!config.autoAdvance || !getNextPipelineStep(task.step)) {
        return;
      }
      // A review only passes itself along on an explicit APPROVE; requested
      // changes (or no verdict at all) wait for the user to decide.
      if (
        run.step === "review" &&
        getPipelineReviewVerdict(run.output) !== "approve"
      ) {
        return;
      }

      void get().advancePipelineTask(project.id, task.id);
    },
  };
};
