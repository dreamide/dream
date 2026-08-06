import type { UIMessage } from "ai";
import { Check, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Shimmer } from "@/components/ai-elements/shimmer";

export type ContextCompactionState = "compacting" | "compacted";

export const getContextCompactionState = (
  part: UIMessage["parts"][number],
): ContextCompactionState | null => {
  if (part.type !== "data-context-compaction" || !("data" in part)) {
    return null;
  }

  const data = part.data;
  if (!data || typeof data !== "object" || !("state" in data)) {
    return null;
  }

  return data.state === "compacting" || data.state === "compacted"
    ? data.state
    : null;
};

export const ContextCompactionMessage = ({
  state,
}: {
  state: ContextCompactionState;
}) => {
  const chatT = useTranslations("chat");
  const isCompacting = state === "compacting";

  return (
    <div
      aria-live={isCompacting ? "polite" : undefined}
      className="my-1 flex w-full items-center gap-2 py-1.5 text-muted-foreground text-xs"
      role="status"
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/40">
        {isCompacting ? (
          <RefreshCw aria-hidden className="size-3 animate-spin" />
        ) : (
          <Check aria-hidden className="size-3" />
        )}
      </span>
      {isCompacting ? (
        <Shimmer as="span" duration={1.5}>
          {chatT("compactingContext")}
        </Shimmer>
      ) : (
        <span>{chatT("contextCompacted")}</span>
      )}
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border/60" />
    </div>
  );
};
