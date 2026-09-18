import {
  Handle,
  type Node,
  type NodeProps,
  Position,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { Ban, Check, Flag, RefreshCw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useEffect } from "react";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { NodeAgentDisplay } from "./graph-agent-display";
import { FAILURE_HANDLE_ID, SUCCESS_HANDLE_ID } from "./graph-conditions";
import type { NodeRunSummary } from "./graph-run-status";

export interface AgentNodeData extends Record<string, unknown> {
  agent: NodeAgentDisplay;
  isEntry: boolean;
  kind: "task" | "decision";
  name: string;
  run: NodeRunSummary;
}

export type AgentFlowNode = Node<AgentNodeData, "agent">;

const StatusIcon = ({ run }: { run: NodeRunSummary }) => {
  switch (run.visual) {
    case "running":
      return <Spinner className="size-3.5 text-primary" />;
    case "completed":
      return <Check className="size-3.5 text-emerald-500" />;
    case "revisited":
      return <RefreshCw className="size-3.5 text-sky-500" />;
    case "failed":
      return <X className="size-3.5 text-destructive" />;
    case "cancelled":
      return <Ban className="size-3.5 text-muted-foreground" />;
    default:
      return null;
  }
};

const HANDLE_CLASS_NAME = "!size-2.5 !border-2 !border-background";

/**
 * A step. Tasks have a single exit; decisions have two — success on the
 * bottom left and failure on the bottom right — so routing is just
 * drawing a line.
 */
const AgentNodeComponent = ({
  data,
  id,
  selected,
}: NodeProps<AgentFlowNode>) => {
  // The exits change when a step switches between task and decision.
  const t = useTranslations("graphs");
  const modelT = useTranslations("models");
  const { agent } = data;
  const settings = [
    agent.agentMode === "plan" ? t("modePlanShort") : t("modeBuildShort"),
    agent.effort ? modelT(agent.effort) : null,
    agent.speed ? modelT(agent.speed) : null,
  ].filter(Boolean);
  const updateNodeInternals = useUpdateNodeInternals();
  const kind = data.kind;
  useEffect(() => {
    if (kind) {
      updateNodeInternals(id);
    }
  }, [id, kind, updateNodeInternals]);

  return (
    <div
      className={cn(
        // Same surface as the kanban card; selection is shown by the border.
        "relative w-60 rounded-md border bg-background p-3 text-left text-foreground shadow-sm transition-colors",
        selected
          ? "border-foreground"
          : "border-surface-300 hover:border-surface-400 dark:border-surface-700 dark:hover:border-surface-600",
      )}
      data-node-status={data.run.visual}
    >
      <Handle
        className={cn(HANDLE_CLASS_NAME, "!bg-muted-foreground")}
        position={Position.Top}
        type="target"
      />
      <div className="flex items-center gap-2">
        {data.isEntry ? (
          <Flag className="size-3.5 shrink-0 text-primary" />
        ) : null}
        <span className="min-w-0 flex-1 truncate font-semibold text-sm leading-5">
          {data.name}
        </span>
        <StatusIcon run={data.run} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-muted-foreground text-xs leading-5">
        <span className="flex min-w-0 items-center gap-1.5">
          {agent.provider ? (
            <ProviderIcon
              className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400"
              provider={agent.provider}
            />
          ) : null}
          <span className="truncate">
            {agent.modelLabel || (agent.provider ? null : t("inheritProject"))}
          </span>
          {agent.isDefault && agent.provider ? (
            <Badge
              className="shrink-0 rounded px-1 py-0 text-[10px] font-normal"
              title={t("inheritProject")}
              variant="secondary"
            >
              {t("defaultBadge")}
            </Badge>
          ) : null}
        </span>
        {data.run.count > 0 ? (
          <Badge
            variant="secondary"
            className={cn(
              "shrink-0 rounded-full px-1.5 py-px font-mono text-[11px]",
              data.run.count > 1
                ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                : "bg-muted text-muted-foreground",
            )}
            title={`${data.run.count} execution(s)`}
          >
            ↻ {data.run.count}
          </Badge>
        ) : null}
      </div>
      <div className="truncate text-muted-foreground text-xs leading-5">
        {settings.join(" · ")}
      </div>
      {data.kind === "task" ? (
        <Handle
          className={cn(HANDLE_CLASS_NAME, "!bg-muted-foreground")}
          id={SUCCESS_HANDLE_ID}
          position={Position.Bottom}
          type="source"
        />
      ) : (
        <>
          <div className="-mx-3 -mb-1.5 mt-2.5 flex border-surface-200 border-t pt-1 text-[11px] leading-4 dark:border-surface-800">
            <span className="flex-1 text-center text-emerald-600 dark:text-emerald-400">
              {t("success")}
            </span>
            <span className="flex-1 text-center text-destructive">
              {t("failure")}
            </span>
          </div>
          <Handle
            className={cn(HANDLE_CLASS_NAME, "!bg-emerald-500")}
            id={SUCCESS_HANDLE_ID}
            position={Position.Bottom}
            style={{ left: "25%" }}
            type="source"
          />
          <Handle
            className={cn(HANDLE_CLASS_NAME, "!bg-destructive")}
            id={FAILURE_HANDLE_ID}
            position={Position.Bottom}
            style={{ left: "75%" }}
            type="source"
          />
        </>
      )}
    </div>
  );
};

export const AgentNode = memo(AgentNodeComponent);
AgentNode.displayName = "AgentNode";
