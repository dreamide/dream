import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getGoalStepRemovalBlock,
  getGoalStepRemovalIds,
} from "@/lib/goal-graph";
import type { Goal, GoalStep } from "@/types/goals";
import { useIdeStore } from "../../ide-store";
import { GoalDialog } from "./goal-dialog";

export const GoalStepMenu = ({
  projectId,
  goal,
  step,
}: {
  projectId: string;
  goal: Goal;
  step: GoalStep;
}) => {
  const t = useTranslations("goals");
  const [editing, setEditing] = useState(false);
  const removalCount = getGoalStepRemovalIds(goal, step.id).size;
  const block = useIdeStore((state) =>
    getGoalStepRemovalBlock(
      goal,
      step,
      state.streamingChatIds,
      state.pendingChatSubmitByChatId,
    ),
  );
  const removeGoalStep = useIdeStore((state) => state.removeGoalStep);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t("stepActions")}
              className="text-muted-foreground"
            />
          }
        >
          <Ellipsis className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
            {t("editStep")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={Boolean(block)}
            className="text-destructive"
            onClick={() => removeGoalStep(projectId, goal.id, step.id)}
          >
            <Trash2 className="size-3.5" />
            {removalCount > 1
              ? t("removeSteps", { count: removalCount })
              : t("removeStep")}
          </DropdownMenuItem>
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {t(
              block === "running"
                ? "removeStepRunning"
                : removalCount > 1
                  ? "removeStepsChatsKept"
                  : "removeStepChatsKept",
            )}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing ? (
        <GoalDialog
          dialog={{ mode: "editStep", goal, source: step }}
          onClose={() => setEditing(false)}
          onSubmit={(value) => {
            useIdeStore.getState().updateGoalStep(projectId, goal.id, step.id, {
              title: value.title,
              instructions: value.description,
              dependsOn: value.dependsOn,
            });
            setEditing(false);
          }}
        />
      ) : null}
    </>
  );
};
