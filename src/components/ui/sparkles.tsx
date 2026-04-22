/*
  <Sparkles /> — wraps any component; a field of pixel sparkles rises from
  the top edge of the children by default, like a spell being conjured.

  Usage:
    <Sparkles palette="arctic">
      <YourInput />
    </Sparkles>

 Props:
    palette    "arctic" | "gold" | "magenta" | "emerald" | "ember" | "rainbow" | "mono"
               OR an array of hex strings for a custom palette   (default: "arctic")
    disabled   disables sparkles and ground glow                 (default: false)
    position   "top" | "bottom" origin edge                      (default: "top")
    density    number of ambient sparkles                         (default: 80)
    speed      multiplier — 1 = normal, 2 = 2× faster            (default: 1)
    sizeMul    pixel-size multiplier                              (default: 1)
    sway       max horizontal drift in px                         (default: 40)
    height     rise-field height in px                            (default: 360)
    shape      "mixed" | "star" | "dot" | "glow" | "diamond" | "plus"
                                                                  (default: "mixed")
    groundGlow boolean — soft glow at the top edge of children    (default: true)
    burstRef   React ref; ref.current.cast(count?) triggers burst
    className / style  applied to outer wrapper
    children   the component(s) the sparkles rise from

  Imperative:
    const ref = useRef(null);
    <Sparkles ref={ref}>...</Sparkles>
    ref.current.cast(70);   // one-off burst
*/

import {
  type HTMLAttributes,
  type ReactNode,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

type SparklesPaletteName =
  | "arctic"
  | "gold"
  | "magenta"
  | "emerald"
  | "ember"
  | "rainbow"
  | "mono";

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
  children?: ReactNode;
}

const SPARKLES_PALETTES = {
  arctic:  ['#7affd1', '#9bf2ff', '#caeaff', '#ffffff'],
  gold:    ['#ffe27a', '#ffb84a', '#fff7c2', '#ffd26a'],
  magenta: ['#ff9ae5', '#ff6ac7', '#ffd0f0', '#c77bff'],
  emerald: ['#5cffb0', '#2aa86a', '#b6ffd8', '#fff9c2'],
  ember:   ['#ffb347', '#ff6a4a', '#ffe7c2', '#ff4a7a'],
  rainbow: ['#ffe27a', '#9bf2ff', '#ff9ae5', '#c7a6ff', '#b6ffb2'],
  mono:    ['#ffffff', '#e0e4ff', '#b8beff', '#9098c9'],
};

function sparklesRand(a: number, b: number) { return a + Math.random() * (b - a); }
function sparklesPick<T>(items: T[]) { return items[(Math.random() * items.length) | 0]; }
function sparklesHexToRGBA(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ---------- Inject component styles once ---------- */
const SPARKLES_STYLE_ID = 'sparkles-wrapper-styles';
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
      opacity: var(--sp-glow-op, .8);
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
  const el = document.createElement('style');
  el.id = SPARKLES_STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

const Sparkles = forwardRef<SparklesHandle, SparklesProps>(function Sparkles(
  props,
  ref,
) {
  const {
    disabled = false,
    position = "top",
    palette = 'arctic',
    density = 80,
    speed = 1,
    sizeMul = 1,
    sway = 40,
    height = 360,
    shape = 'mixed',
    groundGlow = true,
    className = '',
    style,
    children,
    ...rest
  } = props;

  const fieldRef = useRef<HTMLDivElement | null>(null);

  const paletteArr = Array.isArray(palette)
    ? palette
    : (SPARKLES_PALETTES[palette] || SPARKLES_PALETTES.arctic);

  useLayoutEffect(ensureSparklesStyles, []);

  /* Build ambient sparkle field */
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const fieldEl = field;

    fieldEl.style.setProperty('--sp-h', height + 'px');
    fieldEl.style.setProperty('--sp-glow', sparklesHexToRGBA(paletteArr[0], .45));
    fieldEl.style.setProperty('--sp-glow-op', !disabled && groundGlow ? '.9' : '0');

    if (disabled) {
      fieldEl.innerHTML = '';
      return;
    }

    let cancelled = false;

    function build() {
      if (cancelled) return;
      fieldEl.innerHTML = '';
      const width = fieldEl.clientWidth || 700;

      for (let i = 0; i < density; i++) {
        const s = document.createElement('span');
        let kind: Exclude<SparklesShape, "mixed">;
        if (shape === 'mixed') {
          const r = Math.random();
          if (r < 0.5) kind = 'star';
          else if (r < 0.75) kind = 'dot';
          else if (r < 0.9) kind = 'glow';
          else kind = 'diamond';
        } else kind = shape;

        s.className = `sparkles-spark sparkles-spark-${position} sp-${kind}`;

        const baseSize = kind === 'glow' ? sparklesRand(3, 6) : (Math.random() < 0.6 ? 2 : 3);
        const size = Math.max(1, baseSize * sizeMul);
        const baseDur = sparklesRand(2.2, 5.8);
        const duration = baseDur / speed;
        const delay = sparklesRand(-duration, 0.2);
        const swayV = sparklesRand(-sway, sway);
        const x = sparklesRand(6, width - 6);

        s.style.setProperty('--size', size + 'px');
        s.style.setProperty('--c', sparklesPick(paletteArr));
        s.style.setProperty('--sway', swayV.toFixed(1) + 'px');
        s.style.setProperty('--rise', height + 'px');
        s.style.left = x + 'px';
        s.style.animationDuration = duration.toFixed(2) + 's';
        s.style.animationDelay = delay.toFixed(2) + 's';
        fieldEl.appendChild(s);
      }
    }

    build();
    const ro = new ResizeObserver(() => build());
    ro.observe(fieldEl);
    return () => { cancelled = true; ro.disconnect(); };
  }, [
    density,
    disabled,
    position,
    speed,
    sizeMul,
    sway,
    height,
    shape,
    groundGlow,
    paletteArr.join('|'),
  ]);

  const castBurst = (count = 70) => {
    const field = fieldRef.current;
    if (!field || disabled) return;
    const fieldEl = field;
    const width = fieldEl.clientWidth || 700;
    for (let i = 0; i < count; i++) {
      const s = document.createElement('span');
      s.className = `sparkles-spark sparkles-spark-${position} ${Math.random() < 0.7 ? 'sp-star' : 'sp-glow'}`;
      const size = (Math.random() < 0.5 ? 2 : 3) * sizeMul;
      const dur = sparklesRand(0.9, 1.7) / speed;
      const swayV = sparklesRand(-sway * 2.2, sway * 2.2);
      s.style.setProperty('--size', size + 'px');
      s.style.setProperty('--c', sparklesPick(paletteArr));
      s.style.setProperty('--sway', swayV.toFixed(1) + 'px');
      s.style.setProperty('--rise', height + 'px');
      s.style.left = sparklesRand(10, width - 10) + 'px';
      s.style.animationDuration = dur.toFixed(2) + 's';
      fieldEl.appendChild(s);
      setTimeout(() => s.remove(), dur * 1000 + 200);
    }
  };

  useImperativeHandle(ref, () => ({ cast: castBurst }),
    [disabled, position, sway, sizeMul, speed, height, paletteArr.join('|')]);

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
});

export default Sparkles;
