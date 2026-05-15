import { GlobeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ToolPart } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../../assistant-message-tools";
import {
  ActionApproval,
  ApprovalStatusLabel,
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  getExpandedChipClasses,
  getStringFromPaths,
  isRecord,
  isString,
  JsonBlock,
  type ToolApprovalHandler,
} from "../shared";

const getDisplayUrl = (url: string | null) => {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
};

const getWebFetchTextOutput = (output: unknown) => {
  if (isString(output)) {
    return output;
  }

  return getStringFromPaths(output, [
    ["content"],
    ["text"],
    ["result"],
    ["markdown"],
    ["body"],
  ]);
};

export const WebFetchChip = ({
  defaultExpanded = false,
  onToolApproval,
  part,
}: {
  defaultExpanded?: boolean;
  onToolApproval?: ToolApprovalHandler;
  part: ToolLikePart;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const isApprovalRequested = state === "approval-requested";
  const url = getStringFromPaths(part.input, [
    ["url"],
    ["request", "url"],
    ["input", "url"],
  ]);
  const prompt = getStringFromPaths(part.input, [["prompt"], ["query"]]);
  const displayUrl = useMemo(() => getDisplayUrl(url), [url]);
  const outputText = getWebFetchTextOutput(part.output);
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
          aria-label={displayUrl ? `Web Fetch ${displayUrl}` : "Web Fetch"}
          className={cn(
            canExpand && "cursor-pointer",
            (isRunning || isApprovalRequested) && "animate-pulse",
          )}
          hasError={hasError}
          onClick={() => canExpand && setExpanded(!expanded)}
          tone="indigo"
          type="button"
        >
          <GlobeIcon className="size-3.5 shrink-0" />
          {!isRunning ? (
            <>
              <span className="font-medium">Web Fetch</span>
              {displayUrl ? (
                <span className="max-w-56 truncate font-medium">
                  {displayUrl}
                </span>
              ) : null}
              {hasError ? (
                <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
              ) : hasRawOutput ? (
                <span className={CHIP_SUBTEXT_CLASSES}>done</span>
              ) : null}
            </>
          ) : null}
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
          <span>
            Allow fetching{" "}
            <code className="rounded bg-surface-50 dark:bg-surface-900 px-1 py-0.5 text-xs">
              {displayUrl ?? url ?? "the requested URL"}
            </code>
            ?
          </span>
        </ActionApproval>
      ) : null}
      {expanded ? (
        <div
          className={getExpandedChipClasses("indigo", hasError)}
          style={{ borderColor: "currentColor" }}
        >
          {isRecord(part.input) ? (
            <div className="space-y-2 rounded-md bg-surface-50 dark:bg-surface-900 p-3">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Parameters
              </h4>
              <div className="rounded-md bg-surface-50 dark:bg-surface-900">
                <CodeBlock
                  code={JSON.stringify(part.input, null, 2)}
                  language="json"
                />
              </div>
              {prompt ? (
                <p className="text-muted-foreground text-xs">{prompt}</p>
              ) : null}
            </div>
          ) : null}
          {hasError ? (
            <div className="space-y-2 rounded-md bg-destructive-surface-muted p-3">
              <h4 className="font-medium text-destructive text-xs uppercase tracking-wide">
                Error
              </h4>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-destructive text-xs">
                {part.errorText}
              </pre>
            </div>
          ) : outputText ? (
            <div className="space-y-2 rounded-md bg-surface-50 dark:bg-surface-900 p-3">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Result
              </h4>
              <div className="max-h-96 overflow-auto rounded-md border bg-background p-3 text-foreground">
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
