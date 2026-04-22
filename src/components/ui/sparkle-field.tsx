/*
  <SparkleField /> — an 8-bit pixel sparkle field that rises from the
  bottom of its container toward the top, like a spell being conjured.
*/

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
} from "react";

type PaletteName = "gold" | "cyan" | "mag" | "rain";
type DensityName = "low" | "normal" | "high";

export interface SparkleFieldHandle {
  cast: (opts?: { count?: number }) => void;
}

export interface SparkleFieldProps {
  palette?: PaletteName | string[];
  density?: DensityName | number;
  height?: string | number;
  showRunes?: boolean;
  showGlow?: boolean;
  className?: string;
  style?: CSSProperties;
}

const PALETTES: Record<PaletteName, string[]> = {
  gold: ['#ffe27a', '#ffb84a', '#fff7c2', '#ffd26a'],
  cyan: ['#9bf2ff', '#6ac7ff', '#caf8ff', '#5ea3ff'],
  mag:  ['#ff9ae5', '#ff6ac7', '#ffd0f0', '#c77bff'],
  rain: ['#ffe27a', '#9bf2ff', '#ff9ae5', '#c7a6ff', '#b6ffb2'],
};
const DENSITY_MAP: Record<DensityName, number> = { low: 38, normal: 70, high: 130 };

function rand(a: number, b: number): number { return a + Math.random() * (b - a); }
function pick<T>(arr: T[]): T { return arr[(Math.random() * arr.length) | 0]; }

