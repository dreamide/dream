import {
  createChatConfig,
  createTask,
  getDefaultModelSelection,
} from "@/lib/ide-defaults";
import {
  getNextTaskStep,
  getTaskReviewVerdict,
  getTaskStepPrompt,
  renderTaskPrompt,
  TASK_STEP_IDS,
} from "@/lib/task-defaults";
import type {
  AppSettings,
  ChatConfig,
  ProjectConfig,
  Task,
  TaskEntry,
  TaskRunStepId,
  TaskStepConfig,
  TaskStepModel,
  TaskStepRun,
} from "@/types/ide";
import { normalizeProjectPathKey } from "../ide-state";
import { extractStepOutput } from "../workspaces/tasks/task-output";
import { updateProjectUiInList } from ".";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

type ProjectLists = Pick<IdeState, "closedProjects" | "projects">;

const STEP_TITLE_PREFIX: Record<TaskRunStepId, string> = {
  build: "Build",
  // The id stays `merge` so saved tasks need no migration.
  merge: "Ship",
  plan: "Plan",
  review: "Review",
};

/**
 * A task's owner may be open in Code or closed: the Tasks workspace does not
 * depend on which, so lookups span both lists.
 */
const findProjectById = (
  state: ProjectLists,
  projectId: string,
): ProjectConfig | undefined =>
  state.projects.find((entry) => entry.id === projectId) ??
  state.closedProjects.find((entry) => entry.id === projectId);

/** The run driving the task's current step, if that step has started. */
export const getCurrentTaskRun = (
  task: Pick<Task, "runs" | "step">,
): TaskStepRun | null => {
  for (let index = task.runs.length - 1; index >= 0; index -= 1) {
    const run = task.runs[index];
    if (run?.step === task.step) {
      return run;
    }
  }
  return null;
};

export interface TaskMatch {
  run: TaskStepRun;
  task: Task;
}

/**
 * Finds the task owning `chatId`, through its latest run in that chat. A task
 * sent back to an earlier step continues in that step's chat, so several runs
 * can share one chat; only the newest is the one the agent is working on.
 */
export const findTaskByChatId = (
  tasks: Task[],
  chatId: string,
): TaskMatch | null => {
  for (const task of tasks) {
    const run = task.runs.findLast((entry) => entry.chatId === chatId);
    if (run) {
      return { run, task };
    }
  }
  return null;
};

const getTaskOwnerIds = (tasks: Task[]): Set<string> =>
  new Set(tasks.map((task) => task.projectId));

/**
 * Open projects a new task can be filed under. Worktrees the Tasks workspace
 * created are projects too, but their tasks live on the parent, so a worktree
 * is only listed when it holds tasks of its own.
 */
export const getTaskProjects = (
  projects: ProjectConfig[],
  tasks: Task[],
): ProjectConfig[] => {
  const ownerIds = getTaskOwnerIds(tasks);
  return projects.filter(
    (project) => !project.worktree || ownerIds.has(project.id),
  );
};

/**
 * Projects offered in the Tasks workspace's own project filter: the open ones
 * (see `getTaskProjects`), then closed projects that still own tasks.
 */
export const getTaskScopeProjects = (
  projects: ProjectConfig[],
  closedProjects: ProjectConfig[],
  tasks: Task[],
): ProjectConfig[] => {
  const ownerIds = getTaskOwnerIds(tasks);
  return [
    ...getTaskProjects(projects, tasks),
    ...closedProjects.filter((project) => ownerIds.has(project.id)),
  ];
};

const RECENT_TASK_PROJECT_LIMIT = 20;

/**
 * Closed projects a new task can still be filed under, most recently used
 * first. Filing a task does not open the project; starting it does.
 * Worktrees are left out — a closed one may no longer exist on disk.
 */
export const getRecentTaskProjects = (
  closedProjects: ProjectConfig[],
): ProjectConfig[] =>
  closedProjects
    .filter((project) => !project.worktree)
    .map((project, index) => ({
      index,
      project,
      usedAt: Date.parse(project.lastUsedAt ?? "") || 0,
    }))
    .sort((a, b) => b.usedAt - a.usedAt || b.index - a.index)
    .slice(0, RECENT_TASK_PROJECT_LIMIT)
    .map(({ project }) => project);

export interface TaskSelection {
  entries: TaskEntry[];
  /**
   * The project the board is filtered to, or `null` when it spans every
   * project (nothing selected, or the selected project no longer exists).
   */
  scopeProject: ProjectConfig | null;
}

/**
 * Pairs every visible task with its owning project, open or closed. The filter
 * belongs to the Tasks workspace and is deliberately independent of the active
 * project tab. Order follows the project lists (open, then closed) and then the
 * task list, so a project's backlog keeps its relative order when several
 * projects are shown.
 */
