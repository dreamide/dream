import {
  createGoalStep,
  getGoalStepRemovalBlock,
  getGoalStepRemovalIds,
  goalRunVersion,
  isGoalRunBusy,
  isGoalRunCurrent,
  isGoalStepAccepted,
  isGoalStepReady,
  latestGoalRun,
  updateGoalRunInProjects,
} from "@/lib/goal-graph";
import type { Goal, GoalRun, GoalRunStatus, GoalStep } from "@/types/goals";
import { updateProjectUiInList } from "./helpers";
import type { IdeStoreGet, IdeStoreSet } from "./ide-store-types";

export interface GoalActions {
  removeGoalStep: (projectId: string, goalId: string, stepId: string) => void;
  addGoal: (
    projectId: string,
    value: { title: string; description: string; criteria: string },
  ) => string | null;
  updateGoal: (
    projectId: string,
    goalId: string,
    value: { title: string; description: string; criteria: string },
  ) => void;
  addGoalStep: (
    projectId: string,
    goalId: string,
    value: {
      title: string;
      instructions: string;
      dependsOn: string[];
      reviewOf?: string;
    },
  ) => string | null;
  startGoalStep: (
    projectId: string,
    goalId: string,
    stepId: string,
    feedback?: string,
  ) => string | null;
  acceptGoalStep: (projectId: string, goalId: string, stepId: string) => void;
  acceptGoal: (projectId: string, goalId: string) => void;
  recordGoalRun: (
    chatId: string,
    status: GoalRunStatus,
    output?: string,
  ) => void;
  unlinkGoalRuns: (chatIds: string[]) => void;
  importKanbanGoals: (projectId: string) => void;
}

