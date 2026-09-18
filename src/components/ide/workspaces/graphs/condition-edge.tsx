import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import { memo } from "react";
import { cn } from "@/lib/utils";

export interface ConditionEdgeData extends Record<string, unknown> {
  highlighted: boolean;
  isBackward: boolean;
  isFallback: boolean;
  label: string;
  traversed: boolean;
}

export type ConditionFlowEdge = Edge<ConditionEdgeData, "condition">;

/**
 * Self-loop path: leaves the bottom handle, swings out to the right and
 * re-enters the top handle so the loop stays visible instead of collapsing.
 */
const getSelfLoopPath = (
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): [string, number, number] => {
  const offset = 70;
  const path = `M ${sourceX} ${sourceY} C ${sourceX + offset} ${sourceY + offset}, ${targetX + offset * 1.6} ${targetY - offset}, ${targetX} ${targetY}`;
  return [path, sourceX + offset * 1.15, (sourceY + targetY) / 2];
};

const ConditionEdgeComponent = ({
  data,
  id,
  markerEnd,
  selected,
  source,
  sourcePosition,
  sourceX,
  sourceY,
  target,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps<ConditionFlowEdge>) => {
  const isSelfLoop = source === target;
  const [path, labelX, labelY] = isSelfLoop
    ? getSelfLoopPath(sourceX, sourceY, targetX, targetY)
    : getBezierPath({
        curvature: data?.isBackward ? 0.6 : 0.25,
        sourcePosition,
        sourceX,
        sourceY,
        targetPosition,
        targetX,
        targetY,
      });

  const highlighted = Boolean(data?.highlighted);
  const traversed = Boolean(data?.traversed);

  return (
    <>
      <BaseEdge
        className={cn(
          "transition-[stroke] duration-300",
          highlighted && "animate-pulse",
        )}
        id={id}
        markerEnd={markerEnd}
        path={path}
        style={{
          stroke: highlighted
            ? "var(--color-primary)"
            : selected
              ? "var(--color-foreground)"
              : traversed
                ? "var(--color-sky-500)"
                : "var(--color-muted-foreground)",
          strokeDasharray: data?.isFallback ? undefined : "6 4",
          strokeWidth: highlighted || selected ? 2.5 : traversed ? 2 : 1.5,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={cn(
            "pointer-events-auto absolute max-w-40 truncate rounded-md border px-1.5 py-px font-mono text-[11px] leading-4 shadow-xs",
            selected
              ? "border-foreground bg-background text-foreground"
              : data?.isFallback
                ? "border-border bg-muted text-muted-foreground"
                : "border-border bg-background text-foreground dark:bg-surface-900",
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          title={data?.label}
        >
          {data?.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

export const ConditionEdge = memo(ConditionEdgeComponent);
ConditionEdge.displayName = "ConditionEdge";