export const selectTaskEntries = (
  { closedProjects, projects }: ProjectLists,
  tasks: Task[],
  tasksProjectId: string | null,
): TaskSelection => {
  const allProjects = [...projects, ...closedProjects];
  const scopeProject =
    allProjects.find((project) => project.id === tasksProjectId) ?? null;
  const entries = (scopeProject ? [scopeProject] : allProjects).flatMap(
    (project) =>
      tasks
        .filter((task) => task.projectId === project.id)
        .map((task) => ({
          key: task.id,
          project,
          projectId: project.id,
          task,
        })),
  );

  return { entries, scopeProject };
};

const replaceTask = (
  tasks: Task[],
  taskId: string,
  updater: (task: Task) => Task,
): Task[] => tasks.map((task) => (task.id === taskId ? updater(task) : task));

/**
 * Records a normally finished agent turn on the run linked to `chatId`, when
 * that run drives its task's current step. A later turn in the same step chat
 * (e.g. a revised plan) refreshes the output. Returns the same reference when
 * nothing changes.
 */
export const finishTaskRun = (
  tasks: Task[],
  chatId: string,
  output: string,
  at: string,
): Task[] => {
  const match = findTaskByChatId(tasks, chatId);
  if (!match || match.task.completion) {
    return tasks;
  }

  const currentRun = getCurrentTaskRun(match.task);
  if (currentRun?.id !== match.run.id) {
    return tasks;
  }

  return replaceTask(tasks, match.task.id, (task) => ({
    ...task,
    runs: task.runs.map((run) =>
      run.id === currentRun.id
        ? { ...run, finishedAt: at, output: output || run.output }
        : run,
    ),
    updatedAt: at,
  }));
};

/** Returns the same reference when no run is linked to `chatIds`. */
const unlinkTaskRuns = (
  tasks: Task[],
  chatIds: Set<string>,
  timestamp: string,
): Task[] => {
  const isLinked = (run: TaskStepRun) =>
    run.chatId !== null && chatIds.has(run.chatId);
  if (!tasks.some((task) => task.runs.some(isLinked))) {
    return tasks;
  }

  return tasks.map((task) =>
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
  );
};

/**
 * Model settings for a step chat: the step's own model when configured,
 * otherwise the same default selection a manually created chat would get.
 */
