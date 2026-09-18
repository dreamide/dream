import { getFieldValue } from "./conditions.js";
import { INPUTS_STATE_KEY } from "./inputs.js";
import { STEPS_STATE_KEY } from "./outputs.js";

/**
 * `{{…}}` placeholders in node instructions.
 *
 *   {{task}}             the task entered when the run was started
 *   {{input.branch}}     a declared run input
 *   {{Plan.plan}}        output `plan` shared by the step named "Plan"
 *   {{some.state.path}}  anything else in the shared workflow state
 */

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export const MISSING_PLACEHOLDER_TEXT = "(not available yet)";

export const listPlaceholders = (text) => {
  const found = [];
  for (const match of String(text ?? "").matchAll(PLACEHOLDER_PATTERN)) {
    found.push(match[1].trim());
  }
  return found;
};

const splitReference = (reference) => {
  const index = reference.indexOf(".");
  return index === -1
    ? [reference, ""]
    : [reference.slice(0, index).trim(), reference.slice(index + 1).trim()];
};

const resolveReference = (reference, state) => {
  const [head, rest] = splitReference(reference);
  if ((head === "input" || head === "inputs") && rest) {
    return getFieldValue(state?.[INPUTS_STATE_KEY] ?? {}, rest);
  }
  const step = state?.[STEPS_STATE_KEY]?.[head];
  if (step && rest) {
    return getFieldValue(step, rest);
  }
  return getFieldValue(state ?? {}, reference);
};

export const renderTemplate = (text, state) =>
  String(text ?? "").replace(PLACEHOLDER_PATTERN, (_match, reference) => {
    const value = resolveReference(reference.trim(), state);
    if (value === undefined || value === null || value === "") {
      return MISSING_PLACEHOLDER_TEXT;
    }
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });

/**
 * Static check of a placeholder against the graph definition. Returns a
 * problem description, or null when the reference can resolve at run time.
 */
export const checkPlaceholder = (reference, { inputs, nodes }) => {
  const [head, rest] = splitReference(reference);
  if (head === "task" && !rest) {
    return null;
  }
  if (head === "input" || head === "inputs") {
    return inputs.some((input) => input.key === rest)
      ? null
      : `run input "${rest}" is not declared`;
  }
  const step = nodes.find((node) => node.name === head);
  if (step) {
    const rootKey = rest.split(".")[0];
    const output = (step.outputs ?? []).find((entry) => entry.key === rootKey);
    if (!output) {
      return `step "${head}" has no output "${rootKey}"`;
    }
    return output.saveToState
      ? null
      : `output "${rootKey}" of step "${head}" is not shared with later steps`;
  }
  // Free-form state paths (written via stateUpdates) cannot be checked.
  return null;
};
