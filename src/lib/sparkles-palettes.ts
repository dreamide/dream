export const SPARKLES_PALETTES = {
  dream: ["#9bf2ff", "#6ac7ff", "#caf8ff", "#5ea3ff"],
  arctic: ["#7affd1", "#9bf2ff", "#caeaff", "#ffffff"],
  gold: ["#ffe27a", "#ffb84a", "#fff7c2", "#ffd26a"],
  magenta: ["#ff9ae5", "#ff6ac7", "#ffd0f0", "#c77bff"],
  emerald: ["#5cffb0", "#2aa86a", "#b6ffd8", "#fff9c2"],
  ember: ["#ffb347", "#ff6a4a", "#ffe7c2", "#ff4a7a"],
  rainbow: ["#ffe27a", "#9bf2ff", "#ff9ae5", "#c7a6ff", "#b6ffb2"],
  mono: ["#ffffff", "#e0e4ff", "#b8beff", "#9098c9"],
} as const;

export type SparklesPaletteName = keyof typeof SPARKLES_PALETTES | "accent";

export const DEFAULT_SPARKLES_PALETTE: SparklesPaletteName = "dream";

export const SPARKLES_PALETTE_ORDER: SparklesPaletteName[] = [
  "dream",
  "accent",
  "arctic",
  "gold",
  "magenta",
  "emerald",
  "ember",
  "rainbow",
  "mono",
];

export const createAccentSparklesPalette = (accentColor?: string) => {
  if (accentColor === "black-white") {
    return [
      "var(--accent-primary)",
      "var(--accent-primary-hover)",
      "color-mix(in oklab, var(--foreground) 54%, var(--background))",
      "color-mix(in oklab, var(--foreground) 28%, var(--background))",
    ];
  }

  return [
    "var(--accent-primary)",
    "var(--accent-primary-hover)",
    "color-mix(in oklab, var(--accent-primary) 65%, white)",
    "color-mix(in oklab, var(--accent-primary) 42%, var(--background))",
  ];
};

export const normalizeSparklesPaletteName = (
  value: unknown,
): SparklesPaletteName =>
  SPARKLES_PALETTE_ORDER.includes(value as SparklesPaletteName)
    ? (value as SparklesPaletteName)
    : DEFAULT_SPARKLES_PALETTE;
