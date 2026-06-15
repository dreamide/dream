/*
  <Sparkles /> — wraps any component; a field of pixel sparkles rises from
  the top edge of the children by default, like a spell being conjured.

  Usage:
    <Sparkles palette="arctic">
      <YourInput />
    </Sparkles>

 Props:
    palette    "aqua" | "accent" | "arctic" | "gold" | "magenta" | "emerald" | "ember" | "rainbow" | "mono"
               OR an array of hex strings for a custom palette   (default: "aqua")
    disabled   disables sparkles and ground glow                 (default: false)
    position   "top" | "bottom" origin edge                      (default: "top")
    density    number of ambient sparkles                         (default: 80)
    speed      multiplier — 1 = normal, 2× faster            (default: 1)
    sizeMul    pixel-size multiplier                              (default: 1)
    sway       max horizontal drift in px                         (default: 40)
    height     rise-field height in px                            (default: 360)
    shape      "mixed" | "star" | "dot" | "glow" | "diamond" | "plus"
                                                                  (default: "mixed")
    groundGlow boolean — soft glow at the top edge of children    (default: true)
    syncKey    stable seed for deterministic sparkle placement
    clockSync  align animation phase to wall-clock time            (default: false)
    burstRef   React ref; ref.current.cast(count?) triggers burst
    className / style  applied to outer wrapper
    children   the component(s) the sparkles rise from

  Imperative:
    const ref = useRef(null);
    <Sparkles ref={ref}>...</Sparkles>
    ref.current.cast(70);   // one-off burst
*/

import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  DEFAULT_SPARKLES_PALETTE,
  SPARKLES_PALETTE_ORDER,
  SPARKLES_PALETTES,
  type SparklesPaletteName,
} from "@/lib/sparkles-palettes";

type SparklesShape = "mixed" | "star" | "dot" | "glow" | "diamond" | "plus";
type SparklesPosition = "top" | "bottom";

export interface SparklesHandle {
  cast: (count?: number) => void;
}

export interface SparklesProps extends HTMLAttributes<HTMLDivElement> {
  disabled?: boolean;
  position?: SparklesPosition;
  palette?: SparklesPaletteName | string[];
  density?: number;
  speed?: number;
  sizeMul?: number;
  sway?: number;
  height?: number;
  shape?: SparklesShape;
  groundGlow?: boolean;
  syncKey?: string;
  clockSync?: boolean;
  cyclePalette?: SparklesPaletteName;
  cycleOnClick?: boolean;
  cyclePalettes?: SparklesPaletteName[];
  onPaletteChange?: (palette: SparklesPaletteName) => void;
  children?: ReactNode;
}

