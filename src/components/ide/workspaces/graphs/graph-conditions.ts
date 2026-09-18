import type {
  AgentGraph,
  EdgeCondition,
  NodeOutput,
} from "@/types/agent-graphs";

export const ELSE_HANDLE_ID = "else";
const OUTCOME_HANDLE_PREFIX = "out:";

export const outcomeHandleId = (option: string): string =>
  `${OUTCOME_HANDLE_PREFIX}${option}`;

const cleanOptions = (output: NodeOutput): string[] =>
  output.options.map((option) => option.trim()).filter(Boolean);

export const defaultValueForOutput = (
  output: NodeOutput,
): EdgeCondition["value"] => {
  switch (output.type) {
    case "enum":
      return cleanOptions(output)[0] ?? "";
    case "number":
      return 0;
    case "boolean":
      return true;
    default:
      return "";
  }
};

/** The output a node branches on: its first choice output with options. */
export const getBranchOutput = (
  outputs: NodeOutput[] | undefined,
): { key: string; options: string[] } | null => {
  for (const output of outputs ?? []) {
    if (output.key && output.type === "enum") {
      const options = cleanOptions(output);
      if (options.length > 0) {
        return { key: output.key, options };
      }
    }
  }
  return null;
};

/** Which source handle an edge leaves from (derived, never persisted). */
export const sourceHandleForEdge = (
  outputs: NodeOutput[] | undefined,
  condition: EdgeCondition | null,
): string | undefined => {
  const branch = getBranchOutput(outputs);
  if (!branch) {
    return undefined;
  }
  return condition &&
    condition.field === branch.key &&
    condition.operator === "eq" &&
    branch.options.includes(String(condition.value ?? ""))
    ? outcomeHandleId(String(condition.value))
    : ELSE_HANDLE_ID;
};

/** Condition implied by dragging from a specific outcome handle. */
export const conditionForHandle = (
  outputs: NodeOutput[] | undefined,
  handleId: string | null | undefined,
): EdgeCondition | null => {
  const branch = getBranchOutput(outputs);
  if (!branch || !handleId?.startsWith(OUTCOME_HANDLE_PREFIX)) {
    return null;
  }
  const option = handleId.slice(OUTCOME_HANDLE_PREFIX.length);
  return branch.options.includes(option)
    ? { field: branch.key, operator: "eq", value: option }
    : null;
};

/**
 * Condition for a newly drawn edge. The first edge out of a node is
 * unconditional. Further edges branch on the source node's declared outcome,
 * picking the first option no other edge handles yet, so wiring a branch is
 * just connecting nodes.
 */
export const seedConditionForNewEdge = (
  graph: AgentGraph,
  sourceNodeId: string,
  hasFallback: boolean,
): EdgeCondition | null => {
  if (!hasFallback) {
    return null;
  }

  const outputs = (
    graph.nodes.find((node) => node.id === sourceNodeId)?.outputs ?? []
  ).filter((output) => output.key);
  const branchOutput =
    outputs.find((output) => output.type === "enum") ?? outputs[0];
  if (!branchOutput) {
    return { field: "status", operator: "eq", value: "" };
  }

  if (branchOutput.type !== "enum") {
    return {
      field: branchOutput.key,
      operator: "eq",
      value: defaultValueForOutput(branchOutput),
    };
  }

  const handled = new Set(
    graph.edges
      .filter(
        (edge) =>
          edge.sourceNodeId === sourceNodeId &&
          edge.condition?.field === branchOutput.key &&
          edge.condition.operator === "eq",
      )
      .map((edge) => String(edge.condition?.value ?? "")),
  );
  const options = cleanOptions(branchOutput);
  return {
    field: branchOutput.key,
    operator: "eq",
    value: options.find((option) => !handled.has(option)) ?? options[0] ?? "",
  };
};