export const resolveTaskStepAgent = (
  config: Pick<TaskStepConfig, "model">,
  hostProject: ProjectConfig,
  settings: AppSettings,
): TaskStepModel => {
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

/** Branch for a task's worktree, e.g. `task/fix-login-1a2b3c`. */
export const getTaskBranchName = (task: Pick<Task, "id" | "title">): string => {
  const slug =
    task.title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "task";
  return `task/${slug}-${task.id.replace(/[^a-z0-9]/gi, "").slice(0, 6)}`;
};

const isLiveChat = (chats: ChatConfig[], chatId: string | null) =>
  chatId !== null &&
  chats.some((chat) => chat.id === chatId && chat.deletedAt === null);

interface RunStepOptions {
  feedback?: string | null;
  /** The run handing off to this step. */
  previousRun?: TaskStepRun | null;
  /** Continue in this existing step chat instead of creating a new one. */
  reuseChatId?: string | null;
}

export const createTaskActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "addTask"
  | "addTaskToProjectPath"
  | "updateTask"
  | "deleteTask"
  | "moveTaskInBacklog"
  | "startTask"
  | "advanceTask"
  | "sendTaskBack"
  | "retryTaskStep"
  | "completeTask"
  | "openTaskStepChat"
  | "reopenTaskWorktree"
  | "unlinkTaskRunsForChats"
  | "setTaskStepConfig"
  | "isTaskChat"
  | "maybeAutoAdvanceTaskForChat"
> => {
  const findTask = (projectId: string, taskId: string) => {
    const state = get();
    const task = state.tasks.find(
      (entry) => entry.id === taskId && entry.projectId === projectId,
    );
    const project = task ? findProjectById(state, projectId) : undefined;
    return project && task ? { project, task } : null;
  };

  /**
   * Running a task needs its project loaded; filing or viewing one does not.
   * A closed project is reopened in the background, so the user stays in Tasks
   * and Code's active tab does not change.
   */
  const ensureProjectOpen = (projectId: string): ProjectConfig | null => {
    const findOpen = () =>
      get().projects.find((entry) => entry.id === projectId) ?? null;
    const closedProject = get().closedProjects.find(
      (entry) => entry.id === projectId,
    );
    if (!findOpen() && closedProject) {
      get().addProject(closedProject.path, { activate: false });
    }
    return findOpen();
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

    if (!ensureProjectOpen(projectId)) {
      throw new Error("The project could not be opened.");
    }

    const created = await get().createWorktreeProject(projectId, {
      activate: false,
      branchName: getTaskBranchName(task),
    });
    if (!created) {
      throw new Error("The worktree could not be created.");
    }

    const worktreeProject = get().projects.find(
      (entry) => entry.id === created.projectId,
    );
    set((state) => ({
      tasks: replaceTask(state.tasks, taskId, (entry) => ({
        ...entry,
        baseRef: worktreeProject?.worktree?.baseRef ?? null,
        branch: worktreeProject?.worktree?.branch ?? null,
        worktreePath: worktreeProject?.path ?? null,
        worktreeProjectId: created.projectId,
      })),
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
    step: TaskRunStepId,
    options: RunStepOptions = {},
  ): string | null => {
    const found = findTask(projectId, taskId);
    if (!found || found.task.completion) {
      return null;
    }

    const { task } = found;
    const title = task.title.trim();
    if (!title) {
      return null;
    }

    // A closed worktree must be reopened by the user first (it may be gone
    // from disk); a task that runs in its own project just loads it.
    const hostProject = task.worktreeProjectId
      ? get().projects.find((entry) => entry.id === task.worktreeProjectId)
      : ensureProjectOpen(projectId);
    if (!hostProject) {
      return null;
    }

    const state = get();

    const config = state.taskConfig[step];
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
      const agent = resolveTaskStepAgent(config, hostProject, state.settings);
      nextChat = createChatConfig(hostProject, {
        ...agent,
        agentMode: config.agentMode,
        permissionMode: config.permissionMode,
        title: `${STEP_TITLE_PREFIX[step]}: ${title}`,
      });
      chatId = nextChat.id;
      text = renderTaskPrompt({
        feedback,
        previousRun: options.previousRun ?? null,
        task,
        template: getTaskStepPrompt(step, config),
      });
    }

    const timestamp = new Date().toISOString();
    const run: TaskStepRun = {
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
        projects: withChat,
        tasks: replaceTask(current.tasks, taskId, (entry) => ({
          ...entry,
          runs: [...entry.runs, run],
          step,
          updatedAt: timestamp,
        })),
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
  ): Promise<TaskStepRun | null> => {
    const found = findTask(projectId, taskId);
    const currentRun = found ? getCurrentTaskRun(found.task) : null;
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

    const settled: TaskStepRun = {
      ...currentRun,
      finishedAt: currentRun.finishedAt ?? new Date().toISOString(),
      output,
    };
    set((state) => ({
      tasks: replaceTask(state.tasks, taskId, (task) => ({
        ...task,
        runs: task.runs.map((run) => (run.id === settled.id ? settled : run)),
      })),
    }));
    return settled;
  };

  const isRunBusy = (run: TaskStepRun | null) => {
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
    addTask: (projectId, input) => {
      const title = input.title.trim();
      if (!findProjectById(get(), projectId) || !title) {
        return null;
      }

      const task = createTask(projectId, {
        description: input.description?.trim() ?? "",
        title,
      });
      set((state) => ({ tasks: [...state.tasks, task] }));

      return task.id;
    },

    addTaskToProjectPath: (path, task) => {
      const projectPath = path.trim();
      if (!projectPath) {
        return null;
      }

      const findProject = () => {
        const pathKey = normalizeProjectPathKey(projectPath);
        const state = get();
        return [...state.projects, ...state.closedProjects].find(
          (entry) => normalizeProjectPathKey(entry.path) === pathKey,
        );
      };
      // A known project takes the task as it is, open or closed. A folder the
      // app has not seen is registered first, without activating it: the user
      // stays in Tasks and Code's active tab does not change.
      if (!findProject()) {
        get().addProject(projectPath, { activate: false });
      }

      const project = findProject();
      return project ? get().addTask(project.id, task) : null;
    },

    updateTask: (projectId, taskId, updates) => {
      if (!findTask(projectId, taskId)) {
        return;
      }

      set((state) => ({
        tasks: replaceTask(state.tasks, taskId, (task) => ({
          ...task,
          description: updates.description ?? task.description,
          title: updates.title?.trim() || task.title,
          updatedAt: new Date().toISOString(),
        })),
      }));
    },

    deleteTask: (projectId, taskId) => {
      if (!findTask(projectId, taskId)) {
        return;
      }

      set((state) => ({
        tasks: state.tasks.filter((task) => task.id !== taskId),
      }));
    },

    moveTaskInBacklog: (projectId, taskId, index) => {
      const found = findTask(projectId, taskId);
      if (!found || found.task.step !== "backlog") {
        return;
      }

      // The backlog is ordered per project: only this project's backlog
      // slots in the app-wide list are refilled.
      const isProjectBacklog = (task: Task) =>
        task.projectId === projectId && task.step === "backlog";
      const backlog = get().tasks.filter(isProjectBacklog);
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
      // Refill the backlog slots in order; everything else keeps its position.
      const reorderedIds = new Set(reordered.map((task) => task.id));
      set((state) => {
        let cursor = 0;
        return {
          tasks: state.tasks.map((task) =>
            reorderedIds.has(task.id) ? (reordered[cursor++] ?? task) : task,
          ),
        };
      });
    },

    startTask: async (projectId, taskId) => {
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

    advanceTask: async (projectId, taskId) => {
      const found = findTask(projectId, taskId);
      if (!found || found.task.completion) {
        return null;
      }

      const nextStep = getNextTaskStep(found.task.step);
      if (!nextStep || isRunBusy(getCurrentTaskRun(found.task))) {
        return null;
      }

      const previousRun = await settleCurrentRun(projectId, taskId);
      // The task may have moved while the transcript was loading.
      if (findTask(projectId, taskId)?.task.step !== found.task.step) {
        return null;
      }
      return runStep(projectId, taskId, nextStep, { previousRun });
    },

    sendTaskBack: async (projectId, taskId, toStep, note) => {
      const found = findTask(projectId, taskId);
      if (!found || found.task.completion) {
        return null;
      }

      const { task } = found;
      if (TASK_STEP_IDS.indexOf(toStep) >= TASK_STEP_IDS.indexOf(task.step)) {
        return null;
      }
      if (isRunBusy(getCurrentTaskRun(task))) {
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

    retryTaskStep: async (projectId, taskId) => {
      const found = findTask(projectId, taskId);
      if (!found || found.task.completion || found.task.step === "backlog") {
        return null;
      }

      const { task } = found;
      const currentRun = getCurrentTaskRun(task);
      if (isRunBusy(currentRun)) {
        return null;
      }

      // Hand the retry the same input the failed attempt received.
      const currentIndex = currentRun ? task.runs.indexOf(currentRun) : -1;
      const previousRun =
        currentIndex > 0 ? (task.runs[currentIndex - 1] ?? null) : null;

      return runStep(projectId, taskId, task.step as TaskRunStepId, {
        feedback: currentRun?.feedback ?? null,
        previousRun,
      });
    },

    completeTask: (projectId, taskId, completion) => {
      if (!findTask(projectId, taskId)) {
        return;
      }

      set((state) => ({
        tasks: replaceTask(state.tasks, taskId, (task) => ({
          ...task,
          completion,
          step: "merge",
          updatedAt: completion.at,
        })),
      }));
    },

    openTaskStepChat: (projectId, taskId, runId) => {
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
      const chatProject = chat
        ? findProjectById(state, chat.projectId)
        : undefined;
      if (!chat || !chatProject) {
        return;
      }

      if (!state.projects.some((entry) => entry.id === chat.projectId)) {
        // Opening a chat leads into Code, so a closed project is reopened.
        get().addProject(chatProject.path);
      } else if (state.activeProjectId !== chat.projectId) {
        get().setActiveProjectId(chat.projectId);
      }
      get().setActiveChatId(chat.projectId, chat.id);
      get().setAppView("code");
    },

    reopenTaskWorktree: async (projectId, taskId) => {
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
        // The worktree was removed outside the Tasks workspace.
        return false;
      }

      get().addProject(closedProject.path, { activate: false });
      return isOpen();
    },

    unlinkTaskRunsForChats: (chatIds) => {
      const ids = new Set(chatIds);
      if (ids.size === 0) {
        return;
      }

      set((state) => {
        const tasks = unlinkTaskRuns(
          state.tasks,
          ids,
          new Date().toISOString(),
        );
        return tasks === state.tasks ? state : { tasks };
      });
    },

    setTaskStepConfig: (step, updater) => {
      set((state) => ({
        taskConfig: {
          ...state.taskConfig,
          [step]: updater(state.taskConfig[step]),
        },
      }));
    },

    isTaskChat: (chatId) => findTaskByChatId(get().tasks, chatId) !== null,

    maybeAutoAdvanceTaskForChat: (chatId) => {
      const match = findTaskByChatId(get().tasks, chatId);
      if (!match || match.task.completion) {
        return;
      }

      const { run, task } = match;
      const currentRun = getCurrentTaskRun(task);
      if (currentRun?.id !== run.id || !run.finishedAt) {
        return;
      }

      const config = get().taskConfig[run.step];
      // Merging is always an explicit user action.
      if (!config.autoAdvance || !getNextTaskStep(task.step)) {
        return;
      }
      // A review only passes itself along on an explicit APPROVE; requested
      // changes (or no verdict at all) wait for the user to decide.
      if (
        run.step === "review" &&
        getTaskReviewVerdict(run.output) !== "approve"
      ) {
        return;
      }

      void get().advanceTask(task.projectId, task.id);
    },
  };
};