function sparklesRand(a: number, b: number) {
  return a + Math.random() * (b - a);
}
function sparklesPick<T>(items: readonly T[]) {
  return items[(Math.random() * items.length) | 0];
}
function sparklesHash(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function sparklesSeededRand(seed: string) {
  let t = sparklesHash(seed);
  return () => {
    t += 0x6d2b79f5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function sparklesHexToRGBA(hex: string, alpha: number) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    return `color-mix(in oklab, ${hex} ${Math.round(alpha * 100)}%, transparent)`;
  }

  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

const CUSTOM_SPARKLES_PALETTE_PREFIX = "custom:";
const PRESET_SPARKLES_PALETTE_PREFIX = "preset:";
type PredefinedSparklesPaletteName = keyof typeof SPARKLES_PALETTES;
const FALLBACK_SPARKLES_PALETTE: PredefinedSparklesPaletteName = "aqua";

const isPredefinedSparklesPaletteName = (
  value: SparklesPaletteName,
): value is PredefinedSparklesPaletteName => value in SPARKLES_PALETTES;

const getSparklesPaletteKey = (palette: SparklesProps["palette"]) =>
  Array.isArray(palette)
    ? `${CUSTOM_SPARKLES_PALETTE_PREFIX}${palette.join("\u0000")}`
    : `${PRESET_SPARKLES_PALETTE_PREFIX}${palette}`;

const getSparklesPaletteColors = (paletteKey: string) => {
  if (paletteKey.startsWith(CUSTOM_SPARKLES_PALETTE_PREFIX)) {
    const colors = paletteKey
      .slice(CUSTOM_SPARKLES_PALETTE_PREFIX.length)
      .split("\u0000")
      .filter(Boolean);

    return colors.length > 0
      ? colors
      : SPARKLES_PALETTES[FALLBACK_SPARKLES_PALETTE];
  }

  const paletteName = paletteKey.slice(
    PRESET_SPARKLES_PALETTE_PREFIX.length,
  ) as SparklesPaletteName;

  return isPredefinedSparklesPaletteName(paletteName)
    ? SPARKLES_PALETTES[paletteName]
    : SPARKLES_PALETTES[FALLBACK_SPARKLES_PALETTE];
};

/* ---------- Inject component styles once ---------- */
const SPARKLES_STYLE_ID = "sparkles-wrapper-styles";
function ensureSparklesStyles() {
  if (document.getElementById(SPARKLES_STYLE_ID)) return;
  const css = `
    .sparkles-wrap {
      position: relative;
      display: block;
    }
    .sparkles-field {
      position: absolute;
      left: 0; right: 0;
      height: var(--sp-h, 360px);
      pointer-events: none;
      overflow: visible;
      z-index: 3;
    }
    .sparkles-field.sparkles-field-top {
      bottom: 100%;
    }
    .sparkles-field.sparkles-field-bottom {
      bottom: 0;
    }
    .sparkles-field::after {
      content: "";
      position: absolute;
      left: 6%; right: 6%;
      height: 50px;
      filter: blur(10px);
      opacity: var(--sp-glow-op, 0);
      animation: sparkles-glow-pulse 2.4s ease-in-out infinite;
    }
    .sparkles-field.sparkles-field-top::after {
      bottom: -8px;
      background: radial-gradient(60% 100% at 50% 100%, var(--sp-glow, rgba(122,255,209,.4)), transparent 70%);
    }
    .sparkles-field.sparkles-field-bottom::after {
      bottom: -8px;
      background: radial-gradient(60% 100% at 50% 100%, var(--sp-glow, rgba(122,255,209,.4)), transparent 70%);
    }
    @keyframes sparkles-glow-pulse {
      0%,100% { opacity: calc(var(--sp-glow-op, .8) * .7); }
      50%     { opacity: var(--sp-glow-op, .8); }
    }
    .sparkles-spark {
      position: absolute;
      width: var(--size, 2px);
      height: var(--size, 2px);
      background: transparent;
      animation-timing-function: linear;
      animation-iteration-count: infinite;
      will-change: transform, opacity;
    }
    .sparkles-spark.sparkles-spark-top {
      bottom: 0;
      animation-name: sparkles-rise-top;
    }
    .sparkles-spark.sparkles-spark-bottom {
      bottom: 0;
      animation-name: sparkles-rise-top;
    }
    .sparkles-spark.sp-star {
      box-shadow:
        0 calc(var(--size) * -1) 0 var(--c),
        0 var(--size) 0 var(--c),
        calc(var(--size) * -1) 0 0 var(--c),
        var(--size) 0 0 var(--c),
        0 0 0 var(--c),
        calc(var(--size) * -1) calc(var(--size) * -1) 0 color-mix(in oklab, var(--c) 45%, transparent),
        var(--size) calc(var(--size) * -1) 0 color-mix(in oklab, var(--c) 45%, transparent),
        calc(var(--size) * -1) var(--size) 0 color-mix(in oklab, var(--c) 45%, transparent),
        var(--size) var(--size) 0 color-mix(in oklab, var(--c) 45%, transparent);
    }
    .sparkles-spark.sp-diamond {
      box-shadow:
        0 calc(var(--size) * -2) 0 var(--c),
        0 calc(var(--size) *  2) 0 var(--c),
        calc(var(--size) * -2) 0 0 var(--c),
        calc(var(--size) *  2) 0 0 var(--c),
        0 calc(var(--size) * -1) 0 var(--c),
        0 calc(var(--size) *  1) 0 var(--c),
        calc(var(--size) * -1) 0 0 var(--c),
        calc(var(--size) *  1) 0 0 var(--c),
        0 0 0 #fff;
    }
    .sparkles-spark.sp-dot {
      border-radius: 50%;
      background: var(--c);
      box-shadow: 0 0 6px var(--c), 0 0 2px #fff;
    }
    .sparkles-spark.sp-plus {
      box-shadow:
        0 calc(var(--size) * -1) 0 var(--c),
        0 var(--size) 0 var(--c),
        calc(var(--size) * -1) 0 0 var(--c),
        var(--size) 0 0 var(--c),
        0 0 0 var(--c);
    }
    .sparkles-spark.sp-glow {
      border-radius: 50%;
      background: var(--c);
      filter: blur(1px);
      box-shadow: 0 0 12px var(--c), 0 0 4px var(--c), 0 0 2px #fff;
    }
    @keyframes sparkles-rise-top {
      0%   { transform: translate3d(0, 0, 0) scale(.3); opacity: 0; }
      10%  { transform: translate3d(0, calc(var(--rise, 360px) * -.05), 0) scale(1); opacity: 1; }
      50%  { transform: translate3d(var(--sway), calc(var(--rise, 360px) * -.5), 0) scale(1); opacity: 1; }
      85%  { transform: translate3d(calc(var(--sway) * -0.4), calc(var(--rise, 360px) * -.9), 0) scale(.8); opacity: .55; }
      100% { transform: translate3d(calc(var(--sway) * -0.8), calc(var(--rise, 360px) * -1.05), 0) scale(.2); opacity: 0; }
    }
  `;
  const el = document.createElement("style");
  el.id = SPARKLES_STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

const Sparkles = forwardRef<SparklesHandle, SparklesProps>(
  function Sparkles(props, ref) {
    const {
      disabled = false,
      position = "top",
      palette = DEFAULT_SPARKLES_PALETTE,
      density = 80,
      speed = 1,
      sizeMul = 1,
      sway = 40,
      height = 360,
      shape = "mixed",
      groundGlow = true,
      syncKey,
      clockSync = false,
      cyclePalette,
      cycleOnClick = false,
      cyclePalettes = SPARKLES_PALETTE_ORDER,
      onPaletteChange,
      className = "",
      style,
      children,
      ...rest
    } = props;

    const fieldRef = useRef<HTMLDivElement | null>(null);
    const paletteArrRef = useRef<readonly string[]>([]);
    const paletteKey = getSparklesPaletteKey(palette);

    const paletteArr = useMemo(
      () => getSparklesPaletteColors(paletteKey),
      [paletteKey],
    );
    paletteArrRef.current = paletteArr;

    useLayoutEffect(ensureSparklesStyles, []);

    /* ---- Structural rebuild: only when element count/classes must change ---- */
    const sparksRef = useRef<HTMLSpanElement[]>([]);
    /* Store base (pre-multiplied) sizes so style-only updates can rescale */
    const baseSizesRef = useRef<number[]>([]);
    /* Store base (pre-speed) durations so speed changes don't rebuild */
    const baseDursRef = useRef<number[]>([]);
    const colorIndexesRef = useRef<number[]>([]);
    const clockOffsetsRef = useRef<number[]>([]);

    useEffect(() => {
      const field = fieldRef.current;
      if (!field) return;
      const fieldEl = field;

      if (disabled) {
        fieldEl.innerHTML = "";
        sparksRef.current = [];
        baseSizesRef.current = [];
        baseDursRef.current = [];
        colorIndexesRef.current = [];
        clockOffsetsRef.current = [];
        return;
      }

      let cancelled = false;

      function build() {
        if (cancelled) return;
        fieldEl.innerHTML = "";
        const sparks: HTMLSpanElement[] = [];
        const bases: number[] = [];
        const durs: number[] = [];
        const colorIndexes: number[] = [];
        const clockOffsets: number[] = [];
        const width = fieldEl.clientWidth || 700;
        const rand = syncKey
          ? sparklesSeededRand(
              `${syncKey}:${density}:${position}:${shape}:${width}`,
            )
          : Math.random;
        const randRange = (a: number, b: number) => a + rand() * (b - a);
        const pickIndex = (length: number) =>
          Math.min(length - 1, Math.floor(rand() * length));
        const elapsed = Date.now() / 1000;

        for (let i = 0; i < density; i++) {
          const s = document.createElement("span");
          let kind: Exclude<SparklesShape, "mixed">;
          if (shape === "mixed") {
            const r = rand();
            if (r < 0.5) kind = "star";
            else if (r < 0.75) kind = "dot";
            else if (r < 0.9) kind = "glow";
            else kind = "diamond";
          } else kind = shape;

          s.className = `sparkles-spark sparkles-spark-${position} sp-${kind}`;

          const baseSize =
            kind === "glow" ? randRange(3, 6) : rand() < 0.6 ? 2 : 3;
          const baseDur = randRange(2.2, 5.8);
          const x = randRange(6, width - 6);

          /* Apply current visual props (will also be updated in the style effect) */
          const size = Math.max(1, baseSize * sizeMul);
          const duration = baseDur / speed;
          const clockOffset = randRange(0, duration);
          const delay = clockSync
            ? -((elapsed + clockOffset) % duration)
            : randRange(-duration, 0.2);
          const swayV = randRange(-sway, sway);
          const currentPalette = paletteArrRef.current;
          const colorIndex = pickIndex(currentPalette.length);

          s.style.setProperty("--size", `${size}px`);
          s.style.setProperty("--c", currentPalette[colorIndex]);
          s.style.setProperty("--sway", `${swayV.toFixed(1)}px`);
          s.style.setProperty("--rise", `${height}px`);
          s.style.left = `${x}px`;
          s.style.animationDuration = `${duration.toFixed(2)}s`;
          s.style.animationDelay = `${delay.toFixed(2)}s`;

          fieldEl.appendChild(s);
          sparks.push(s);
          bases.push(baseSize);
          durs.push(baseDur);
          colorIndexes.push(colorIndex);
          clockOffsets.push(clockOffset);
        }
        sparksRef.current = sparks;
        baseSizesRef.current = bases;
        baseDursRef.current = durs;
        colorIndexesRef.current = colorIndexes;
        clockOffsetsRef.current = clockOffsets;
      }

      build();
      const ro = new ResizeObserver(() => build());
      ro.observe(fieldEl);
      return () => {
        cancelled = true;
        ro.disconnect();
      };
      /* Only structural props that change element count or CSS classes */
    }, [
      density,
      disabled,
      position,
      shape,
      syncKey,
      clockSync,
      height,
      speed,
      sizeMul,
      sway,
    ]);

    /* ---- Style-only patch: update existing sparkles in-place, no reset ---- */
    useEffect(() => {
      const field = fieldRef.current;
      if (!field) return;

      field.style.setProperty("--sp-h", `${height}px`);
      field.style.setProperty(
        "--sp-glow",
        sparklesHexToRGBA(paletteArr[0], 0.45),
      );
      field.style.setProperty(
        "--sp-glow-op",
        !disabled && groundGlow ? ".9" : "0",
      );
      field.style.pointerEvents = cycleOnClick ? "auto" : "none";

      if (disabled) return;

      const sparks = sparksRef.current;
      const bases = baseSizesRef.current;
      const durs = baseDursRef.current;
      const colorIndexes = colorIndexesRef.current;
      const clockOffsets = clockOffsetsRef.current;
      const elapsed = Date.now() / 1000;

      for (let i = 0; i < sparks.length; i++) {
        const s = sparks[i];
        if (!s.isConnected) continue;
        const size = Math.max(1, bases[i] * sizeMul);
        const duration = durs[i] / speed;
        const colorIndex = colorIndexes[i] ?? 0;

        s.style.setProperty("--size", `${size}px`);
        s.style.setProperty("--c", paletteArr[colorIndex % paletteArr.length]);
        s.style.setProperty("--rise", `${height}px`);
        s.style.animationDuration = `${duration.toFixed(2)}s`;
        if (clockSync) {
          s.style.animationDelay = `-${((elapsed + (clockOffsets[i] ?? 0)) % duration).toFixed(2)}s`;
        }
      }
    }, [
      speed,
      sizeMul,
      height,
      groundGlow,
      paletteArr,
      disabled,
      clockSync,
      cycleOnClick,
    ]);

    const castBurst = useCallback(
      (count = 70) => {
        const field = fieldRef.current;
        if (!field || disabled) return;
        const fieldEl = field;
        const width = fieldEl.clientWidth || 700;
        for (let i = 0; i < count; i++) {
          const s = document.createElement("span");
          s.className = `sparkles-spark sparkles-spark-${position} ${Math.random() < 0.7 ? "sp-star" : "sp-glow"}`;
          const size = (Math.random() < 0.5 ? 2 : 3) * sizeMul;
          const dur = sparklesRand(0.9, 1.7) / speed;
          const swayV = sparklesRand(-sway * 2.2, sway * 2.2);
          s.style.setProperty("--size", `${size}px`);
          s.style.setProperty("--c", sparklesPick(paletteArr));
          s.style.setProperty("--sway", `${swayV.toFixed(1)}px`);
          s.style.setProperty("--rise", `${height}px`);
          s.style.left = `${sparklesRand(10, width - 10)}px`;
          s.style.animationDuration = `${dur.toFixed(2)}s`;
          fieldEl.appendChild(s);
          setTimeout(() => s.remove(), dur * 1000 + 200);
        }
      },
      [disabled, height, paletteArr, position, sizeMul, speed, sway],
    );

    useImperativeHandle(ref, () => ({ cast: castBurst }), [castBurst]);

    useEffect(() => {
      const field = fieldRef.current;
      if (!field || !cycleOnClick) {
        return;
      }

      const handleClick = (event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          !onPaletteChange ||
          cyclePalettes.length === 0
        ) {
          return;
        }

        const currentPalette =
          cyclePalette ?? (Array.isArray(palette) ? null : palette);
        const currentIndex = currentPalette
          ? cyclePalettes.indexOf(currentPalette)
          : -1;
        const defaultIndex = cyclePalettes.indexOf(DEFAULT_SPARKLES_PALETTE);
        const baseIndex =
          currentIndex >= 0
            ? currentIndex
            : defaultIndex >= 0
              ? defaultIndex
              : 0;
        const rect = field.getBoundingClientRect();
        const direction = event.clientX >= rect.left + rect.width / 2 ? 1 : -1;
        const nextPalette =
          cyclePalettes[
            (baseIndex + direction + cyclePalettes.length) %
              cyclePalettes.length
          ] ?? DEFAULT_SPARKLES_PALETTE;

        onPaletteChange(nextPalette);
      };

      field.addEventListener("click", handleClick);
      return () => field.removeEventListener("click", handleClick);
    }, [cycleOnClick, cyclePalette, cyclePalettes, onPaletteChange, palette]);

    return (
      <div className={`sparkles-wrap ${className}`} style={style} {...rest}>
        <div
          ref={fieldRef}
          className={`sparkles-field sparkles-field-${position}`}
          aria-hidden="true"
        />
        {children}
      </div>
    );
  },
);

export default Sparkles;
