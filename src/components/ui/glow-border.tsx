import type { ComponentProps } from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const glowBorderVariants = cva("rounded-lg", {
  variants: {
    variant: {
      gradient: "glow-border-gradient rounded-lg",
      glow: "glow-border-glow rounded-lg",
    },
  },
  defaultVariants: {
    variant: "gradient",
  },
})

type GlowBorderVariant = NonNullable<
  VariantProps<typeof glowBorderVariants>["variant"]
>

interface GlowBorderProps extends ComponentProps<"div"> {
  variant?: GlowBorderVariant
  /**
   * Gradient colors as an array of color strings.
   * Overrides the default gradient for the variant.
   */
  colors?: string[]
}

function GlowBorder({
  variant = "gradient",
  colors,
  className,
  style,
  children,
  ...props
}: GlowBorderProps) {
  const customStyle: Record<string, string> = {}

  if (colors && colors.length > 0) {
    const angle = variant === "gradient" ? "90deg" : "45deg"

    customStyle["--glow-border-gradient"] =
      `linear-gradient(${angle}, ${colors.join(", ")})`
  }

  return (
    <div
      data-slot="glow-border"
      className={cn(glowBorderVariants({ variant }), className)}
      style={{ ...style, ...customStyle } as React.CSSProperties}
      {...props}
    >
      {children}
    </div>
  )
}

export { GlowBorder, glowBorderVariants }
export type { GlowBorderProps, GlowBorderVariant }
