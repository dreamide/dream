import type { AgentGraph } from "@/types/agent-graphs";

export interface GraphVariable {
  /** Human readable origin, e.g. "Run" or the step name. */
  group: string;
  /** Text inserted into instructions, without the braces. */
  reference: string;
}

/**
 * Everything a step's instructions can reference with `{{…}}`: the run task,
 * declared run inputs and outputs other steps share.
 */
export const listGraphVariables = (
  graph: AgentGraph,
  nodeId: string,
  runGroupLabel: string,
): GraphVariable[] => {
  const variables: GraphVariable[] = [
    { group: runGroupLabel, reference: "task" },
  ];
  for (const input of graph.inputs ?? []) {
    if (input.key) {
      variables.push({
        group: runGroupLabel,
        reference: `input.${input.key}`,
      });
    }
  }
  for (const node of graph.nodes) {
    if (node.id === nodeId) {
      continue;
    }
    for (const output of node.outputs ?? []) {
      if (output.key && output.saveToState) {
        variables.push({
          group: node.name,
          reference: `${node.name}.${output.key}`,
        });
      }
    }
  }
  return variables;
};
