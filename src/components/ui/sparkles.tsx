/*
  <Sparkles /> — wraps any component; a field of pixel sparkles rises from
  the top edge of the children by default, like a spell being conjured.

  Usage:
    <Sparkles palette="violet">
      <YourInput />
    </Sparkles>

 Props:
    palette    "aqua" | "accent" | "violet" | "gold" | "magenta" | "emerald" | "ember" | "rainbow" | "mono"
               OR an array of CSS colors for a custom palette    (default: "aqua")
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
    className / style  applied to outer wrapper
    children   the component(s) the sparkles rise from

  Sparkles are drawn on a canvas by a shared worker (see sparkles-engine.ts),
  so a running field costs the main thread no per-frame work. One CSS
  animation per sparkle element forced a main-thread style update whenever
  any of them finished a cycle, which with ~100 sparkles was every frame.
*/

import {
  type HTMLAttributes,
  type ReactNode,
  useEffect,
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
import { attachSparklesCanvas, type SparklesSurface } from "./sparkles-canvas";
import type {
  SparklesFieldConfig,
  SparklesPosition,
  SparklesShape,
} from "./sparkles-engine";

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
      /* Particles rise above the field; sideways they stop at its edges, so
         a narrow column never scrolls sideways under them. */
      overflow-x: clip;
      overflow-y: visible;
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
  `;
  const el = document.createElement("style");
  el.id = SPARKLES_STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

function Sparkles(props: SparklesProps) {
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
  const surfaceRef = useRef<SparklesSurface | null>(null);
  const paletteKey = getSparklesPaletteKey(palette);

  const paletteArr = useMemo(
    () => getSparklesPaletteColors(paletteKey),
    [paletteKey],
  );
  const fieldConfig = useMemo<SparklesFieldConfig>(
    () => ({
      clockSync,
      density,
      height,
      position,
      shape,
      sizeMul,
      speed,
      sway,
      syncKey,
    }),
    [
      clockSync,
      density,
      height,
      position,
      shape,
      sizeMul,
      speed,
      sway,
      syncKey,
    ],
  );
  // Read when the canvas is (re)created, so enabling uses the current props.
  const latestRef = useRef({ fieldConfig, paletteArr });
  latestRef.current = { fieldConfig, paletteArr };

  useLayoutEffect(ensureSparklesStyles, []);

  /* ---- The canvas exists only while sparkles are enabled ---- */
  useEffect(() => {
    const field = fieldRef.current;
    if (!field || disabled) return;

    const surface = attachSparklesCanvas(
      field,
      latestRef.current.fieldConfig,
      latestRef.current.paletteArr,
    );
    surfaceRef.current = surface;
    return () => {
      surface?.detach();
      surfaceRef.current = null;
    };
  }, [disabled]);

  useEffect(() => {
    surfaceRef.current?.setConfig(fieldConfig);
  }, [fieldConfig]);

  useEffect(() => {
    surfaceRef.current?.setPalette(paletteArr);
  }, [paletteArr]);

  /* ---- Ground glow and click target ---- */
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
  }, [height, groundGlow, paletteArr, disabled, cycleOnClick]);

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
        currentIndex >= 0 ? currentIndex : defaultIndex >= 0 ? defaultIndex : 0;
      const rect = field.getBoundingClientRect();
      const direction = event.clientX >= rect.left + rect.width / 2 ? 1 : -1;
      const nextPalette =
        cyclePalettes[
          (baseIndex + direction + cyclePalettes.length) % cyclePalettes.length
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
}

export default Sparkles;
