import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

interface GlowBorderProps extends ComponentProps<"div"> {
  /**
   * Gradient colors as an array of color strings.
   * Overrides the default gradient.
   */
  colors?: string[]
  /** When true, hides the glow animation but keeps the DOM structure stable. */
  disabled?: boolean
}

function GlowBorder({
  colors,
  disabled,
  className,
  style,
  children,
  ...props
}: GlowBorderProps) {
  const customStyle: Record<string, string> = {}

  if (colors && colors.length > 0) {
    customStyle["--glow-border-gradient"] =
      `linear-gradient(45deg, ${colors.join(", ")})`
  }

  return (
    <div
      data-slot="glow-border"
      className={cn(
        disabled ? "glow-border-disabled" : "glow-border-glow rounded-lg",
        className,
      )}
      style={{ ...style, ...customStyle } as React.CSSProperties}
      {...props}
    >
      {children}
    </div>
  )
}

export { GlowBorder }
export type { GlowBorderProps }
