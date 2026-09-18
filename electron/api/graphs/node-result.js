import { normalizeStatus } from "./outcomes.js";

/**
 * Step result contract. Agents end their response with
 *
 *   <workflow-result>
 *   { "status": "success" | "failure", "message": "…" }
 *   </workflow-result>
 *
 * Parsing is deliberately forgiving (fenced/bare JSON, trailing commas,
 * status synonyms, unclosed tag) because a strict parser only turns good work
 * into failed runs.
 */

export const WORKFLOW_RESULT_TAG = "workflow-result";

const OPEN_TAG = `<${WORKFLOW_RESULT_TAG}>`;
const TAG_PATTERN = new RegExp(
  `<${WORKFLOW_RESULT_TAG}>\\s*([\\s\\S]*?)\\s*</${WORKFLOW_RESULT_TAG}>`,
  "gi",
);
const FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
const MAX_SALVAGE_ATTEMPTS = 200;

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

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    // Most common near-miss: trailing commas before a closing brace/bracket.
    try {
      return JSON.parse(trimmed.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
};

const looksLikeResult = (value) =>
  isRecord(value) && ("status" in value || "data" in value);

/** Last JSON object in free text that looks like a result. */
const salvageResultObject = (text) => {
  const end = text.lastIndexOf("}");
  if (end === -1) {
    return null;
  }
  let attempts = 0;
  for (
    let start = text.lastIndexOf("{", end);
    start !== -1 && attempts < MAX_SALVAGE_ATTEMPTS;
    start = start === 0 ? -1 : text.lastIndexOf("{", start - 1)
  ) {
    attempts += 1;
    const parsed = tryParseJson(text.slice(start, end + 1));
    if (looksLikeResult(parsed)) {
      return parsed;
    }
  }
  return null;
};

const findResultObject = (source) => {
  const candidates = [];
  const tagged = lastMatch(TAG_PATTERN, source);
  if (tagged !== null) {
    candidates.push(tagged);
  } else {
    const openIndex = source.toLowerCase().lastIndexOf(OPEN_TAG);
    if (openIndex !== -1) {
      candidates.push(source.slice(openIndex + OPEN_TAG.length));
    }
  }
  const fenced = lastMatch(FENCE_PATTERN, source);
  if (fenced !== null) {
    candidates.push(fenced);
  }
  candidates.push(source);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (isRecord(parsed)) {
      return parsed;
    }
  }
  return salvageResultObject(source);
};

const toText = (value) =>
  typeof value === "string"
    ? value.trim()
    : value === undefined || value === null
      ? ""
      : JSON.stringify(value);

/**
 * Extracts the step result from raw agent text.
 * Returns `{ ok: true, result }` or `{ ok: false, error }`.
 *
 * `summary` and `data.status` mirror `message`/`status` so stored executions
 * keep the shape older run records (and the run history view) use.
 */
export const extractNodeResult = (text) => {
  const parsed = findResultObject(String(text ?? ""));
  if (!parsed) {
    return {
      error: `No <${WORKFLOW_RESULT_TAG}> block with valid JSON was found in the response.`,
      ok: false,
    };
  }

  const rawStatus = parsed.status ?? parsed.data?.status;
  const status = normalizeStatus(rawStatus);
  if (!status) {
    return {
      error:
        rawStatus === undefined
          ? '"status" is missing.'
          : `"status" must be "success" or "failure" (received ${JSON.stringify(rawStatus)}).`,
      ok: false,
    };
  }

  const message = toText(parsed.message ?? parsed.summary);
  return {
    ok: true,
    result: { data: { status }, message, status, summary: message },
  };
};

const MAX_FALLBACK_MESSAGE_CHARS = 8_000;

/**
 * Result of a task step. Tasks always succeed: the message comes from the
 * result block when there is one, otherwise from the response itself.
 */
export const extractTaskResult = (text) => {
  const source = String(text ?? "");
  const parsed = findResultObject(source);
  const message =
    toText(parsed?.message ?? parsed?.summary) ||
    source.trim().slice(-MAX_FALLBACK_MESSAGE_CHARS);
  return {
    ok: true,
    result: {
      data: { status: "success" },
      message,
      status: "success",
      summary: message,
    },
  };
};
