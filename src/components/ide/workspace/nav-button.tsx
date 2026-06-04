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
      accent
        ? "bg-primary-surface text-primary hover:bg-primary-surface-hover hover:text-primary"
        : active
          ? "bg-muted text-foreground hover:bg-muted hover:text-foreground"
          : "text-muted-foreground hover:text-foreground",
      className,
    )}
    size="icon"
    title={title}
    variant="ghost"
    {...props}
  >
    {children}
  </Button>
);
