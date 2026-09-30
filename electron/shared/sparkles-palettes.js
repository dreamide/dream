// @ts-check
// Sparkles palette names shared by the renderer and the main process. The
// colours live with the renderer; only the names need to agree on both sides.

export const SPARKLES_PALETTE_ORDER = /** @type {const} */ ([
  "aqua",
  "accent",
  "violet",
  "gold",
  "magenta",
  "emerald",
  "ember",
  "rainbow",
  "mono",
]);

/** @typedef {(typeof SPARKLES_PALETTE_ORDER)[number]} SparklesPaletteName */

/** @type {SparklesPaletteName} */
export const DEFAULT_SPARKLES_PALETTE = "aqua";

/**
 * Accepts the retired names "arctic" and "dream" so older chats keep a
 * palette instead of falling back to the default.
 * @param {unknown} value
 * @returns {SparklesPaletteName}
 */
export const normalizeSparklesPaletteName = (value) =>
  value === "arctic"
    ? "violet"
    : value === "dream"
      ? "aqua"
      : SPARKLES_PALETTE_ORDER.includes(
            /** @type {SparklesPaletteName} */ (value),
          )
        ? /** @type {SparklesPaletteName} */ (value)
        : DEFAULT_SPARKLES_PALETTE;
