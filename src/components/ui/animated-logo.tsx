import type { CSSProperties, SVGAttributes } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

// AnimatedLogo — the Dream badge: a circular night sky with a moon and a
// sparkle, plus a configurable layer of falling stars animating in the sky.
//
// Usage:
//   <AnimatedLogo size={480} sky="#0b0b12" ink="#ffffff" />
//
// All visual props are optional and have sensible defaults. The component is
// fully self-contained — animation state lives in a useRef + rAF loop, scoped
// per instance, so multiple logos on a page animate independently.

// ----- The two iconographic shapes from the source SVG -----
const MOON_PATH =
  "M272 516L326 517L361 523L410 539L441 554L478 579L496 594L521 619L551 660L568 691L588 683L625 674L677 672L714 677L744 686L764 695L790 710L824 736L796 772L775 793L742 821L700 848L675 861L646 873L619 882L611 883L609 885L585 889L583 891L535 897L485 897L457 894L400 882L346 861L310 842L264 809L246 793L214 759L187 722L172 697L168 687L166 686L144 633L132 587L131 569L129 565L157 548L190 533L220 524L257 517L271 517Z";
const SPARK_PATH =
  "M625 281L626 291L628 294L629 304L631 308L631 312L634 319L635 325L637 327L638 333L640 335L640 337L643 341L644 345L646 346L653 358L669 373L676 377L678 377L682 380L684 380L686 382L691 383L697 386L700 386L702 388L711 389L714 391L725 392L728 394L735 395L722 396L718 398L708 399L705 401L694 403L674 412L657 424L647 435L638 450L637 455L634 461L634 464L632 467L631 475L629 478L628 489L626 493L625 505L624 504L624 497L622 493L621 481L619 477L618 469L615 463L614 457L611 450L609 448L608 444L603 438L603 436L601 435L596 428L586 420L585 418L575 412L560 405L543 401L540 399L535 399L534 398L529 398L526 396L515 395L516 394L521 394L524 392L534 391L537 389L546 388L548 386L555 385L557 383L563 382L581 373L594 362L605 347L614 328L621 303L622 292L624 288L624 282Z";

// Sky circle, in the SVG's 1024x1024 coordinate space.
const CX = 511.5;
const CY = 511.5;
const R = 395;

interface Star {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  len: number;
  width: number;
  alpha: number;
  twinkleOffset: number;
  life: number;
}

interface MotionOpts {
  angleDeg: number;
  speedMin: number;
  speedMax: number;
  lenMin: number;
  lenMax: number;
}

interface FallingStarsOpts extends MotionOpts {
  count: number;
  paused: boolean;
}

// Spawn a star relative to the motion direction (ux, uy). `progress` in
// [0, 1) staggers initial positions along the travel axis so the field is
// fully populated immediately. Spawning is perpendicular to motion, upwind
// of the circle, with the perpendicular spread covering the diameter — so
// the field stays full at any angle.
function spawnAt(
  ux: number,
  uy: number,
  progress = 0,
  lenSample = 0,
): { x: number; y: number } {
  const px = -uy;
  const py = ux;
  const margin = 80 + lenSample;
  const travel = 2 * R + margin * 2;
  const along = -R - margin + travel * progress;
  const across = (Math.random() * 2 - 1) * (R + 40);
  return {
    x: CX + ux * along + px * across,
    y: CY + uy * along + py * across,
  };
}

