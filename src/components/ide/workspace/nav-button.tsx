import type { ComponentProps, PropsWithChildren } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const WorkspaceNavButton = ({
  active,
  accent,
  children,
  className,
  title,
  ...props
}: PropsWithChildren<
  ComponentProps<typeof Button> & {
    active?: boolean;
    accent?: boolean;
    title: string;
  }
>) => (
  <Button
    aria-label={props["aria-label"] ?? title}
    className={cn(
      "size-8 [-webkit-app-region:no-drag]",
      active
        ? "bg-muted text-foreground hover:bg-muted hover:text-foreground"
        : accent
          ? undefined
          : "text-muted-foreground hover:text-foreground",
      className,
    )}
    size="icon"
    title={title}
    variant={!active && accent ? "accent-subtle" : "ghost"}
    {...props}
  >
    {children}
  </Button>
);
