type BootSparkleShape = "star" | "dot" | "glow" | "diamond" | "plus";
type BootSparkleConfig = {
  clockSync: boolean;
  density: number;
  height: number;
  palette: string[];
  position: "top" | "bottom";
  shape: "mixed" | BootSparkleShape;
  sizeMul: number;
  speed: number;
  sway: number;
  syncKey: string;
};

const BOOT_SPARKLES: BootSparkleConfig = {
  clockSync: true,
  density: 50,
  height: 256,
  palette: ["#ffffff", "#e0e4ff", "#b8beff", "#9098c9"],
  position: "bottom",
  shape: "mixed",
  sizeMul: 0.8,
  speed: 0.6,
  sway: 40,
  syncKey: "dream-loading-sparkles",
};

const hash = (seed: string) => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const seededRandom = (seed: string) => {
  let t = hash(seed);
  return () => {
    t += 0x6d2b79f5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const initBootLoadingSparkles = () => {
  const field = document.querySelector<HTMLDivElement>(".boot-sparkles-field");
  if (!field || field.childElementCount > 0) return;

  const {
    clockSync,
    density,
    height,
    position,
    shape,
    sizeMul,
    speed,
    sway,
    syncKey,
  } = BOOT_SPARKLES;
  const width = field.clientWidth || 64;
  const elapsed = Date.now() / 1000;
  const rand = seededRandom(
    `${syncKey}:${density}:${position}:${shape}:${width}`,
  );
  const randRange = (min: number, max: number) => min + rand() * (max - min);
  const pickIndex = (length: number) =>
    Math.min(length - 1, Math.floor(rand() * length));

  for (let i = 0; i < density; i += 1) {
    const spark = document.createElement("span");
    const roll = rand();
    const sparkShape: BootSparkleShape =
      shape !== "mixed"
        ? shape
        : roll < 0.5
          ? "star"
          : roll < 0.75
            ? "dot"
            : roll < 0.9
              ? "glow"
              : "diamond";
    const baseSize =
      sparkShape === "glow" ? randRange(3, 6) : rand() < 0.6 ? 2 : 3;
    const duration = randRange(2.2, 5.8) / speed;
    const left = randRange(6, width - 6);
    const clockOffset = randRange(0, duration);
    const animationDelay = clockSync
      ? -((elapsed + clockOffset) % duration)
      : randRange(-duration, 0.2);
    const swayValue = randRange(-sway, sway);
    const colorIndex = pickIndex(BOOT_SPARKLES.palette.length);

    spark.className = `boot-spark boot-${sparkShape}`;
    spark.style.setProperty("--size", `${Math.max(1, baseSize * sizeMul)}px`);
    spark.style.setProperty("--c", BOOT_SPARKLES.palette[colorIndex]);
    spark.style.setProperty("--rise", `${height}px`);
    spark.style.setProperty("--sway", `${swayValue.toFixed(1)}px`);
    spark.style.left = `${left}px`;
    spark.style.animationDuration = `${duration.toFixed(2)}s`;
    spark.style.animationDelay = `${animationDelay.toFixed(2)}s`;
    field.appendChild(spark);
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initBootLoadingSparkles, {
    once: true,
  });
} else {
  initBootLoadingSparkles();
}
