import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@/lib/utils";

const STATUS_DOT_COLORS = {
  amber: {
    className: "bg-amber-500",
    pulseColor:
      "color-mix(in oklch, var(--color-amber-500, oklch(0.769 0.188 70.08)) 75%, transparent)",
  },
  blue: {
    className: "bg-blue-500",
    pulseColor:
      "color-mix(in oklch, var(--color-blue-500, oklch(0.623 0.214 259.815)) 75%, transparent)",
  },
  green: {
    className: "bg-success-highlight",
    pulseColor:
      "color-mix(in oklch, var(--success-highlight) 75%, transparent)",
  },
} as const;

export type StatusDotColor = keyof typeof STATUS_DOT_COLORS;

type StatusDotStyle = CSSProperties & {
  "--status-dot-pulse-color"?: string;
};

export type StatusDotProps = Omit<ComponentProps<"span">, "color" | "role"> & {
  color?: StatusDotColor;
  pulse?: boolean;
};

export const StatusDot = ({
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
  className,
  color = "green",
  pulse = true,
  style,
  ...props
}: StatusDotProps) => {
  const colorConfig = STATUS_DOT_COLORS[color];
  const dotStyle: StatusDotStyle = {
    "--status-dot-pulse-color": colorConfig.pulseColor,
    ...style,
  };

  return (
    <span
      aria-hidden={ariaHidden ?? (ariaLabel ? undefined : true)}
      aria-label={ariaLabel}
      className={cn(
        "size-2 shrink-0 rounded-full",
        colorConfig.className,
        pulse && "animate-status-dot-pulse",
        className,
      )}
      role="img"
      style={dotStyle}
      {...props}
    />
  );
};
