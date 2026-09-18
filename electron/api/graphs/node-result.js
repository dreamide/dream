import { z } from "zod";

/**
 * Structured node result contract. Agents must return this in a
 * `<workflow-result>` block (or a fenced ```json block as fallback) at the
 * end of their response. Conditions evaluate against `data`.
 */
export const nodeResultSchema = z.object({
  summary: z.string().default(""),
  data: z.record(z.string(), z.unknown()).default({}),
  stateUpdates: z.record(z.string(), z.unknown()).optional(),
  artifacts: z
    .array(
      z.object({
        kind: z.string().min(1),
        path: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

export const WORKFLOW_RESULT_TAG = "workflow-result";

const TAG_PATTERN = new RegExp(
  `<${WORKFLOW_RESULT_TAG}>\\s*([\\s\\S]*?)\\s*</${WORKFLOW_RESULT_TAG}>`,
  "gi",
);
const FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/gi;

const lastMatch = (pattern, text) => {
  let result = null;
  pattern.lastIndex = 0;
  for (;;) {
    const match = pattern.exec(text);
    if (!match) {
      break;
    }
    result = match[1];
  }
  return result;
};

const tryParseJson = (candidate) => {
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

/**
 * Extracts and validates the structured result from raw agent text.
 * Returns `{ ok: true, result }` or `{ ok: false, error }`.
 */
export const extractNodeResult = (text) => {
  const source = String(text ?? "");
  const candidates = [];

  const tagged = lastMatch(TAG_PATTERN, source);
  if (tagged !== null) {
    candidates.push(tagged);
  }
  const fenced = lastMatch(FENCE_PATTERN, source);
  if (fenced !== null) {
    candidates.push(fenced);
  }
  candidates.push(source);

  let sawJson = false;
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    sawJson = true;
    const validated = nodeResultSchema.safeParse(parsed);
    if (validated.success) {
      return { ok: true, result: validated.data };
    }
    return {
      ok: false,
      error: `Workflow result did not match the expected schema: ${validated.error.message}`,
    };
  }

  return {
    ok: false,
    error: sawJson
      ? "Workflow result JSON was not an object."
      : `No <${WORKFLOW_RESULT_TAG}> block with valid JSON was found in the agent response.`,
  };
};

/**
 * Shallow top-level merge of state updates. Nodes should namespace their
 * keys (e.g. `tests`, `plan`) to avoid clobbering each other.
 */
export const mergeRunState = (state, updates) => {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    return { ...(state ?? {}) };
  }
  return { ...(state ?? {}), ...updates };
};