/* Inject shared styles exactly once. Keeps the component portable. */
const STYLE_ID = 'sparkle-field-styles';
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
    .sf-root {
      position: absolute;
      left: 0; right: 0;
      bottom: 100%;
      pointer-events: none;
      overflow: visible;
      image-rendering: pixelated;
      -webkit-font-smoothing: none;
      z-index: 3;
    }
    .sf-glow {
      content: "";
      position: absolute;
      left: 10%; right: 10%;
      bottom: -8px;
      height: 40px;
      background: radial-gradient(60% 100% at 50% 100%, rgba(106,199,255,.32), rgba(155,242,255,.18) 45%, rgba(94,163,255,.08) 60%, transparent 75%);
      filter: blur(2px);
      animation: sf-glow-pulse 1.8s steps(6) infinite;
      pointer-events: none;
    }
    @keyframes sf-glow-pulse {
      0%,100% { opacity: .6; transform: scaleX(1); }
      50%     { opacity: 1;  transform: scaleX(1.05); }
    }
    .sf-runes {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: -4px;
      display: flex;
      gap: 18px;
      pointer-events: none;
      z-index: 4;
    }
    .sf-rune {
      width: 10px; height: 10px;
      clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
      animation: sf-rune-pulse 1.4s steps(4) infinite;
      opacity: .85;
    }
    @keyframes sf-rune-pulse {
      0%,100% { transform: scale(.85); opacity: .6; }
      50%     { transform: scale(1.15); opacity: 1; }
    }

    .sf-spark {
      --size: 2px;
      --c: #ffe27a;
      position: absolute;
      bottom: 0;
      width: var(--size);
      height: var(--size);
      background: transparent;
      animation-name: sf-rise;
      animation-timing-function: linear;
      animation-iteration-count: infinite;
      will-change: transform, opacity;
    }
    .sf-spark.sf-star {
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
    .sf-spark.sf-diamond {
      box-shadow:
        0 calc(var(--size) * -2) 0 var(--c),
        0 calc(var(--size) *  2) 0 var(--c),
        calc(var(--size) * -2) 0 0 var(--c),
        calc(var(--size) *  2) 0 0 var(--c),
        0 calc(var(--size) * -1) 0 var(--c),
        0 calc(var(--size) *  1) 0 var(--c),
        calc(var(--size) * -1) 0 0 var(--c),
        calc(var(--size) *  1) 0 0 var(--c),
        0 0 0 #ffffff;
    }
    .sf-spark.sf-dot {
      box-shadow:
        0 0 0 var(--c),
        0 0 0 1px color-mix(in oklab, var(--c) 40%, transparent);
    }
    .sf-spark.sf-ember {
      --size: 4px;
      width: var(--size); height: var(--size);
      background: var(--c);
      box-shadow:
        4px 0 0 color-mix(in oklab, var(--c) 70%, transparent),
        -4px 0 0 color-mix(in oklab, var(--c) 70%, transparent),
        0 -4px 0 color-mix(in oklab, var(--c) 40%, transparent);
    }

    @keyframes sf-rise {
      0%   { transform: translate3d(0, 0, 0) scale(.4); opacity: 0; }
      8%   { transform: translate3d(0, -10px, 0) scale(1); opacity: 1; }
      50%  { transform: translate3d(var(--sway), -50%, 0) scale(1); opacity: 1; }
      85%  { transform: translate3d(calc(var(--sway) * -0.4), -90%, 0) scale(.8); opacity: .75; }
      100% { transform: translate3d(calc(var(--sway) * -0.8), -110%, 0) scale(.2); opacity: 0; }
    }
  `;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

export const SparkleField = forwardRef<SparkleFieldHandle, SparkleFieldProps>(function SparkleField(props, ref) {
  const {
    palette = 'gold',
    density = 'normal',
    height = '360px',
    showRunes = true,
    showGlow = true,
    className = '',
    style,
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);

  const paletteArr = Array.isArray(palette)
    ? palette
    : PALETTES[palette] || PALETTES.gold;
  const count = typeof density === 'number'
    ? density
    : (DENSITY_MAP[density] ?? DENSITY_MAP.normal);

  useLayoutEffect(ensureStyles, []);

  /* Build/rebuild ambient sparkles. */
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;

    let cancelled = false;

    function build() {
      if (cancelled || !field) return;
      field.innerHTML = '';
      const width = field.clientWidth || 600;

      for (let i = 0; i < count; i++) {
        const s = document.createElement('span');
        const r = Math.random();
        if (r < 0.08)       s.className = 'sf-spark sf-ember';
        else if (r < 0.6)   s.className = 'sf-spark sf-star';
        else if (r < 0.9)   s.className = 'sf-spark sf-dot';
        else                s.className = 'sf-spark sf-diamond';

        const isEmber = s.classList.contains('sf-ember');
        const size = isEmber
          ? (Math.random() < 0.5 ? 4 : 3)
          : (Math.random() < 0.6 ? 2 : 3);

        const x = rand(4, width - 6);
        const duration = rand(2.2, 5.8);
        const delay = rand(-6, 0.2);
        const sway = rand(-34, 34);

        s.style.setProperty('--size', size + 'px');
        s.style.setProperty('--c', pick(paletteArr));
        s.style.setProperty('--sway', sway + 'px');
        s.style.left = x + 'px';
        s.style.animationDuration = duration.toFixed(2) + 's';
        s.style.animationDelay = delay.toFixed(2) + 's';

        field.appendChild(s);
      }
    }

    build();

    const ro = new ResizeObserver(() => {
      // Rebuild on width change so sparkles respan the new area.
      build();
    });
    ro.observe(field);

    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [count, paletteArr.join('|')]);

  /* Expose imperative burst. */
  useImperativeHandle(ref, () => ({
    cast(opts = {}) {
      const field = fieldRef.current;
      if (!field) return;
      const width = field.clientWidth || 600;
      const burstCount = opts.count ?? 60;
      for (let i = 0; i < burstCount; i++) {
        const s = document.createElement('span');
        s.className = 'sf-spark sf-star';
        const size = Math.random() < 0.5 ? 2 : 3;
        const x = rand(10, width - 10);
        const duration = rand(.9, 1.6);
        const sway = rand(-80, 80);
        s.style.setProperty('--size', size + 'px');
        s.style.setProperty('--c', pick(paletteArr));
        s.style.setProperty('--sway', sway + 'px');
        s.style.left = x + 'px';
        s.style.animationDuration = duration.toFixed(2) + 's';
        s.style.animationDelay = '0s';
        field.appendChild(s);
        setTimeout(() => s.remove(), duration * 1000 + 120);
      }
    },
  }), [paletteArr.join('|')]);

  const runeColors = paletteArr.length >= 4
    ? paletteArr.slice(0, 5)
    : [paletteArr[0], paletteArr[1 % paletteArr.length], paletteArr[2 % paletteArr.length], paletteArr[0], paletteArr[1 % paletteArr.length]];

  return (
    <div
      ref={rootRef}
      className={`sf-root ${className}`}
      style={{ height, ...style }}
      aria-hidden="true"
    >
      <div ref={fieldRef} style={{ position: 'absolute', inset: 0 }} />
      {showGlow && <div className="sf-glow" />}
      {showRunes && (
        <div className="sf-runes">
          {runeColors.map((c, i) => (
            <span
              key={i}
              className="sf-rune"
              style={{ background: c, animationDelay: (i * 0.2) + 's' }}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export default SparkleField;
