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
import type { AiProvider } from "@/types/ide";
import { tabSurfaceClassName } from "../../tab-styles";
import { FAILURE_HANDLE_ID, SUCCESS_HANDLE_ID } from "./graph-conditions";
import type { NodeRunSummary } from "./graph-run-status";

export interface AgentNodeData extends Record<string, unknown> {
  agentLabel: string;
  isEntry: boolean;
  kind: "task" | "decision";
  name: string;
  /** Null when the step uses the project default. */
  provider: AiProvider | null;
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
        tabSurfaceClassName(Boolean(selected)),
        "relative w-52 px-3 pt-2 pb-1 text-left",
        !selected && "border-border bg-background dark:bg-background",
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
        <span className="min-w-0 flex-1 truncate font-medium">{data.name}</span>
        <StatusIcon run={data.run} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          {data.provider ? (
            <ProviderIcon
              className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400"
              provider={data.provider}
            />
          ) : null}
          <span className="truncate">{data.agentLabel}</span>
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
      {data.kind === "task" ? (
        <>
          <div className="h-1" />
          <Handle
            className={cn(HANDLE_CLASS_NAME, "!bg-muted-foreground")}
            id={SUCCESS_HANDLE_ID}
            position={Position.Bottom}
            type="source"
          />
        </>
      ) : (
        <>
          <div className="-mx-1 mt-1.5 flex border-t border-border pt-0.5 text-[11px] leading-4">
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
