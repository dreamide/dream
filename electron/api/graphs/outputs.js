/**
 * Declared node outputs.
 *
 * A node may declare the fields it returns in `data`. Declarations drive:
 *   - the generated output contract in the prompt (users never hand-write it)
 *   - normalization/validation of the agent's result (case, whitespace, types)
 *   - edge condition validation and the edge inspector dropdowns
 *   - automatic sharing of values with later steps (`saveToState`)
 *
 * Nodes without declared outputs keep the legacy free-form behaviour.
 */

export const OUTPUT_TYPES = ["enum", "text", "number", "boolean"];

export const OUTPUT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shared-state key under which declared outputs are published per step. */
export const STEPS_STATE_KEY = "steps";

export const getNodeOutputs = (node) =>
  Array.isArray(node?.outputs) ? node.outputs : [];

const isRequired = (output) => output.required !== false;

const cleanOptions = (output) =>
  (Array.isArray(output.options) ? output.options : [])
    .map((option) => String(option ?? "").trim())
    .filter(Boolean);

const findDataKey = (data, key) => {
  if (Object.hasOwn(data, key)) {
    return key;
  }
  const lowered = key.toLowerCase();
  return Object.keys(data).find((entry) => entry.toLowerCase() === lowered);
};

const TRUE_WORDS = new Set(["true", "yes", "y", "1"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0"]);

export const coerceDeclaredValue = (output, raw) => {
  switch (output.type) {
    case "enum": {
      const options = cleanOptions(output);
      const text = String(raw).trim().toLowerCase();
      const match = options.find((option) => option.toLowerCase() === text);
      return match === undefined
        ? {
            error: `"${output.key}" must be one of ${options
              .map((option) => JSON.stringify(option))
              .join(", ")} (received ${JSON.stringify(raw)}).`,
          }
        : { value: match };
    }
    case "number": {
      const parsed =
        typeof raw === "number"
          ? raw
          : Number(String(raw).trim() || Number.NaN);
      return Number.isFinite(parsed)
        ? { value: parsed }
        : {
            error: `"${output.key}" must be a number (received ${JSON.stringify(raw)}).`,
          };
    }
    case "boolean": {
      if (typeof raw === "boolean") {
        return { value: raw };
      }
      const text = String(raw).trim().toLowerCase();
      if (TRUE_WORDS.has(text)) return { value: true };
      if (FALSE_WORDS.has(text)) return { value: false };
      return {
        error: `"${output.key}" must be true or false (received ${JSON.stringify(raw)}).`,
      };
    }
    default:
      return {
        value: typeof raw === "string" ? raw : JSON.stringify(raw),
      };
  }
};

/**
 * Normalizes agent-returned `data` against the node's declared outputs.
 * Returns `{ data, errors }`; undeclared keys pass through untouched.
 */
export const normalizeResultData = (node, data) => {
  const outputs = getNodeOutputs(node);
  const normalized = { ...(data ?? {}) };
  const errors = [];

  for (const output of outputs) {
    if (!output?.key) {
      continue;
    }
    const actualKey = findDataKey(normalized, output.key);
    const raw = actualKey === undefined ? undefined : normalized[actualKey];
    if (actualKey !== undefined && actualKey !== output.key) {
      delete normalized[actualKey];
    }

    if (raw === undefined || raw === null || raw === "") {
      delete normalized[output.key];
      if (isRequired(output)) {
        errors.push(`"${output.key}" is required but was not provided.`);
      }
      continue;
    }

    const coerced = coerceDeclaredValue(output, raw);
    if (coerced.error) {
      errors.push(coerced.error);
      continue;
    }
    normalized[output.key] = coerced.value;
  }

  return { data: normalized, errors };
};

/**
 * Publishes `saveToState` outputs under `state.steps[<node name>]` so later
 * steps see them without the agent hand-writing `stateUpdates`.
 */
export const mergeSharedOutputs = (state, node, data) => {
  const shared = {};
  for (const output of getNodeOutputs(node)) {
    if (output?.saveToState && output.key && data?.[output.key] !== undefined) {
      shared[output.key] = data[output.key];
    }
  }
  if (Object.keys(shared).length === 0) {
    return state;
  }
  const steps =
    state?.[STEPS_STATE_KEY] &&
    typeof state[STEPS_STATE_KEY] === "object" &&
    !Array.isArray(state[STEPS_STATE_KEY])
      ? state[STEPS_STATE_KEY]
      : {};
  return {
    ...(state ?? {}),
    [STEPS_STATE_KEY]: {
      ...steps,
      [node.name]: { ...(steps[node.name] ?? {}), ...shared },
    },
  };
};

const describeType = (output) => {
  switch (output.type) {
    case "enum":
      return `exactly one of: ${cleanOptions(output)
        .map((option) => JSON.stringify(option))
        .join(", ")}`;
    case "number":
      return "a number";
    case "boolean":
      return "true or false";
    default:
      return "a string";
  }
};

const exampleValue = (output) => {
  switch (output.type) {
    case "enum":
      return cleanOptions(output)
        .map((option) => JSON.stringify(option))
        .join(" | ");
    case "number":
      return "0";
    case "boolean":
      return "true | false";
    default:
      return '"..."';
  }
};

/** `"status": "passed" | "failed", "notes": "..."` for the prompt example. */
export const formatOutputsExample = (node) =>
  getNodeOutputs(node)
    .filter((output) => output?.key)
    .map((output) => `${JSON.stringify(output.key)}: ${exampleValue(output)}`)
    .join(", ");

/** One bullet per declared output describing the exact contract. */
export const formatOutputsContract = (node) =>
  getNodeOutputs(node)
    .filter((output) => output?.key)
    .map((output) => {
      const parts = [
        `- \`${output.key}\` (${isRequired(output) ? "required" : "optional, omit when not applicable"}): ${describeType(output)}.`,
      ];
      if (output.description?.trim()) {
        parts.push(output.description.trim());
      }
      return parts.join(" ");
    });

/**
 * Validates output declarations and the edge conditions that reference them.
 * Pushes issues into `errors` / `warnings`.
 */
export const validateNodeOutputs = ({ node, outgoing, errors }) => {
  const outputs = getNodeOutputs(node);
  const seen = new Set();

  for (const output of outputs) {
    const key = String(output?.key ?? "");
    if (!OUTPUT_KEY_PATTERN.test(key)) {
      errors.push({
        code: "output_key",
        message: `Node "${node.name}" has an output with an invalid name "${key}". Use letters, digits and underscores.`,
        nodeId: node.id,
      });
      continue;
    }
    if (seen.has(key)) {
      errors.push({
        code: "output_duplicate",
        message: `Node "${node.name}" declares output "${key}" more than once.`,
        nodeId: node.id,
      });
    }
    seen.add(key);
    if (output.type === "enum" && cleanOptions(output).length === 0) {
      errors.push({
        code: "output_options",
        message: `Output "${key}" of node "${node.name}" needs at least one option.`,
        nodeId: node.id,
      });
    }
  }

  if (outputs.length === 0) {
    return;
  }

  for (const edge of outgoing) {
    const condition = edge.condition;
    if (!condition || typeof condition.field !== "string") {
      continue;
    }
    const rootField = condition.field.split(".")[0];
    const output = outputs.find((entry) => entry.key === rootField);
    if (!output) {
      errors.push({
        code: "condition_unknown_field",
        edgeId: edge.id,
        message: `Edge from "${node.name}" checks "${condition.field}", which is not an output of that node.`,
      });
      continue;
    }
    if (
      output.type === "enum" &&
      (condition.operator === "eq" || condition.operator === "neq") &&
      !cleanOptions(output).includes(String(condition.value ?? ""))
    ) {
      errors.push({
        code: "condition_unknown_value",
        edgeId: edge.id,
        message: `Edge from "${node.name}" compares "${output.key}" with ${JSON.stringify(condition.value ?? "")}, which is not one of its options.`,
      });
    }
  }
};
