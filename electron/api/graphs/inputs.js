import { coerceDeclaredValue, OUTPUT_KEY_PATTERN } from "./outputs.js";

/**
 * Run inputs: values the user fills in when starting a run (a small form
 * generated from `graph.inputs`). They live in `state.inputs` and can be
 * referenced from instructions as `{{input.<key>}}`.
 */

export const INPUTS_STATE_KEY = "inputs";

export const getGraphInputs = (graph) =>
  Array.isArray(graph?.inputs) ? graph.inputs : [];

const cleanOptions = (input) =>
  (Array.isArray(input.options) ? input.options : [])
    .map((option) => String(option ?? "").trim())
    .filter(Boolean);

export const validateGraphInputs = ({ inputs, errors }) => {
  const seen = new Set();
  for (const input of inputs) {
    const key = String(input?.key ?? "");
    if (!OUTPUT_KEY_PATTERN.test(key)) {
      errors.push({
        code: "input_key",
        message: `Run input has an invalid name "${key}". Use letters, digits and underscores.`,
      });
      continue;
    }
    if (seen.has(key)) {
      errors.push({
        code: "input_duplicate",
        message: `Run input "${key}" is declared more than once.`,
      });
    }
    seen.add(key);
    if (input.type === "enum" && cleanOptions(input).length === 0) {
      errors.push({
        code: "input_options",
        message: `Run input "${key}" needs at least one option.`,
      });
    }
  }
};

/**
 * Coerces the values supplied at run start against the declared inputs.
 * Returns `{ values, errors }` where errors are validation issues.
 */
export const resolveRunInputs = (graph, provided) => {
  const source =
    provided && typeof provided === "object" && !Array.isArray(provided)
      ? provided
      : {};
  const values = {};
  const errors = [];

  for (const input of getGraphInputs(graph)) {
    if (!input?.key) {
      continue;
    }
    const raw = source[input.key];
    const label = input.label?.trim() || input.key;
    if (raw === undefined || raw === null || raw === "") {
      if (input.required !== false) {
        errors.push({
          code: "input_missing",
          message: `Run input "${label}" is required.`,
        });
      }
      continue;
    }
    const coerced = coerceDeclaredValue(input, raw);
    if (coerced.error) {
      errors.push({
        code: "input_invalid",
        message: `Run input ${coerced.error}`,
      });
      continue;
    }
    values[input.key] = coerced.value;
  }

  return { errors, values };
};
