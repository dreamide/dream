import type { LucideIcon } from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedToggleOption<Value extends string> {
  icon: LucideIcon;
  /** Accessible name and tooltip; the segments themselves are icon-only. */
  label: string;
  value: Value;
}

export interface SegmentedToggleProps<Value extends string>
  extends Omit<ComponentProps<"div">, "children" | "onChange" | "role"> {
  /** Names the group for assistive technology. */
  "aria-label": string;
  onValueChange: (value: Value) => void;
  options: readonly SegmentedToggleOption<Value>[];
  value: Value;
}

// One size everywhere, so the control is recognisably the same component
// wherever it appears.
const ITEM_CLASSES = "h-7 w-7";
const ICON_CLASSES = "size-3.5";

/**
 * A bordered, icon-only single-choice switch. The options share one recessed
 * track; a light thumb slides under the selected icon, which turns dark while
 * the others stay muted. Exactly one option is always selected.
 */
export const SegmentedToggle = <Value extends string>({
  "aria-label": ariaLabel,
  className,
  onValueChange,
  options,
  value,
  ...props
}: SegmentedToggleProps<Value>) => {
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "relative inline-grid shrink-0 auto-cols-fr grid-flow-col rounded-md border border-surface-200 bg-surface-200/70 p-0.5 dark:border-surface-700 dark:bg-surface-950",
        className,
      )}
      role="radiogroup"
      {...props}
    >
      {/* Segments are equal width, so the thumb is one segment wide and moves
          by whole multiples of itself. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc((100%_-_0.25rem)_/_var(--segments))] translate-x-[calc(var(--selected)_*_100%)] rounded-sm bg-background shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none dark:bg-surface-700"
        style={
          {
            "--segments": options.length,
            "--selected": selectedIndex,
          } as CSSProperties
        }
      />
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        const Icon = option.icon;

        return (
          // biome-ignore lint/a11y/useSemanticElements: a button styled as a segment; native radios cannot host the icon.
          <button
            aria-checked={selected}
            aria-label={option.label}
            className={cn(
              "relative z-10 flex items-center justify-center rounded-sm outline-none transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-surface-400 dark:focus-visible:ring-surface-500",
              ITEM_CLASSES,
              selected
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={option.value}
            onClick={() => {
              if (!selected) {
                onValueChange(option.value);
              }
            }}
            role="radio"
            title={option.label}
            type="button"
          >
            <Icon className={ICON_CLASSES} />
          </button>
        );
      })}
    </div>
  );
};
