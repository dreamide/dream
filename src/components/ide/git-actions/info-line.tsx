import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/** One line of supporting text in a git dialog. */
export const InfoLine = ({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "warning";
}) => (
  <div
    className={cn(
      "flex items-start gap-2 text-xs",
      tone === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground",
    )}
  >
    {tone === "warning" ? (
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
    ) : null}
    <span className="min-w-0">{children}</span>
  </div>
);
