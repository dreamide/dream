import {
  Handle,
  type Node,
  type NodeProps,
  Position,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { Ban, Check, Flag, RefreshCw, X } from "lucide-react";
import { memo, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { tabSurfaceClassName } from "../../tab-styles";
import { ELSE_HANDLE_ID, outcomeHandleId } from "./graph-conditions";
import type { NodeRunSummary } from "./graph-run-status";

export interface AgentNodeData extends Record<string, unknown> {
  agentLabel: string;
  /** Outcomes of the node's branching output; one source handle each. */
  branchOptions: string[];
  elseLabel: string;
  isEntry: boolean;
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

const HANDLE_CLASS_NAME =
  "!size-2.5 !border-2 !border-background !bg-muted-foreground";

const AgentNodeComponent = ({
  data,
  id,
  selected,
}: NodeProps<AgentFlowNode>) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const handleKey = data.branchOptions.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleKey tracks the rendered handles
  useEffect(() => {
    updateNodeInternals(id);
  }, [handleKey, id, updateNodeInternals]);

  const outcomes =
    data.branchOptions.length > 0
      ? [
          ...data.branchOptions.map((option) => ({
            id: outcomeHandleId(option),
            label: option,
          })),
          { id: ELSE_HANDLE_ID, label: data.elseLabel },
        ]
      : [];

  return (
    <div
      className={cn(
        tabSurfaceClassName(Boolean(selected)),
        "relative w-52 px-3 py-2 text-left",
        !selected && "border-border bg-background dark:bg-background",
      )}
      data-node-status={data.run.visual}
    >
      <Handle
        className={HANDLE_CLASS_NAME}
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
        <span className="truncate">{data.agentLabel}</span>
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
      {outcomes.length > 0 ? (
        <>
          <div className="-mx-1 mt-1.5 flex border-t border-border pt-1">
            {outcomes.map((outcome) => (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate px-0.5 text-center text-[10px] leading-4",
                  outcome.id === ELSE_HANDLE_ID
                    ? "text-muted-foreground italic"
                    : "font-mono",
                )}
                key={outcome.id}
                title={outcome.label}
              >
                {outcome.label}
              </span>
            ))}
          </div>
          {outcomes.map((outcome, index) => (
            <Handle
              className={HANDLE_CLASS_NAME}
              id={outcome.id}
              key={outcome.id}
              position={Position.Bottom}
              style={{ left: `${((index + 0.5) / outcomes.length) * 100}%` }}
              type="source"
            />
          ))}
        </>
      ) : (
        <Handle
          className={HANDLE_CLASS_NAME}
          position={Position.Bottom}
          type="source"
        />
      )}
    </div>
  );
};

export const AgentNode = memo(AgentNodeComponent);
AgentNode.displayName = "AgentNode";
