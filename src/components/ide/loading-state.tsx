import { type ComponentProps, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────
 * LOADING STATE — pixel-grid loader for long-running work
 *
 * Variants:
 *   Drive  — square cells, chevron wavefront driving right;
 *            the 650ms cycle is shorter than the sweep, so
 *            two fronts are always in flight
 *   Dots   — same wavefront, circular cells
 *   Orbit  — a comet lapping the grid perimeter
 *   Surfer — the Drive loader paired with a meme video below
 *
 * The default layout pairs the grid with a shimmering label
 * and a live elapsed timer in mono tabular figures. Compact
 * mode renders only the 3×3 grid, for tight slots like the
 * chat history row. Reduced motion freezes the grid to its
 * dim state; the timer still ticks.
 * ───────────────────────────────────────────────────────── */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

export type LoadingStateVariant = "Drive" | "Dots" | "Orbit" | "Surfer";

const PATTERNS: Record<
  Exclude<LoadingStateVariant, "Surfer">,
  { delays: (number | null)[]; dur: number; round: boolean }
> = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

function LoaderGrid({
  delays,
  dur,
  round,
  reducedMotion,
}: {
  delays: (number | null)[];
  dur: number;
  round: boolean;
  reducedMotion: boolean;
}) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]"
    >
      {delays.map((delay, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static decorative grid cells never reorder
          key={index}
          className={cn(
            "size-[4px] bg-foreground",
            round ? "rounded-full" : "rounded-[1px]",
          )}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation:
              reducedMotion || delay === null
                ? "none"
                : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

function useElapsed(enabled: boolean) {
  const [ds, setDs] = useState(0);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const t = setInterval(() => setDs((d) => d + 1), 100);
    return () => clearInterval(t);
  }, [enabled]);
  const total = ds / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

export type LoadingStateProps = {
  label?: string;
  variant?: LoadingStateVariant;
  /** Render only the 3×3 grid — for compact slots like chat history. */
  compact?: boolean;
  /** the meme feed for the Surfer variant; drop the file in /public to light it up */
  videoSrc?: string;
} & Pick<ComponentProps<"div">, "aria-label" | "className">;

export function LoadingState({
  label,
  variant = "Drive",
  compact = false,
  videoSrc = "/subway-surfers.mp4",
  "aria-label": ariaLabel,
  className,
}: LoadingStateProps) {
  const surfer = variant === "Surfer";
  const elapsed = useElapsed(!compact);
  const reducedMotion = usePrefersReducedMotion();
  const resolvedLabel = label ?? (surfer ? "Subway surfing" : "Churning");
  const [videoOk, setVideoOk] = useState(true);
  const { delays, dur, round } = PATTERNS[surfer ? "Drive" : variant];
  const statusLabel = ariaLabel ?? resolvedLabel;
  const grid = (
    <LoaderGrid
      delays={delays}
      dur={dur}
      reducedMotion={reducedMotion}
      round={round}
    />
  );

  if (compact) {
    return (
      <div
        aria-label={statusLabel}
        className={cn("flex w-fit items-center", className)}
        role="status"
      >
        {grid}
      </div>
    );
  }

  const labelEl = reducedMotion ? (
    <span className="text-[13px] font-medium text-muted-foreground">
      {resolvedLabel}
    </span>
  ) : (
    <span
      className="bg-clip-text text-[13px] font-medium text-transparent"
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%)",
        backgroundSize: "200% 100%",
        animation: "shimmer-text 1.4s linear infinite",
      }}
    >
      {resolvedLabel}
    </span>
  );
  const elapsedEl = (
    <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
      {elapsed}
    </span>
  );

  if (surfer) {
    return (
      <div
        aria-label={statusLabel}
        className={cn("flex w-fit flex-col items-start", className)}
        role="status"
      >
        <div className="flex items-center gap-2.5">
          <LoaderGrid reducedMotion={reducedMotion} {...PATTERNS.Drive} />
          {labelEl}
          {elapsedEl}
        </div>

        {/* the context card follows the status text it is illustrating */}
        <div
          className="mt-2 w-56 overflow-hidden rounded-[10px] shadow-md"
          style={{
            animation: reducedMotion
              ? "none"
              : "pop-in 200ms cubic-bezier(0.16,1,0.3,1) both",
            transformOrigin: "top left",
          }}
        >
          <div className="relative aspect-video w-full bg-popover">
            {videoOk ? (
              <video
                src={videoSrc}
                autoPlay
                muted
                loop
                playsInline
                onError={() => setVideoOk(false)}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1.5">
                <LoaderGrid reducedMotion={reducedMotion} {...PATTERNS.Drive} />
                <span className="px-3 text-center font-mono text-[10px] text-muted-foreground">
                  Video unavailable
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      aria-label={statusLabel}
      className={cn("flex w-fit items-center gap-2.5", className)}
      role="status"
    >
      {grid}
      {labelEl}
      {elapsedEl}
    </div>
  );
}
