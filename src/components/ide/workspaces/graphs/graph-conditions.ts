import type { GraphEdge, StepOutcome } from "@/types/agent-graphs";

/**
 * Every step has exactly two exits, which double as React Flow handle ids.
 */
export const SUCCESS_HANDLE_ID: StepOutcome = "success";
export const FAILURE_HANDLE_ID: StepOutcome = "failure";

const LEGACY_SUCCESS_VALUES = new Set([
  "success",
  "passed",
  "ok",
  "done",
  "approved",
  "yes",
  "true",
]);

/**
 * Outcome an edge leaves through. Run snapshots recorded by earlier versions
 * carry a `condition` instead of an `outcome`; map those approximately so old
 * runs still render.
 */
export const edgeOutcome = (
  edge: Pick<GraphEdge, "condition" | "outcome">,
): StepOutcome => {
  if (edge.outcome === "success" || edge.outcome === "failure") {
    return edge.outcome;
  }
  if (edge.condition === null || edge.condition === undefined) {
    return "success";
  }
  return LEGACY_SUCCESS_VALUES.has(
    String(edge.condition.value ?? "").toLowerCase(),
  )
    ? "success"
    : "failure";
};

export const outcomeFromHandle = (
  handleId: string | null | undefined,
): StepOutcome => (handleId === FAILURE_HANDLE_ID ? "failure" : "success");
