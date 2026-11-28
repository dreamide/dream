import { BotIcon, ListChecksIcon, NetworkIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { ToolPart } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import {
  describeOrchestration,
  getToolCallSource,
  type ToolLikePart,
} from "../../assistant-message-tools";
import {
  ActionApproval,
  ApprovalStatusLabel,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  ChipContent,
  type ToolApprovalHandler,
} from "../shared";

const icons = {
  orchestration_capabilities: NetworkIcon,
  delegate_task: BotIcon,
  task_status: ListChecksIcon,
  task_cancel: SquareIcon,
};

export function OrchestrationChip({
  part,
  defaultExpanded,
  onToolApproval,
}: {
  part: ToolLikePart;
  defaultExpanded: boolean;
  onToolApproval: ToolApprovalHandler;
}) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);
  const call = describeOrchestration({
    ...getToolCallSource(part),
    output: part.errorText || part.output,
  });
  if (!call.operation) return null;
  const Icon = icons[call.operation];
  const label = t(`assistant.orchestration.${call.operation}`);
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const running = state === "input-streaming" || state === "input-available";
  const statusLabel = (status: string | null) => {
    switch (status) {
      case "queued":
      case "running":
      case "waiting":
      case "failed":
      case "interrupted":
        return t(`chat.queueStatus.${status}`);
      case "completed":
        return t("chat.taskCompleted");
      case "cancelled":
        return t("assistant.orchestration.cancelled");
      default:
        return status;
    }
  };
  const single = call.rows.length === 1 ? call.rows[0] : undefined;
  const hasError = Boolean(
    part.errorText ||
      call.error ||
      state === "output-error" ||
      single?.status === "failed",
  );
  const summary =
    call.model ??
    call.provider ??
    statusLabel(single?.status ?? null) ??
    (!hasError && part.output !== undefined
      ? t(
          call.rows.length === 1
            ? "assistant.resultCountOne"
            : "assistant.resultCountOther",
          { count: call.rows.length },
        )
      : null);
  const hasDetails = Boolean(
    call.prompt ||
      call.taskId ||
      call.provider ||
      part.output !== undefined ||
      part.errorText,
  );
  return (
    <div
      className={
        expanded || state === "approval-requested"
          ? "w-full min-w-0"
          : "min-w-0 max-w-full"
      }
    >
      <div className="flex items-center gap-2">
        <ChipButton
          type="button"
          tone="slate"
          hasError={hasError}
          aria-expanded={expanded && hasDetails}
          disabled={!hasDetails}
          className={cn("max-w-full", running && "animate-pulse")}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="shrink-0 font-medium">{label}</span>
          {summary && (
            <span className={cn("max-w-56 truncate", CHIP_SUBTEXT_CLASSES)}>
              {summary}
            </span>
          )}
          {running && (
            <span className={CHIP_SUBTEXT_CLASSES}>
              {t(`assistant.toolState.${state}`)}
            </span>
          )}
          {hasError && single?.status !== "failed" && (
            <span>{t("assistant.error")}</span>
          )}
        </ChipButton>
        <ApprovalStatusLabel approval={part.approval} state={state} />
      </div>
      {part.approval && (
        <ActionApproval
          approval={part.approval}
          state={state}
          onToolApproval={onToolApproval}
        >
          {t("assistant.allowTool", { tool: label })}
        </ActionApproval>
      )}
      {expanded && hasDetails && (
        <ChipContent tone="slate" hasError={hasError}>
          <div className="max-h-80 space-y-2 overflow-auto rounded-md border bg-background p-3 text-xs text-foreground [overflow-wrap:anywhere]">
            {call.key && <p className="font-medium">{call.key}</p>}
            {call.provider &&
              !call.rows.some((row) => row.provider === call.provider) && (
                <p className="text-muted-foreground">
                  {[call.provider, call.model].filter(Boolean).join(" · ")}
                </p>
              )}
            {call.prompt && (
              <p className="whitespace-pre-wrap">{call.prompt}</p>
            )}
            {call.taskId && !single?.id && (
              <p className="text-muted-foreground">{call.taskId}</p>
            )}
            {call.rows.map((row) => (
              <div
                key={row.provider ?? row.id ?? "error"}
                className="space-y-1"
              >
                {(row.provider || row.id) && (
                  <p>
                    <span className="font-medium">
                      {row.provider ?? statusLabel(row.status)}
                    </span>
                    {row.id && (
                      <span
                        title={row.id}
                        className="inline-block max-w-48 truncate align-bottom text-muted-foreground"
                      >
                        {row.status && " · "}
                        {row.id}
                      </span>
                    )}
                    {row.provider && !row.error && (
                      <span className="ms-2 text-muted-foreground">
                        {t("connections.ready")}
                      </span>
                    )}
                    {row.canDelegate && (
                      <span className="ms-2 text-muted-foreground">
                        {t("assistant.orchestration.canDelegate")}
                      </span>
                    )}
                  </p>
                )}
                {row.models.length > 0 && (
                  <p className="text-muted-foreground">
                    {row.models.join(" · ")}
                  </p>
                )}
                {row.result && (
                  <p className="whitespace-pre-wrap">{row.result}</p>
                )}
                {row.error && (
                  <p className="whitespace-pre-wrap text-destructive">
                    {row.error}
                  </p>
                )}
              </div>
            ))}
            {call.text && (
              <p
                className={cn(
                  "whitespace-pre-wrap",
                  hasError && "text-destructive",
                )}
              >
                {call.text}
              </p>
            )}
            {call.rows.length === 0 &&
              !call.text &&
              part.output !== undefined && <p>{summary}</p>}
          </div>
        </ChipContent>
      )}
    </div>
  );
}
