/**
 * Edge condition evaluation for agent graphs.
 *
 * Conditions are deliberately constrained (no expressions). They evaluate
 * against the structured `data` object returned by a node execution.
 */

export const EDGE_CONDITION_OPERATORS = [
  "eq",
  "neq",
  "exists",
  "not_exists",
  "contains",
];

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Resolves a dotted field path (`tests.status`) against `data`.
 * Returns `undefined` when any segment is missing.
 */
export const getFieldValue = (data, field) => {
  if (typeof field !== "string" || field.length === 0) {
    return undefined;
  }

  let current = data;
  for (const segment of field.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }

    if (current === undefined) {
      return undefined;
    }
  }

  return current;
};

const isStrictlyEqual = (left, right) => {
  if (left === right) {
    return true;
  }
  if (typeof left === "number" && typeof right === "number") {
    return Number.isNaN(left) && Number.isNaN(right);
  }
  return false;
};

/**
 * Evaluates a single condition against `data`. Unconditional (null/undefined)
 * conditions always match. Equality is strict — no type coercion.
 */
export const evaluateCondition = (condition, data) => {
  if (condition === null || condition === undefined) {
    return true;
  }

  const actual = getFieldValue(data, condition.field);
  const expected = condition.value;

  switch (condition.operator) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "eq":
      return isStrictlyEqual(actual, expected);
    case "neq":
      return !isStrictlyEqual(actual, expected);
    case "contains":
      if (typeof actual === "string") {
        return typeof expected === "string" && actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.some((entry) => isStrictlyEqual(entry, expected));
      }
      return false;
    default:
      return false;
  }
};

export const isFallbackEdge = (edge) =>
  edge.condition === null || edge.condition === undefined;

/**
 * Deterministic edge order: conditional edges by priority asc then id asc;
 * fallback edges always evaluate last regardless of their priority.
 */
export const sortEdgesForEvaluation = (edges) =>
  [...edges].sort((left, right) => {
    const leftFallback = isFallbackEdge(left) ? 1 : 0;
    const rightFallback = isFallbackEdge(right) ? 1 : 0;
    if (leftFallback !== rightFallback) {
      return leftFallback - rightFallback;
    }
    const leftPriority = Number(left.priority ?? 0);
    const rightPriority = Number(right.priority ?? 0);
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return String(left.id).localeCompare(String(right.id));
  });

/**
 * Picks the first outgoing edge of `nodeId` whose condition matches `data`.
 * Returns `null` when nothing matches — the node is then terminal for this
 * run and the run completes.
 */
export const resolveNextEdge = ({ edges, nodeId, data }) => {
  const outgoing = edges.filter((edge) => edge.sourceNodeId === nodeId);
  for (const edge of sortEdgesForEvaluation(outgoing)) {
    if (evaluateCondition(edge.condition, data ?? {})) {
      return edge;
    }
  }
  return null;
};
