import { EDGE_CONDITION_OPERATORS, isFallbackEdge } from "./conditions.js";
import { getGraphInputs, validateGraphInputs } from "./inputs.js";
import { validateNodeOutputs } from "./outputs.js";
import { checkPlaceholder, listPlaceholders } from "./template.js";

/**
 * Validates a graph definition before a run starts.
 *
 * Returns `{ errors, warnings }`. Cycles are intentional and never reported.
 */
export const validateGraph = ({ entryNodeId, nodes, edges, inputs }) => {
  const errors = [];
  const warnings = [];
  const nodeIds = new Set(nodes.map((node) => node.id));

  if (nodes.length === 0) {
    errors.push({ code: "no_nodes", message: "Graph has no nodes." });
    return { errors, warnings };
  }

  if (!entryNodeId || !nodeIds.has(entryNodeId)) {
    errors.push({
      code: "missing_entry",
      message: "Graph entry node is not set or does not exist.",
    });
  }

  const graphInputs = getGraphInputs({ inputs });
  validateGraphInputs({ errors, inputs: graphInputs });

  const sharingNames = new Set();
  for (const node of nodes) {
    if ((node.outputs ?? []).some((output) => output?.saveToState)) {
      if (sharingNames.has(node.name)) {
        warnings.push({
          code: "duplicate_step_name",
          message: `More than one step is named "${node.name}"; their shared outputs overwrite each other.`,
          nodeId: node.id,
        });
      }
      sharingNames.add(node.name);
    }
    for (const reference of listPlaceholders(node.instructions)) {
      const problem = checkPlaceholder(reference, {
        inputs: graphInputs,
        nodes,
      });
      if (problem) {
        warnings.push({
          code: "unknown_placeholder",
          message: `Node "${node.name}" references {{${reference}}}, but ${problem}.`,
          nodeId: node.id,
        });
      }
    }
  }

  for (const node of nodes) {
    if (!node.name || !String(node.name).trim()) {
      errors.push({
        code: "node_name",
        message: "Every node needs a name.",
        nodeId: node.id,
      });
    }
    const maxIterations = node.maxIterations ?? 5;
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      errors.push({
        code: "max_iterations",
        message: `Node "${node.name}" must allow at least one iteration.`,
        nodeId: node.id,
      });
    }
  }

  const outgoingByNode = new Map();
  for (const edge of edges) {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      errors.push({
        code: "dangling_edge",
        edgeId: edge.id,
        message: "Edge references a node that does not exist.",
      });
      continue;
    }

    const condition = edge.condition;
    if (condition !== null && condition !== undefined) {
      if (
        typeof condition.field !== "string" ||
        condition.field.trim().length === 0
      ) {
        errors.push({
          code: "condition_field",
          edgeId: edge.id,
          message: "Edge condition needs a field.",
        });
      }
      if (!EDGE_CONDITION_OPERATORS.includes(condition.operator)) {
        errors.push({
          code: "condition_operator",
          edgeId: edge.id,
          message: `Unknown condition operator "${condition.operator}".`,
        });
      }
    }

    const list = outgoingByNode.get(edge.sourceNodeId) ?? [];
    list.push(edge);
    outgoingByNode.set(edge.sourceNodeId, list);
  }

  for (const node of nodes) {
    const outgoing = outgoingByNode.get(node.id) ?? [];
    const fallbacks = outgoing.filter(isFallbackEdge);

    validateNodeOutputs({ errors, node, outgoing });

    if (fallbacks.length > 1) {
      errors.push({
        code: "multiple_fallbacks",
        message: `Node "${node.name}" has more than one unconditional edge.`,
        nodeId: node.id,
      });
    }

    if (outgoing.length > 0 && fallbacks.length === 0) {
      warnings.push({
        code: "no_fallback",
        message: `Node "${node.name}" only has conditional edges; the run completes when none match.`,
        nodeId: node.id,
      });
    }

    const seenPriorities = new Set();
    for (const edge of outgoing.filter((entry) => !isFallbackEdge(entry))) {
      const priority = Number(edge.priority ?? 0);
      if (seenPriorities.has(priority)) {
        warnings.push({
          code: "duplicate_priority",
          message: `Node "${node.name}" has edges sharing priority ${priority}; ties break by edge id.`,
          nodeId: node.id,
        });
        break;
      }
      seenPriorities.add(priority);
    }
  }

  if (entryNodeId && nodeIds.has(entryNodeId)) {
    const reachable = new Set([entryNodeId]);
    const queue = [entryNodeId];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const edge of outgoingByNode.get(current) ?? []) {
        if (!reachable.has(edge.targetNodeId)) {
          reachable.add(edge.targetNodeId);
          queue.push(edge.targetNodeId);
        }
      }
    }
    for (const node of nodes) {
      if (!reachable.has(node.id)) {
        warnings.push({
          code: "unreachable",
          message: `Node "${node.name}" is not reachable from the entry node.`,
          nodeId: node.id,
        });
      }
    }
  }

  return { errors, warnings };
};
