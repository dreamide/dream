import { BotIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ToolPart } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../../assistant-message-tools";
import {
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  formatToolName,
  getAgentOutputText,
  getExpandedChipClasses,
  getStringFromPaths,
  isRecord,
  isString,
  JsonBlock,
} from "../shared";

export const AgentChip = ({
  defaultExpanded = false,
  part,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
}) => {
  const assistantT = useTranslations("assistant");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const outputText = getAgentOutputText(part.output);
  const hasRawOutput = part.output !== undefined;
  const canExpand = hasError || hasRawOutput;
  const description =
    getStringFromPaths(part.input, [["description"]]) ?? assistantT("agent");
  const displayDescription =
    description === assistantT("agent") && isRunning
      ? assistantT("runningAgent")
      : description;
  const subagentType = getStringFromPaths(part.input, [
    ["subagent_type"],
    ["subagentType"],
    ["type"],
  ]);

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  return (
    <div className={expanded ? "w-full" : undefined}>
      <ChipButton
        className={cn(
          canExpand && "cursor-pointer",
          isRunning && "animate-pulse",
        )}
        hasError={hasError}
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-label={displayDescription}
        tone="slate"
        type="button"
      >
        <BotIcon className="size-3.5 shrink-0" />
        {!isRunning ? (
          <>
            <span className="max-w-56 truncate font-medium">
              {displayDescription}
            </span>
            {subagentType ? (
              <span className={CHIP_SUBTEXT_CLASSES}>{subagentType}</span>
            ) : null}
            <span className={CHIP_SUBTEXT_CLASSES}>
              {formatToolName(state)}
            </span>
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>
                {assistantT("error")}
              </span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses("slate", hasError)}
          style={{ borderColor: "currentColor" }}
        >
          {isRecord(part.input) ? (
            <div className="space-y-2 rounded-md bg-surface-50 dark:bg-surface-900 p-3">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {assistantT("parameters")}
              </h4>
              <div className="rounded-md bg-surface-50 dark:bg-surface-900">
                <CodeBlock
                  code={JSON.stringify(part.input, null, 2)}
                  language="json"
                />
              </div>
            </div>
          ) : null}
          {hasError ? (
            <div className="space-y-2 rounded-md bg-destructive-surface-muted p-3">
              <h4 className="font-medium text-destructive text-xs uppercase tracking-wide">
                {assistantT("result")}
              </h4>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-destructive text-xs">
                {part.errorText}
              </pre>
            </div>
          ) : outputText ? (
            <div className="space-y-2 rounded-md bg-surface-50 dark:bg-surface-900 p-3">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {assistantT("result")}
              </h4>
              <div className="rounded-md border bg-background p-3 text-foreground">
                <MessageResponse>{outputText}</MessageResponse>
              </div>
            </div>
          ) : hasRawOutput ? (
            <JsonBlock value={part.output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
