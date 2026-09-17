import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getGoalStepRemovalIds } from "@/lib/goal-graph";
import type { Goal, GoalStep } from "@/types/goals";

export type GoalDialogState =
  | { mode: "goal"; goal?: Goal }
  | { mode: "editStep"; goal: Goal; source: GoalStep }
  | { mode: "step" | "branch" | "review"; goal: Goal; source?: GoalStep };
export interface GoalDialogValue {
  title: string;
  description: string;
  criteria: string;
  dependsOn: string[];
}

export const GoalDialog = ({
  dialog,
  onClose,
  onSubmit,
}: {
  dialog: GoalDialogState;
  onClose: () => void;
  onSubmit: (value: GoalDialogValue) => void;
}) => {
  const t = useTranslations("goals");
  const id = useId();
  const source = dialog.mode === "goal" ? undefined : dialog.source;
  const excludedDependencies =
    dialog.mode === "editStep"
      ? getGoalStepRemovalIds(dialog.goal, dialog.source.id)
      : new Set<string>();
  const [title, setTitle] = useState(
    dialog.mode === "goal"
      ? (dialog.goal?.title ?? "")
      : dialog.mode === "editStep"
        ? dialog.source.title
        : dialog.mode === "review" && source
          ? t("reviewTitle", { title: source.title })
          : "",
  );
  const [description, setDescription] = useState(
    dialog.mode === "goal"
      ? (dialog.goal?.description ?? "")
      : dialog.mode === "editStep"
        ? dialog.source.instructions
        : dialog.mode === "review"
          ? t("reviewInstructions")
          : "",
  );
  const [criteria, setCriteria] = useState(
    dialog.mode === "goal" ? (dialog.goal?.criteria ?? "") : "",
  );
  const [dependsOn, setDependsOn] = useState<string[]>(
    source
      ? dialog.mode === "branch" || dialog.mode === "editStep"
        ? source.dependsOn
        : [source.id]
      : [],
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim())
              onSubmit({
                title: title.trim(),
                description: description.trim(),
                criteria: criteria.trim(),
                dependsOn,
              });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                dialog.mode === "goal"
                  ? dialog.goal
                    ? "editGoal"
                    : "newGoal"
                  : dialog.mode === "editStep"
                    ? "editStep"
                    : dialog.mode === "review"
                      ? "addReview"
                      : dialog.mode === "branch"
                        ? "branch"
                        : "addStep",
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${id}-title`}>{t("titleLabel")}</Label>
            <Input
              autoFocus
              id={`${id}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t(
                dialog.mode === "goal" ? "goalPlaceholder" : "stepTitle",
              )}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-description`}>
              {t(dialog.mode === "goal" ? "descriptionLabel" : "instructions")}
            </Label>
            <Textarea
              id={`${id}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
            />
          </div>
          {dialog.mode === "goal" ? (
            <div className="space-y-2">
              <Label htmlFor={`${id}-criteria`}>{t("criteriaLabel")}</Label>
              <Textarea
                id={`${id}-criteria`}
                value={criteria}
                onChange={(event) => setCriteria(event.target.value)}
                placeholder={t("criteriaPlaceholder")}
                rows={3}
              />
              {dialog.goal ? (
                <p className="text-xs text-muted-foreground">
                  {t("editCriteriaHint")}
                </p>
              ) : null}
            </div>
          ) : (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">
                {t("dependencies")}
              </legend>
              {dialog.goal.steps
                .filter((step) => !excludedDependencies.has(step.id))
                .map((step) => (
                  <label
                    key={step.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={dependsOn.includes(step.id)}
                      disabled={
                        (dialog.mode === "review" && step.id === source?.id) ||
                        (dialog.mode === "editStep" &&
                          step.id === source?.reviewOf)
                      }
                      onChange={(event) =>
                        setDependsOn((ids) =>
                          event.target.checked
                            ? [...ids, step.id]
                            : ids.filter((id) => id !== step.id),
                        )
                      }
                    />
                    {step.title}
                  </label>
                ))}
              {dialog.mode === "editStep" ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t("editDependenciesHint")}
                  </p>
                  {source?.reviewOf ? (
                    <p className="text-xs text-muted-foreground">
                      {t("reviewDependencyHint")}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {t("editStepHint")}
                  </p>
                </>
              ) : null}
            </fieldset>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!title.trim()}>
              {t(
                dialog.mode === "editStep" ||
                  (dialog.mode === "goal" && dialog.goal)
                  ? "save"
                  : "create",
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
