import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const STATUS_DOT_COLORS = {
  amber: "bg-amber-500",
  blue: "bg-blue-500",
  green: "bg-success-highlight",
} as const;

export type StatusDotColor = keyof typeof STATUS_DOT_COLORS;

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
  return (
    <span
      aria-hidden={ariaHidden ?? (ariaLabel ? undefined : true)}
      aria-label={ariaLabel}
      className={cn(
        "size-2 shrink-0 rounded-full",
        STATUS_DOT_COLORS[color],
        pulse && "animate-pulse",
        className,
      )}
      role="img"
      style={style}
      {...props}
    />
  );
};
