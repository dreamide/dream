import { ArrowRight, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export const RightPanelHeaderIconButton = ({
  className,
  icon: Icon,
  onClose,
}: {
  className?: string;
  icon: LucideIcon;
  onClose: () => void;
}) => {
  const commonT = useTranslations("common");

  return (
    <button
      aria-label={commonT("closePanel")}
      className={cn(
        "group relative -ml-1.5 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-400 dark:focus-visible:ring-surface-500",
        className,
      )}
      onClick={onClose}
      title={commonT("closePanel")}
      type="button"
    >
      <Icon className="size-4 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />
      <ArrowRight className="absolute size-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
};
