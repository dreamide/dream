/** @typedef {"ask" | "auto-accept-edits" | "full-access"} ChatPermissionMode */

/**
 * Normalize persisted permissions without turning an unknown value into a grant.
 * The former Standard setting depended on the former Plan/Build setting.
 * @param {unknown} value
 * @param {unknown} [legacyAgentMode]
 * @param {ChatPermissionMode} [fallback]
 * @returns {ChatPermissionMode}
 */
export const normalizeChatPermissionMode = (
  value,
  legacyAgentMode,
  fallback = "full-access",
) => {
  if (
    value === "ask" ||
    value === "auto-accept-edits" ||
    value === "full-access"
  ) {
    return value;
  }
  if (value === "standard") {
    return legacyAgentMode === "plan" ? "ask" : "auto-accept-edits";
  }
  return value == null ? fallback : "ask";
};