function makeStar(seed: number, opts: MotionOpts): Star {
  const a = (opts.angleDeg * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const speed = opts.speedMin + Math.random() * (opts.speedMax - opts.speedMin);
  const len = opts.lenMin + Math.random() * (opts.lenMax - opts.lenMin);
  const { x, y } = spawnAt(ux, uy, Math.random(), len);
  return {
    id: seed,
    x,
    y,
    vx: ux * speed,
    vy: uy * speed,
    len,
    width: 0.6 + Math.random() * 1.6,
    alpha: 0.4 + Math.random() * 0.6,
    twinkleOffset: Math.random() * Math.PI * 2,
    life: 0,
  };
}

function useFallingStars({
  count,
  angleDeg,
  speedMin,
  speedMax,
  lenMin,
  lenMax,
  paused,
}: FallingStarsOpts): Star[] {
  const [, force] = useState(0);
  const starsRef = useRef<Star[]>([]);
  const rafRef = useRef(0);
  const lastRef = useRef(0);

  // Pool sizing — add or trim to match `count`.
  useEffect(() => {
    const arr = starsRef.current;
    if (arr.length < count) {
      for (let i = arr.length; i < count; i++) {
        arr.push(
          makeStar(i + Math.random(), {
            angleDeg,
            speedMin,
            speedMax,
            lenMin,
            lenMax,
          }),
        );
      }
    } else if (arr.length > count) {
      arr.length = count;
    }
  }, [count, angleDeg, speedMin, speedMax, lenMin, lenMax]);

  // Live-update velocity & length when motion knobs change.
  useEffect(() => {
    const a = (angleDeg * Math.PI) / 180;
    for (const s of starsRef.current) {
      const sp = speedMin + Math.random() * (speedMax - speedMin);
      s.vx = Math.cos(a) * sp;
      s.vy = Math.sin(a) * sp;
      s.len = lenMin + Math.random() * (lenMax - lenMin);
    }
  }, [angleDeg, speedMin, speedMax, lenMin, lenMax]);

  useEffect(() => {
    if (paused) return undefined;
    let mounted = true;
    const tick = (t: number) => {
      if (!mounted) return;
      const dt = lastRef.current ? Math.min(64, t - lastRef.current) : 16;
      lastRef.current = t;
      const dts = dt / 16; // normalize to ~60fps step
      const a = (angleDeg * Math.PI) / 180;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      for (const s of starsRef.current) {
        s.x += s.vx * dts;
        s.y += s.vy * dts;
        s.life += dt;
        // Recycle once the star has crossed the full travel distance —
        // i.e. its projection onto the motion axis (relative to the center)
        // is past the downwind edge. Works at any angle.
        const proj = (s.x - CX) * ux + (s.y - CY) * uy;
        if (proj > R + 80 + s.len) {
          const sp = speedMin + Math.random() * (speedMax - speedMin);
          s.vx = ux * sp;
          s.vy = uy * sp;
          s.len = lenMin + Math.random() * (lenMax - lenMin);
          s.width = 0.6 + Math.random() * 1.6;
          s.alpha = 0.4 + Math.random() * 0.6;
          s.life = 0;
          const { x, y } = spawnAt(ux, uy, 0, s.len);
          s.x = x;
          s.y = y;
        }
      }
      force((n) => (n + 1) % 1000000);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      cancelAnimationFrame(rafRef.current);
      lastRef.current = 0;
    };
  }, [paused, angleDeg, speedMin, speedMax, lenMin, lenMax]);

  return starsRef.current;
}

export interface AnimatedLogoProps
  extends Omit<SVGAttributes<SVGSVGElement>, "viewBox" | "xmlns"> {
  /** Explicit width/height. If omitted, the SVG fills its container. */
  size?: number | string;
  /** Background color of the sky. @default "#0b0b12" */
  sky?: string;
  /** Color of moon, sparkle, and stars. @default "#ffffff" */
  ink?: string;
  /** Number of stars in the field. @default 60 */
  starCount?: number;
  /** Overall fall speed. @default 4 */
  speed?: number;
  /** Average trail length. @default 28 */
  trail?: number;
  /** Direction stars travel, in degrees. 90 = straight down. @default 115 */
  angleDeg?: number;
  /** Modulate star opacity over time. @default true */
  twinkle?: boolean;
  /** Freeze the animation. @default false */
  paused?: boolean;
  /** Multiplier on star width and trail length. @default 1 */
  starScale?: number;
  /** Auto-pause when user has prefers-reduced-motion set. @default true */
  respectReducedMotion?: boolean;
}

export function AnimatedLogo({
  size,
  sky = "#0b0b12",
  ink = "#ffffff",
  starCount = 60,
  speed = 4,
  trail = 28,
  angleDeg = 115,
  twinkle = true,
  paused = false,
  starScale = 1,
  respectReducedMotion = true,
  className,
  style,
  ...rest
}: AnimatedLogoProps) {
  const speedMin = speed * 0.6;
  const speedMax = speed * 1.6;
  const lenMin = trail * 0.6;
  const lenMax = trail * 1.4;

  const reduced = useMemo(
    () =>
      respectReducedMotion &&
      typeof window !== "undefined" &&
      window.matchMedia !== undefined &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [respectReducedMotion],
  );

  const stars = useFallingStars({
    count: Math.max(0, starCount | 0),
    angleDeg,
    speedMin,
    speedMax,
    lenMin,
    lenMax,
    paused: paused || reduced,
  });

  const a = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const t = performance.now();

  const clipId = useId();

  const sizingStyle: CSSProperties | undefined =
    size != null ? { width: size, height: size, ...style } : style;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="Dream logo — a moon and star with falling stars in the night sky"
      className={className}
      style={sizingStyle}
      {...rest}
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx={CX} cy={CY} r={R} />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipId})`}>
        {/* Sky */}
        <rect width="1024" height="1024" fill={sky} />

        {/* Falling stars layer — behind the moon and the sparkle */}
        <g style={{ mixBlendMode: "screen" }}>
          {stars.map((s) => {
            const len = s.len * starScale;
            const w = s.width * starScale;
            const tx = s.x - ux * len;
            const ty = s.y - uy * len;
            const tw = twinkle
              ? 0.55 + 0.45 * Math.sin(t * 0.006 + s.twinkleOffset)
              : 1;
            const op = s.alpha * tw;
            return (
              <g key={s.id} opacity={op}>
                <line
                  x1={tx}
                  y1={ty}
                  x2={s.x}
                  y2={s.y}
                  stroke={ink}
                  strokeOpacity="0.55"
                  strokeWidth={w}
                  strokeLinecap="round"
                />
                <circle cx={s.x} cy={s.y} r={w * 1.1} fill={ink} />
              </g>
            );
          })}
        </g>

        {/* Moon */}
        <path d={MOON_PATH} fill={ink} />
        {/* Sparkle */}
        <path d={SPARK_PATH} fill={ink} />
      </g>
    </svg>
  );
}
