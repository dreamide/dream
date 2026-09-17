import type { Goal, GoalRun, GoalRunStatus, GoalStep } from "@/types/goals";
import type { ProjectConfig } from "@/types/ide";

export const latestGoalRun = (step: GoalStep) => step.runs.at(-1);
export const getGoalStepRemovalIds = (
  goal: Goal,
  stepId: string,
): Set<string> => {
  const ids = new Set<string>([stepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of goal.steps) {
      if (
        !ids.has(step.id) &&
        (step.dependsOn.some((id) => ids.has(id)) ||
          Boolean(step.reviewOf && ids.has(step.reviewOf)))
      ) {
        ids.add(step.id);
        changed = true;
      }
    }
  }
  return ids;
};
export const getGoalStepRemovalBlock = (
  goal: Goal,
  step: GoalStep,
  streamingChatIds: Record<string, boolean>,
  pendingChatSubmits: Record<string, unknown>,
): "running" | null => {
  const ids = getGoalStepRemovalIds(goal, step.id);
  if (
    goal.steps.some(
      (entry) =>
        ids.has(entry.id) &&
        entry.runs.some(
          (run) =>
            run.status === "queued" ||
            run.status === "running" ||
            Boolean(
              run.chatId &&
                (streamingChatIds[run.chatId] ||
                  pendingChatSubmits[run.chatId]),
            ),
        ),
    )
  )
    return "running";
  return null;
};
export const goalRunVersion = (run: GoalRun) => `${run.id}:${run.revision}`;
export const isGoalRunBusy = (run: GoalRun | undefined) =>
  run?.status === "queued" ||
  run?.status === "running" ||
  run?.status === "waiting";
export const isGoalStepAccepted = (step: GoalStep) =>
  Boolean(
    step.acceptedRunId &&
      step.acceptedRunId === latestGoalRun(step)?.id &&
      latestGoalRun(step)?.status === "finished",
  );
export const isGoalRunCurrent = (goal: Goal, step: GoalStep): boolean => {
  const run = latestGoalRun(step);
  return Boolean(
    run &&
      step.dependsOn.every((id) => {
        const dependency = goal.steps.find((entry) => entry.id === id);
        const input = dependency && latestGoalRun(dependency);
        return (
          dependency &&
          input &&
          run.inputRunIds[id] === goalRunVersion(input) &&
          isGoalRunCurrent(goal, dependency)
        );
      }),
  );
};
export const isGoalStepReady = (goal: Goal, step: GoalStep) =>
  step.dependsOn.every((id) => {
    const dependency = goal.steps.find((entry) => entry.id === id);
    return (
      dependency &&
      latestGoalRun(dependency)?.status === "finished" &&
      isGoalRunCurrent(goal, dependency)
    );
  });

export const createGoalStep = (title: string, instructions = ""): GoalStep => ({
  id: crypto.randomUUID(),
  title: title.trim(),
  instructions: instructions.trim(),
  kind: "work",
  dependsOn: [],
  reviewOf: null,
  acceptedRunId: null,
  runs: [],
});

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === "string" ? value : "");
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const timestamp = (value: unknown) =>
  Number.isFinite(Date.parse(string(value)))
    ? string(value)
    : new Date().toISOString();
const unique = <T extends { id: string }>(values: T[]) => {
  const ids = new Set<string>();
  return values.filter((value) => {
    if (!value.id || ids.has(value.id)) return false;
    ids.add(value.id);
    return true;
  });
};

