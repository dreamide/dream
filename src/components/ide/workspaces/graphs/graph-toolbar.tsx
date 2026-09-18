import { AlertTriangle, Play, Plus, RotateCcw, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type {
  AgentGraph,
  GraphRun,
  GraphRunStatus,
  GraphValidationResult,
} from "@/types/agent-graphs";

const RUN_STATUS_VARIANT: Record<
  GraphRunStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  cancelled: "outline",
  completed: "secondary",
  failed: "destructive",
  pending: "outline",
  running: "default",
};

export interface GraphToolbarProps {
  graph: AgentGraph;
  onAddNode: () => void;
  onCancelRun: () => void;
  onRename: (name: string) => void;
  onResumeRun: () => void;
  onStartRun: () => void;
  run: GraphRun | null;
  starting: boolean;
  validation: GraphValidationResult | null;
}

export const GraphToolbar = ({
  graph,
  onAddNode,
  onCancelRun,
  onRename,
  onResumeRun,
  onStartRun,
  run,
  starting,
  validation,
}: GraphToolbarProps) => {
  const t = useTranslations("graphs");
  const [draftName, setDraftName] = useState<string | null>(null);
  const isRunning = run?.status === "running";
  const canResume =
    run?.status === "failed" && run.currentNodeId !== null && !isRunning;
  const errorCount = validation?.errors.length ?? 0;
  const warningCount = validation?.warnings.length ?? 0;
  const issueTitle = validation
    ? [...validation.errors, ...validation.warnings]
        .map((issue) => issue.message)
        .join("\n")
    : "";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <Input
        aria-label={t("graphName")}
        className="h-8 w-56 text-sm font-medium"
        onBlur={() => {
          if (draftName?.trim() && draftName !== graph.name) {
            onRename(draftName.trim());
          }
          setDraftName(null);
        }}
        onChange={(event) => setDraftName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraftName(null);
            event.currentTarget.blur();
          }
        }}
        value={draftName ?? graph.name}
      />

      {errorCount > 0 || warningCount > 0 ? (
        <span className="flex items-center gap-1 text-xs" title={issueTitle}>
          <AlertTriangle
            className={
              errorCount > 0
                ? "size-3.5 text-destructive"
                : "size-3.5 text-amber-500"
            }
          />
          {errorCount > 0
            ? t("validationErrors", { count: errorCount })
            : t("validationWarnings", { count: warningCount })}
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <Button
          disabled={isRunning}
          onClick={onAddNode}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="size-3.5" />
          {t("addNode")}
        </Button>

        {run ? (
          <Badge variant={RUN_STATUS_VARIANT[run.status]}>
            {isRunning ? <Spinner className="size-3" /> : null}
            {t(`runStatus_${run.status}`)}
          </Badge>
        ) : null}

        {isRunning ? (
          <Button
            onClick={onCancelRun}
            size="sm"
            type="button"
            variant="outline"
          >
            <Square className="size-3.5" />
            {t("cancelRun")}
          </Button>
        ) : (
          <>
            {canResume ? (
              <Button
                onClick={onResumeRun}
                size="sm"
                type="button"
                variant="outline"
              >
                <RotateCcw className="size-3.5" />
                {t("resumeRun")}
              </Button>
            ) : null}
            <Button
              disabled={starting || errorCount > 0 || graph.nodes.length === 0}
              onClick={onStartRun}
              size="sm"
              type="button"
              variant="accent"
            >
              {starting ? (
                <Spinner className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
              {t("run")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
};
