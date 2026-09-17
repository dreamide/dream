import {
  Check,
  GitBranch,
  MessageCircle,
  Play,
  RotateCcw,
  ScanEye,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  isGoalRunCurrent,
  isGoalStepAccepted,
  isGoalStepReady,
  latestGoalRun,
  layoutGoalSteps,
} from "@/lib/goal-graph";
import { cn } from "@/lib/utils";
import type { Goal, GoalStep } from "@/types/goals";
import { GoalStepMenu } from "./goal-step-menu";

export const goalStepStatus = (goal: Goal, step: GoalStep) => {
  const run = latestGoalRun(step);
  if (run && !isGoalRunCurrent(goal, step)) return "stale";
  if (isGoalStepAccepted(step)) return "accepted";
  if (run) return run.status;
  return isGoalStepReady(goal, step) ? "ready" : "blocked";
};

export const GoalCanvas = ({
  projectId,
  goal,
  selectedStepId,
  onSelect,
}: {
  projectId: string;
  goal: Goal;
  selectedStepId: string | null;
  onSelect: (id: string) => void;
}) => {
  const t = useTranslations("goals");
  const markerId = useId().replaceAll(":", "");
  const [zoom, setZoom] = useState(1);
  const layout = useMemo(() => layoutGoalSteps(goal.steps), [goal.steps]);
  const width = Math.max(580, ...layout.map((node) => node.x + 284));
  const height = Math.max(340, ...layout.map((node) => node.y + 154));
  return (
    <div className="relative min-h-64 min-w-0 flex-1 overflow-hidden rounded-lg border border-surface-300 bg-surface-50 dark:border-surface-700 dark:bg-surface-900">
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-surface-300 bg-background p-1 shadow-sm dark:border-surface-700">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("zoomOut")}
          disabled={zoom <= 0.6}
          onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))}
        >
          <ZoomOut className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("resetZoom")}
          onClick={() => setZoom(1)}
          className="h-6 text-xs tabular-nums"
        >
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("zoomIn")}
          disabled={zoom >= 1.4}
          onClick={() => setZoom((value) => Math.min(1.4, value + 0.1))}
        >
          <ZoomIn className="size-3.5" />
        </Button>
      </div>
      <div
        className="h-full overflow-auto [--graph-dot:var(--color-surface-300)] dark:[--graph-dot:var(--color-surface-700)]"
        style={{
          backgroundImage:
            "radial-gradient(var(--graph-dot) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      >
        <div
          style={{
            width: width * zoom,
            height: height * zoom,
            minWidth: "100%",
            minHeight: "100%",
          }}
        >
          <div
            className="relative origin-top-left"
            style={{ width, height, transform: `scale(${zoom})` }}
          >
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-muted-foreground/40"
            >
              <defs>
                <marker
                  id={markerId}
                  markerWidth="6"
                  markerHeight="6"
                  refX="5"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L6,3 L0,6" fill="currentColor" />
                </marker>
              </defs>
              {layout.flatMap((node) =>
                node.step.dependsOn.map((dependencyId) => {
                  const source = layout.find(
                    (entry) => entry.step.id === dependencyId,
                  );
                  if (!source) return null;
                  const fromX = source.x + 248;
                  const fromY = source.y + 56;
                  const toY = node.y + 56;
                  return (
                    <path
                      key={`${dependencyId}-${node.step.id}`}
                      d={`M ${fromX} ${fromY} C ${fromX + 26} ${fromY}, ${node.x - 26} ${toY}, ${node.x - 3} ${toY}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      markerEnd={`url(#${markerId})`}
                    />
                  );
                }),
              )}
              {layout.flatMap((node) => {
                const target = layout.find(
                  (entry) => entry.step.id === node.step.reviewOf,
                );
                if (!target) return [];
                const y = Math.max(node.y, target.y) + 138;
                return [
                  <path
                    key={`feedback-${node.step.id}`}
                    d={`M ${node.x + 124} ${node.y + 112} V ${y} H ${target.x + 124} V ${target.y + 115}`}
                    fill="none"
                    stroke="currentColor"
                    strokeDasharray="4 4"
                    strokeWidth="1.5"
                    markerEnd={`url(#${markerId})`}
                  />,
                ];
              })}
            </svg>
            <fieldset aria-label={t("graphLabel")}>
              {layout.map(({ step, x, y }) => {
                const status = goalStepStatus(goal, step);
                const Icon =
                  status === "accepted"
                    ? Check
                    : step.kind === "review"
                      ? ScanEye
                      : GitBranch;
                return (
                  <div
                    key={step.id}
                    className="absolute h-28 w-[248px]"
                    style={{ left: x, top: y }}
                  >
                    <button
                      type="button"
                      aria-pressed={selectedStepId === step.id}
                      onClick={() => onSelect(step.id)}
                      className={cn(
                        "flex h-full w-full flex-col rounded-lg border bg-background p-3 text-left shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        selectedStepId === step.id
                          ? "border-primary ring-1 ring-primary/25"
                          : "border-surface-300 hover:border-surface-400 dark:border-surface-700 dark:hover:border-surface-600",
                      )}
                    >
                      <span className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <Icon className="size-3.5" />
                        {t(step.kind)}
                        <span className="ml-auto mr-6 tabular-nums">
                          {step.runs.length
                            ? t("runNumber", { number: step.runs.length })
                            : null}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-sm font-medium leading-5">
                        {step.title}
                      </span>
                      <span
                        className={cn(
                          "mt-auto flex items-center gap-1.5 pt-2 text-xs",
                          status === "running"
                            ? "text-blue-500"
                            : status === "accepted"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : status === "waiting" || status === "failed"
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground",
                        )}
                      >
                        {status === "running" ? (
                          <span className="size-1.5 animate-pulse rounded-full bg-current" />
                        ) : status === "waiting" ? (
                          <MessageCircle className="size-3" />
                        ) : status === "stale" ? (
                          <RotateCcw className="size-3" />
                        ) : status === "ready" ? (
                          <Play className="size-3" />
                        ) : (
                          <span className="size-1.5 rounded-full bg-current opacity-60" />
                        )}
                        {t(status)}
                      </span>
                    </button>
                    <div className="absolute right-2 top-2">
                      <GoalStepMenu
                        projectId={projectId}
                        goal={goal}
                        step={step}
                      />
                    </div>
                  </div>
                );
              })}
            </fieldset>
          </div>
        </div>
      </div>
    </div>
  );
};
