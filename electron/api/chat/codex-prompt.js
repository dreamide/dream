// Codex-specific reading of session ids and errors. What a turn sends any
// provider, Codex included, is the Turn prompt's (turn-prompt.js).

export const getCodexSessionId = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const isCodexResumeFailure = (detail) => {
  if (typeof detail !== "string") {
    return false;
  }

  const normalized = detail.toLowerCase();
  return (
    normalized.includes("thread/resume failed") ||
    normalized.includes("no rollout found for thread id")
  );
};

const parseCodexErrorPayload = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

export const getCodexErrorDetail = (event) => {
  if (!event || typeof event !== "object") {
    return null;
  }

  const directMessage =
    typeof event.message === "string" ? event.message.trim() : "";
  const parsedDirectMessage = parseCodexErrorPayload(directMessage);
  const nestedMessage =
    typeof event.error?.message === "string" ? event.error.message.trim() : "";
  const parsedNestedMessage = parseCodexErrorPayload(nestedMessage);

  return (
    parsedDirectMessage?.error?.message ||
    directMessage ||
    parsedNestedMessage?.error?.message ||
    nestedMessage ||
    null
  );
};