export const createGoalActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): GoalActions => {
  const findGoal = (projectId: string, goalId: string) =>
    get()
      .projects.find((project) => project.id === projectId)
      ?.ui.goals?.find((goal) => goal.id === goalId);
  const changeGoal = (
    projectId: string,
    goalId: string,
    update: (goal: Goal) => Goal,
  ) => {
    set((state) => ({
      projects: updateProjectUiInList(state.projects, projectId, (project) => ({
        ...project.ui,
        goals: (project.ui.goals ?? []).map((goal) =>
          goal.id === goalId ? update(goal) : goal,
        ),
      })),
    }));
  };
  return {
    removeGoalStep: (projectId, goalId, stepId) => {
      set((state) => {
        const goal = state.projects
          .find((project) => project.id === projectId)
          ?.ui.goals?.find((goal) => goal.id === goalId);
        const step = goal?.steps.find((step) => step.id === stepId);
        if (
          !goal ||
          !step ||
          getGoalStepRemovalBlock(
            goal,
            step,
            state.streamingChatIds,
            state.pendingChatSubmitByChatId,
          )
        )
          return state;
        const removalIds = getGoalStepRemovalIds(goal, stepId);
        return {
          projects: updateProjectUiInList(
            state.projects,
            projectId,
            (project) => ({
              ...project.ui,
              goals: project.ui.goals.map((entry) =>
                entry.id === goalId
                  ? {
                      ...entry,
                      acceptedAt: null,
                      steps: entry.steps.filter(
                        (step) => !removalIds.has(step.id),
                      ),
                    }
                  : entry,
              ),
            }),
          ),
        };
      });
    },
    addGoal: (projectId, value) => {
      if (
        !value.title.trim() ||
        !get().projects.some((project) => project.id === projectId)
      )
        return null;
      const goal: Goal = {
        ...value,
        title: value.title.trim(),
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        acceptedAt: null,
        steps: [createGoalStep(value.title, value.description)],
      };
      set((state) => ({
        projects: updateProjectUiInList(
          state.projects,
          projectId,
          (project) => ({
            ...project.ui,
            goals: [...(project.ui.goals ?? []), goal],
          }),
        ),
      }));
      return goal.id;
    },
    updateGoal: (projectId, goalId, value) => {
      if (!value.title.trim()) return;
      changeGoal(projectId, goalId, (goal) => ({
        ...goal,
        ...value,
        title: value.title.trim(),
        acceptedAt: null,
        steps: goal.steps.map((step) => ({ ...step, acceptedRunId: null })),
      }));
    },
    addGoalStep: (projectId, goalId, value) => {
      const goal = findGoal(projectId, goalId);
      if (!goal || !value.title.trim()) return null;
      const dependsOn = [...new Set(value.dependsOn)].filter((id) =>
        goal.steps.some((step) => step.id === id),
      );
      const reviewOf =
        value.reviewOf && dependsOn.includes(value.reviewOf)
          ? value.reviewOf
          : null;
      const step: GoalStep = {
        ...createGoalStep(value.title, value.instructions),
        dependsOn,
        reviewOf,
        kind: reviewOf ? "review" : "work",
      };
      changeGoal(projectId, goalId, (goal) => ({
        ...goal,
        acceptedAt: null,
        steps: [...goal.steps, step],
      }));
      return step.id;
    },
    startGoalStep: (projectId, goalId, stepId, feedback = "") => {
      const state = get();
      const goal = findGoal(projectId, goalId);
      const step = goal?.steps.find((entry) => entry.id === stepId);
      if (
        !goal ||
        !step ||
        state.activeProjectId !== projectId ||
        !isGoalStepReady(goal, step)
      )
        return null;
      const previous = latestGoalRun(step);
      if (
        previous?.chatId &&
        (state.streamingChatIds[previous.chatId] ||
          state.pendingChatSubmitByChatId[previous.chatId])
      )
        return null;
      const inputs = step.dependsOn.flatMap((id) => {
        const dependency = goal.steps.find((entry) => entry.id === id);
        const run = dependency && latestGoalRun(dependency);
        return dependency && run ? [{ dependency, run }] : [];
      });
      const prompt = [
        `Goal: ${goal.title}`,
        goal.description,
        goal.criteria ? `Acceptance criteria:\n${goal.criteria}` : "",
        `Your step: ${step.title}`,
        step.instructions,
        step.kind === "review"
          ? "Review the actual changes and evidence against the acceptance criteria. Do not edit files. Report findings and whether the goal is met. Finishing this review does not itself accept the goal."
          : "Work only on the scope of this step. Other agents may be working in this project; preserve their changes. Finish with a concise handoff describing changes, validation, and remaining work.",
        ...inputs.map(
          ({ dependency, run }) =>
            `Input from ${dependency.title}:\n${run.output || "No text summary was recorded; inspect the project and relevant changes."}`,
        ),
        previous?.output ? `Previous attempt:\n${previous.output}` : "",
        feedback.trim()
          ? `Feedback for this iteration:\n${feedback.trim()}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const chatId = get().addChat(projectId, step.title, { forceNew: true });
      if (!chatId) return null;
      get().updateChat(chatId, (chat) => ({
        ...chat,
        agentMode: step.kind === "review" ? "plan" : "build",
        title: step.title,
      }));
      const run: GoalRun = {
        id: crypto.randomUUID(),
        chatId,
        createdAt: new Date().toISOString(),
        status: "queued",
        feedback: feedback.trim(),
        output: "",
        revision: 0,
        inputRunIds: Object.fromEntries(
          inputs.map(({ dependency, run }) => [
            dependency.id,
            goalRunVersion(run),
          ]),
        ),
      };
      // Invalidate dependent acceptances when their upstream result changes.
      const affected = new Set([stepId]);
      for (const entry of goal.steps)
        if (entry.dependsOn.some((id) => affected.has(id)))
          affected.add(entry.id);
      changeGoal(projectId, goalId, (goal) => ({
        ...goal,
        acceptedAt: null,
        steps: goal.steps.map((entry) =>
          entry.id === stepId
            ? { ...entry, acceptedRunId: null, runs: [...entry.runs, run] }
            : affected.has(entry.id)
              ? { ...entry, acceptedRunId: null }
              : entry,
        ),
      }));
      set((state) => ({
        pendingChatSubmitByChatId: {
          ...state.pendingChatSubmitByChatId,
          [chatId]: { background: true, references: [], text: prompt },
        },
      }));
      return chatId;
    },
    acceptGoalStep: (projectId, goalId, stepId) => {
      changeGoal(projectId, goalId, (goal) => ({
        ...goal,
        steps: goal.steps.map((step) =>
          step.id === stepId &&
          latestGoalRun(step)?.status === "finished" &&
          isGoalRunCurrent(goal, step)
            ? { ...step, acceptedRunId: latestGoalRun(step)?.id ?? null }
            : step,
        ),
      }));
    },
    acceptGoal: (projectId, goalId) => {
      changeGoal(projectId, goalId, (goal) =>
        goal.steps.length > 0 &&
        goal.steps.every(
          (step) => isGoalStepAccepted(step) && isGoalRunCurrent(goal, step),
        )
          ? { ...goal, acceptedAt: new Date().toISOString() }
          : goal,
      );
    },
    recordGoalRun: (chatId, status, output) =>
      set((state) => ({
        projects: updateGoalRunInProjects(
          state.projects,
          chatId,
          status,
          output,
        ),
        closedProjects: updateGoalRunInProjects(
          state.closedProjects,
          chatId,
          status,
          output,
        ),
      })),
    unlinkGoalRuns: (chatIds) => {
      const ids = new Set(chatIds);
      const unlink = (projects: ReturnType<IdeStoreGet>["projects"]) =>
        projects.map((project) => ({
          ...project,
          ui: {
            ...project.ui,
            goals: (project.ui.goals ?? []).map((goal) => ({
              ...goal,
              steps: goal.steps.map((step) => ({
                ...step,
                runs: step.runs.map((run) =>
                  run.chatId && ids.has(run.chatId)
                    ? {
                        ...run,
                        chatId: null,
                        status: isGoalRunBusy(run)
                          ? ("interrupted" as const)
                          : run.status,
                      }
                    : run,
                ),
              })),
            })),
          },
        }));
      set((state) => ({
        projects: unlink(state.projects),
        closedProjects: unlink(state.closedProjects),
      }));
    },
    importKanbanGoals: (projectId) => {
      set((state) => ({
        projects: updateProjectUiInList(
          state.projects,
          projectId,
          (project) => {
            const goals = project.ui.goals ?? [];
            const imported: Goal[] = project.ui.kanbanCards
              .filter(
                (card) =>
                  !goals.some((goal) => goal.id === `kanban:${card.id}`),
              )
              .map((card) => {
                const step = createGoalStep(card.title, card.description);
                if (card.chatId)
                  step.runs = [
                    {
                      id: crypto.randomUUID(),
                      chatId: card.chatId,
                      createdAt: card.createdAt,
                      status: "interrupted",
                      feedback: "",
                      output: "",
                      inputRunIds: {},
                      revision: 0,
                    },
                  ];
                return {
                  id: `kanban:${card.id}`,
                  title: card.title,
                  description: card.description,
                  criteria: "",
                  createdAt: card.createdAt,
                  acceptedAt: null,
                  steps: [step],
                };
              });
            return { ...project.ui, goals: [...goals, ...imported] };
          },
        ),
      }));
    },
  };
};
