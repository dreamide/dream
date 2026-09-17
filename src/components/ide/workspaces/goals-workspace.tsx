import { Check, GitBranch, History, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isGoalRunCurrent, isGoalStepAccepted } from "@/lib/goal-graph";
import type { Goal } from "@/types/goals";
import type { ProjectConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { moveTabItem, StandardTabs } from "../standard-tabs";
import { GoalCanvas } from "./goals/goal-canvas";
import {
  GoalDialog,
  type GoalDialogState,
  type GoalDialogValue,
} from "./goals/goal-dialog";
import { GoalInspector } from "./goals/goal-inspector";
import { GoalTabMenu } from "./goals/goal-tab-menu";

const EMPTY_GOALS: Goal[] = [];

export const GoalsWorkspace = ({
  project,
}: {
  active: boolean;
  project: ProjectConfig;
}) => {
  const t = useTranslations("goals");
  const goals = useIdeStore(
    (s) =>
      s.projects.find((entry) => entry.id === project.id)?.ui.goals ??
      EMPTY_GOALS,
  );
  const hasCardsToImport = useIdeStore((s) => {
    const ui = s.projects.find((entry) => entry.id === project.id)?.ui;
    return Boolean(
      ui?.kanbanCards.some(
        (card) => !ui.goals?.some((goal) => goal.id === `kanban:${card.id}`),
      ),
    );
  });
  const [goalId, setGoalId] = useState<string | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<GoalDialogState | null>(null);
  const openGoals = goals.filter((entry) => !entry.closed);
  const closedGoals = goals.filter((entry) => entry.closed);
  const goal = openGoals.find((entry) => entry.id === goalId) ?? openGoals[0];
  const setGoalClosed = (id: string, closed: boolean) => {
    useIdeStore.getState().updateProject(project.id, (current) => ({
      ...current,
      ui: {
        ...current.ui,
        goals: current.ui.goals.map((entry) =>
          entry.id === id ? { ...entry, closed } : entry,
        ),
      },
    }));
    if (!closed) {
      setGoalId(id);
      setStepId(null);
    } else if (goal?.id === id) {
      const index = openGoals.findIndex((entry) => entry.id === id);
      setGoalId(openGoals[index + 1]?.id ?? openGoals[index - 1]?.id ?? null);
      setStepId(null);
    }
  };
  const step =
    goal?.steps.find((entry) => entry.id === stepId) ?? goal?.steps[0];
  const accepted = goal?.steps.filter(isGoalStepAccepted).length ?? 0;
  const submitDialog = (value: GoalDialogValue) => {
    const state = useIdeStore.getState();
    if (dialog?.mode === "goal") {
      if (dialog.goal) state.updateGoal(project.id, dialog.goal.id, value);
      else {
        const id = state.addGoal(project.id, value);
        if (id) {
          setGoalId(id);
          setStepId(null);
        }
      }
    } else if (dialog?.mode === "editStep") {
      state.updateGoalStep(project.id, dialog.goal.id, dialog.source.id, {
        title: value.title,
        instructions: value.description,
        dependsOn: value.dependsOn,
      });
    } else if (dialog) {
      const id = state.addGoalStep(project.id, dialog.goal.id, {
        title: value.title,
        instructions: value.description,
        dependsOn: value.dependsOn,
        reviewOf: dialog.mode === "review" ? dialog.source?.id : undefined,
      });
      if (id) setStepId(id);
    }
    setDialog(null);
  };
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 p-2"
      data-project-id={project.id}
    >
      <div className="flex shrink-0 items-center gap-2 px-1">
        <StandardTabs
          className="flex-1"
          ariaLabel={t("title")}
          activeId={goal?.id ?? null}
          items={openGoals.map((entry) => ({
            id: entry.id,
            label: entry.title,
            leading: <GitBranch className="size-3.5 shrink-0" />,
          }))}
          onActivate={(id) => {
            setGoalId(id);
            setStepId(null);
          }}
          renderActions={(item) => (
            <GoalTabMenu
              title={item.label}
              onEdit={() => {
                const entry = goals.find((entry) => entry.id === item.id);
                if (entry) setDialog({ mode: "goal", goal: entry });
              }}
              onClose={() => setGoalClosed(item.id, true)}
            />
          )}
          onReorder={(from, to) => {
            if (goal) setGoalId(goal.id);
            useIdeStore.getState().updateProject(project.id, (current) => ({
              ...current,
              ui: {
                ...current.ui,
                goals: [
                  ...moveTabItem(
                    current.ui.goals.filter((entry) => !entry.closed),
                    from,
                    to,
                  ),
                  ...current.ui.goals.filter((entry) => entry.closed),
                ],
              },
            }));
          }}
          after={
            <Button
              size="icon-sm"
              variant="ghost"
              className="mb-px text-muted-foreground hover:text-foreground"
              aria-label={t("newGoal")}
              title={t("newGoal")}
              onClick={() => setDialog({ mode: "goal" })}
            >
              <Plus className="size-4 shrink-0" />
            </Button>
          }
        />
        {closedGoals.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("reopenGoal")}
                  title={t("reopenGoal")}
                />
              }
            >
              <History className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {closedGoals.map((entry) => (
                <DropdownMenuItem
                  key={entry.id}
                  onClick={() => setGoalClosed(entry.id, false)}
                >
                  {entry.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {hasCardsToImport ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useIdeStore.getState().importKanbanGoals(project.id)}
          >
            {t("importCards")}
          </Button>
        ) : null}
        {goal ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t("goalProgress", { accepted, total: goal.steps.length })}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={
                Boolean(goal.acceptedAt) ||
                !goal.steps.length ||
                !goal.steps.every(
                  (step) =>
                    isGoalStepAccepted(step) && isGoalRunCurrent(goal, step),
                )
              }
              onClick={() =>
                useIdeStore.getState().acceptGoal(project.id, goal.id)
              }
            >
              <Check className="size-3.5" />
              {t(goal.acceptedAt ? "accepted" : "acceptGoal")}
            </Button>
          </div>
        ) : null}
      </div>
      {goal ? (
        <>
          <div className="flex items-start gap-3 px-1">
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-semibold">{goal.title}</h1>
              {goal.description ? (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {goal.description}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto">
            <GoalCanvas
              projectId={project.id}
              key={goal.id}
              goal={goal}
              selectedStepId={step?.id ?? null}
              onSelect={setStepId}
            />
            {step ? (
              <GoalInspector
                key={step.id}
                projectId={project.id}
                goal={goal}
                step={step}
                onDialog={setDialog}
              />
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-surface-300 p-8 text-center dark:border-surface-700">
          <GitBranch className="mb-4 size-8 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("emptyTitle")}</h1>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            {t("emptyDescription")}
          </p>
          <Button className="mt-6" onClick={() => setDialog({ mode: "goal" })}>
            <Plus className="size-4" />
            {t("newGoal")}
          </Button>
        </div>
      )}
      {dialog ? (
        <GoalDialog
          dialog={dialog}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
        />
      ) : null}
    </div>
  );
};
