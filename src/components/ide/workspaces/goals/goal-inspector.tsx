import {
  ArrowUpRight,
  Check,
  GitBranch,
  Play,
  Plus,
  RotateCcw,
  ScanEye,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  isGoalRunCurrent,
  isGoalStepAccepted,
  isGoalStepReady,
  latestGoalRun,
} from "@/lib/goal-graph";
import { cn } from "@/lib/utils";
import type { Goal, GoalStep } from "@/types/goals";
import { useIdeStore } from "../../ide-store";
import { goalStepStatus } from "./goal-canvas";
import type { GoalDialogState } from "./goal-dialog";

export const GoalInspector = ({
  projectId,
  goal,
  step,
  onDialog,
}: {
  projectId: string;
  goal: Goal;
  step: GoalStep;
  onDialog: (dialog: GoalDialogState) => void;
}) => {
  const t = useTranslations("goals");
  const format = useFormatter();
  const feedbackId = useId();
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const latest = latestGoalRun(step);
  const run = step.runs.find((run) => run.id === selectedRunId) ?? latest;
  const startGoalStep = useIdeStore((s) => s.startGoalStep);
  const acceptGoalStep = useIdeStore((s) => s.acceptGoalStep);
  const live = useIdeStore((s) =>
    Boolean(
      latest?.chatId &&
        (s.streamingChatIds[latest.chatId] ||
          s.pendingChatSubmitByChatId[latest.chatId]),
    ),
  );
  const chatAvailable = useIdeStore((s) =>
    Boolean(
      run?.chatId &&
        s.chats.some(
          (chat) => chat.id === run.chatId && chat.deletedAt === null,
        ),
    ),
  );
  const start = (stepId: string, notes: string) => {
    const chatId = startGoalStep(projectId, goal.id, stepId, notes);
    setError(!chatId);
    if (chatId) {
      setFeedback("");
      setSelectedRunId(null);
    }
  };
  const openChat = () => {
    if (!run?.chatId || !chatAvailable) return;
    const state = useIdeStore.getState();
    state.setActiveChatId(projectId, run.chatId);
    state.setProjectWorkspaceView(projectId, "code");
  };
  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto rounded-lg border border-surface-300 bg-background shadow-sm dark:border-surface-700">
      <div className="space-y-3 border-b border-surface-200 p-4 dark:border-surface-800">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {step.kind === "review" ? (
            <ScanEye className="size-3.5" />
          ) : (
            <GitBranch className="size-3.5" />
          )}
          {t(step.kind)}
          <span className="ml-auto">{t(goalStepStatus(goal, step))}</span>
        </div>
        <h2 className="break-words text-sm font-semibold">{step.title}</h2>
        {step.instructions ? (
          <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
            {step.instructions}
          </p>
        ) : null}
        {step.dependsOn.length ? (
          <div className="text-xs text-muted-foreground">
            <p className="mb-1 font-medium">{t("dependencies")}</p>
            {step.dependsOn.map((id) => (
              <p key={id}>
                ↳ {goal.steps.find((entry) => entry.id === id)?.title}
              </p>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDialog({ mode: "step", goal, source: step })}
          >
            <Plus className="size-3.5" />
            {t("addStep")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDialog({ mode: "branch", goal, source: step })}
          >
            <GitBranch className="size-3.5" />
            {t("branch")}
          </Button>
          {step.kind === "work" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDialog({ mode: "review", goal, source: step })}
            >
              <ScanEye className="size-3.5" />
              {t("addReview")}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="space-y-3 border-b border-surface-200 p-4 dark:border-surface-800">
        {latest ? (
          <div className="space-y-2">
            <Label htmlFor={feedbackId}>{t("feedback")}</Label>
            <Textarea
              id={feedbackId}
              rows={3}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder={t("feedbackPlaceholder")}
            />
          </div>
        ) : null}
        <Button
          className="w-full"
          size="sm"
          disabled={live || !isGoalStepReady(goal, step)}
          onClick={() => start(step.id, feedback)}
        >
          {latest ? (
            <RotateCcw className="size-3.5" />
          ) : (
            <Play className="size-3.5" />
          )}
          {t(latest ? "retry" : "start")}
        </Button>
        {!isGoalStepReady(goal, step) ? (
          <p className="text-xs text-muted-foreground">{t("blocked")}</p>
        ) : null}
        {step.reviewOf &&
        latest?.status === "finished" &&
        isGoalRunCurrent(goal, step) ? (
          <Button
            className="w-full"
            size="sm"
            variant="outline"
            onClick={() =>
              start(
                step.reviewOf as string,
                [latest.output, feedback].filter(Boolean).join("\n\n"),
              )
            }
          >
            <RotateCcw className="size-3.5" />
            {t("revise")}
          </Button>
        ) : null}
        {latest?.status === "finished" && isGoalRunCurrent(goal, step) ? (
          <Button
            className="w-full"
            size="sm"
            variant="outline"
            disabled={isGoalStepAccepted(step)}
            onClick={() => acceptGoalStep(projectId, goal.id, step.id)}
          >
            <Check className="size-3.5" />
            {t(isGoalStepAccepted(step) ? "accepted" : "acceptStep")}
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {t("startFailed")}
          </p>
        ) : null}
      </div>
      <div className="space-y-3 p-4">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t("runs")}
        </h3>
        {!step.runs.length ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {t("noRuns")}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1">
              {step.runs.map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={run?.id === entry.id}
                  onClick={() => setSelectedRunId(entry.id)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs",
                    run?.id === entry.id
                      ? "border-surface-300 bg-muted text-foreground dark:border-surface-600"
                      : "border-transparent text-muted-foreground hover:bg-muted",
                  )}
                >
                  {t("runNumber", { number: index + 1 })}
                </button>
              ))}
            </div>
            {run ? (
              <>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t(run.status)}</span>
                  <time dateTime={run.createdAt}>
                    {format.dateTime(new Date(run.createdAt), {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={!chatAvailable}
                  onClick={openChat}
                >
                  <ArrowUpRight className="size-3.5" />
                  {t(chatAvailable ? "openChat" : "chatUnavailable")}
                </Button>
                {run.feedback ? (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">
                      {t("feedback")}
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap break-words leading-5">
                      {run.feedback}
                    </p>
                  </details>
                ) : null}
                <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                  {run.output || t("noOutput")}
                </p>
              </>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
};
