import { NetworkIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import type { ToolPart } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../../assistant-message-tools";
import { getToolName, parseMcpToolName } from "../../assistant-message-tools";
import {
  ActionApproval,
  ApprovalStatusLabel,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  formatToolName,
  getExpandedChipClasses,
  isRecord,
  isString,
  JsonBlock,
  type ToolApprovalHandler,
} from "../shared";

export const McpToolChip = ({
  defaultExpanded = false,
  onToolApproval,
  part,
}: {
  defaultExpanded?: boolean;
  onToolApproval?: ToolApprovalHandler;
  part: ToolLikePart;
}) => {
  const assistantT = useTranslations("assistant");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const toolName = getToolName(part);
  const mcpInfo = parseMcpToolName(toolName);
  const label = mcpInfo
    ? `${mcpInfo.server} - ${mcpInfo.command}`
    : formatToolName(toolName);
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const isApprovalRequested = state === "approval-requested";
  const hasRawOutput = part.output !== undefined;
  const approvalId = part.approval?.id;
  const canExpand =
    isApprovalRequested || hasError || hasRawOutput || isRecord(part.input);

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  return (
    <div className={expanded || isApprovalRequested ? "w-full" : undefined}>
      <div className="flex items-center gap-2">
        <ChipButton
          aria-label={label}
          className={cn(
            canExpand && "cursor-pointer",
            (isRunning || isApprovalRequested) && "animate-pulse",
          )}
          hasError={hasError}
          onClick={() => canExpand && setExpanded(!expanded)}
          tone="sky"
          type="button"
        >
          <NetworkIcon className="size-3.5 shrink-0" />
          {mcpInfo ? (
            <>
              <span className="max-w-40 truncate font-medium" title={toolName}>
                {mcpInfo.server}
              </span>
              <span className={CHIP_SUBTEXT_CLASSES}>{mcpInfo.command}</span>
            </>
          ) : (
            <span className="max-w-64 truncate font-medium" title={toolName}>
              {label}
            </span>
          )}
        </ChipButton>
        <ApprovalStatusLabel approval={part.approval} state={state} />
      </div>
      {approvalId && part.approval && onToolApproval ? (
        <ActionApproval
          approval={part.approval}
          className="mt-2"
          onToolApproval={onToolApproval}
          state={state}
        >
          <span>{assistantT("allowTool", { tool: label })}</span>
        </ActionApproval>
      ) : null}
      {expanded ? (
        <div
          className={getExpandedChipClasses("sky", hasError)}
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
                {assistantT("error")}
              </h4>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-destructive text-xs">
                {part.errorText}
              </pre>
            </div>
          ) : hasRawOutput ? (
            <div className="space-y-2 rounded-md bg-surface-50 dark:bg-surface-900 p-3">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {assistantT("result")}
              </h4>
              {isString(part.output) ? (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-foreground text-xs">
                  {part.output}
                </pre>
              ) : (
                <JsonBlock value={part.output} />
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
