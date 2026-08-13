import type { UIMessage } from "ai";
import { CircleCheck, LoaderCircle } from "lucide-react";
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
      className="my-2 flex w-full items-center gap-3 py-2 font-sans text-muted-foreground text-sm"
      role="status"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex shrink-0 items-center gap-2">
        {isCompacting ? (
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
        ) : (
          <CircleCheck aria-hidden className="size-4" />
        )}
        {isCompacting ? (
          <Shimmer as="span" duration={1.5}>
            {chatT("compactingContext")}
          </Shimmer>
        ) : (
          <span>{chatT("contextCompacted")}</span>
        )}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
};