// Runs never silently resume after reload. The conversation remains available
// and another iteration requires an explicit user action.
export const normalizeGoals = (value: unknown): Goal[] =>
  unique(
    array(value).map((entry) => {
      const raw = record(entry);
      const steps: GoalStep[] = unique(
        array(raw.steps).map((entry) => {
          const step = record(entry);
          const runs: GoalRun[] = unique(
            array(step.runs).map((entry) => {
              const run = record(entry);
              const status: GoalRunStatus =
                run.status === "finished" ||
                run.status === "failed" ||
                run.status === "waiting"
                  ? run.status
                  : "interrupted";
              return {
                id: string(run.id),
                chatId: string(run.chatId) || null,
                createdAt: timestamp(run.createdAt),
                status,
                feedback: string(run.feedback),
                output: string(run.output),
                inputRunIds: Object.fromEntries(
                  Object.entries(record(run.inputRunIds)).filter(
                    (entry): entry is [string, string] =>
                      typeof entry[1] === "string",
                  ),
                ),
                revision:
                  typeof run.revision === "number" &&
                  Number.isInteger(run.revision) &&
                  run.revision >= 0
                    ? run.revision
                    : 0,
              };
            }),
          );
          return {
            id: string(step.id),
            title: string(step.title),
            instructions: string(step.instructions),
            kind:
              step.kind === "review" ? ("review" as const) : ("work" as const),
            dependsOn: [
              ...new Set(array(step.dependsOn).map(string).filter(Boolean)),
            ],
            reviewOf: string(step.reviewOf) || null,
            acceptedRunId: runs.some(
              (run) =>
                run.id === step.acceptedRunId && run.status === "finished",
            )
              ? string(step.acceptedRunId)
              : null,
            runs,
          };
        }),
      );
      // Dependencies point to earlier steps. Review loops use successive runs,
      // keeping dependency ordering acyclic.
      steps.forEach((step, index) => {
        const previousIds = new Set(
          steps.slice(0, index).map((entry) => entry.id),
        );
        step.dependsOn = step.dependsOn.filter((id) => previousIds.has(id));
        if (!step.reviewOf || !step.dependsOn.includes(step.reviewOf))
          step.reviewOf = null;
      });
      return {
        id: string(raw.id),
        title: string(raw.title),
        description: string(raw.description),
        criteria: string(raw.criteria),
        createdAt: timestamp(raw.createdAt),
        acceptedAt:
          typeof raw.acceptedAt === "string" &&
          steps.length > 0 &&
          steps.every(isGoalStepAccepted)
            ? raw.acceptedAt
            : null,
        steps,
      };
    }),
  );

export const updateGoalRunInProjects = (
  projects: ProjectConfig[],
  chatId: string,
  status: GoalRunStatus,
  output?: string,
): ProjectConfig[] => {
  let changed = false;
  const next = projects.map((project) => {
    if (
      !project.ui.goals?.some((goal) =>
        goal.steps.some((step) =>
          step.runs.some((run) => run.chatId === chatId),
        ),
      )
    )
      return project;
    changed = true;
    return {
      ...project,
      ui: {
        ...project.ui,
        goals: project.ui.goals.map((goal) => {
          const affected = new Set<string>();
          if (status === "running") {
            for (const step of goal.steps) {
              if (
                latestGoalRun(step)?.chatId === chatId ||
                step.dependsOn.some((id) => affected.has(id))
              )
                affected.add(step.id);
            }
          }
          return {
            ...goal,
            acceptedAt: affected.size ? null : goal.acceptedAt,
            steps: goal.steps.map((step) => ({
              ...step,
              acceptedRunId: affected.has(step.id) ? null : step.acceptedRunId,
              runs: step.runs.map((run) =>
                run.chatId === chatId
                  ? {
                      ...run,
                      status,
                      // Continuing a completed chat changes the inputs of any review
                      // that used its previous result, even within the same run.
                      revision:
                        status === "running" &&
                        run.status !== "running" &&
                        run.status !== "queued"
                          ? run.revision + 1
                          : run.revision,
                      ...(output !== undefined ? { output } : {}),
                    }
                  : run,
              ),
            })),
          };
        }),
      },
    };
  });
  return changed ? next : projects;
};

export const layoutGoalSteps = (steps: GoalStep[]) => {
  const depths = new Map<string, number>();
  const rows = new Map<number, number>();
  return steps.map((step) => {
    const depth = Math.max(
      0,
      ...step.dependsOn.map((id) => (depths.get(id) ?? -1) + 1),
    );
    depths.set(step.id, depth);
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    return { step, x: 36 + depth * 300, y: 36 + row * 160 };
  });
};
