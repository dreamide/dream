import { MapIcon, WrenchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import type { ToolPart } from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  getToolName,
  isToolLikePart,
  type MessagePart,
  normalizeToolName,
  type ToolLikePart,
} from "../assistant-message-tools";
import { isTodoListPart } from "../chat/todo-list";
import { stringifyPart } from "../ide-state";
import {
  ActionApproval,
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  formatToolName,
  getExpandedChipClasses,
  getStringFromPaths,
  isRecord,
  isString,
  RUN_COMMAND_HEADER_CLASSES,
  StreamingMessageResponse,
  TOOL_STATE_LABELS,
  type ToolApprovalHandler,
} from "./shared";

const getGenericToolOutputCode = (part: ToolLikePart) => {
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  if (hasError) {
    return {
      code: part.errorText ?? "",
      label: "Error",
      language: "log" as BundledLanguage,
    };
  }

  if (part.output === undefined) {
    return null;
  }

  return {
    code: isString(part.output) ? part.output : stringifyPart(part.output),
    label: "Result",
    language: isString(part.output)
      ? ("log" as BundledLanguage)
      : ("json" as BundledLanguage),
  };
};

const GenericToolCodeSection = ({
  code,
  label,
  language,
  maxHeightClassName,
}: {
  code: string;
  label: string;
  language: BundledLanguage;
  maxHeightClassName: string;
}) => {
  return (
    <CodeBlock
      className={cn(
        maxHeightClassName,
        "flex flex-col rounded-none border-0 [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1 [&_pre]:text-xs",
      )}
      code={code}
      language={language}
      style={{ contentVisibility: "visible" }}
    >
      <CodeBlockHeader className={RUN_COMMAND_HEADER_CLASSES}>
        <CodeBlockTitle>
          <CodeBlockFilename>{label}</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3" />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
};

const GenericToolChip = ({
  onToolApproval,
  part,
}: {
  onToolApproval?: ToolApprovalHandler;
  part: ToolLikePart;
}) => {
  const [expanded, setExpanded] = useState(false);
  const toolName = getToolName(part);
  const isEnterPlanMode = normalizeToolName(toolName) === "enter-plan-mode";
  const ToolIcon = isEnterPlanMode ? MapIcon : WrenchIcon;
  const tone = isEnterPlanMode ? "cyan" : "slate";
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const isCompleted = state === "output-available" || state === "output-error";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const hasParameters = isRecord(part.input);
  const parametersCode = hasParameters
    ? JSON.stringify(part.input, null, 2)
    : null;
  const outputCode = getGenericToolOutputCode(part);
  const hasOutput = part.output !== undefined || hasError;
  const canExpand =
    hasParameters || hasOutput || state === "approval-requested";
  const approvalTitle =
    getStringFromPaths(part.input, [["title"], ["permission", "title"]]) ??
    `Allow ${formatToolName(toolName)}?`;
  const approvalDescription = getStringFromPaths(part.input, [
    ["description"],
    ["decisionReason"],
    ["blockedPath"],
    ["permission", "description"],
  ]);

  useEffect(() => {
    if (isCompleted) {
      setExpanded(true);
    }
  }, [isCompleted]);

  return (
    <div
      className={
        expanded || state === "approval-requested" ? "w-full" : undefined
      }
    >
      <div className="flex items-center gap-2">
        <ChipButton
          aria-label={formatToolName(toolName)}
          className={cn(
            canExpand && "cursor-pointer",
            isRunning && "animate-pulse",
          )}
          hasError={hasError}
          onClick={() => canExpand && setExpanded(!expanded)}
          tone={tone}
          type="button"
        >
          <ToolIcon className="size-3.5 shrink-0" />
          {!isRunning ? (
            <>
              <span className="max-w-56 truncate font-medium">
                {formatToolName(toolName)}
              </span>
              <span className={CHIP_SUBTEXT_CLASSES}>
                {TOOL_STATE_LABELS[state]}
              </span>
              {hasError ? (
                <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
              ) : null}
            </>
          ) : null}
        </ChipButton>
      </div>

      {part.approval?.id && part.approval && onToolApproval ? (
        <ActionApproval
          approval={part.approval}
          className="mt-2"
          onToolApproval={onToolApproval}
          state={state}
        >
          <span className="space-y-1 text-sm">
            <span className="block">{approvalTitle}</span>
            {approvalDescription ? (
              <span className="block text-muted-foreground text-xs">
                {approvalDescription}
              </span>
            ) : null}
          </span>
        </ActionApproval>
      ) : null}

      {expanded ? (
        <div
          className={getExpandedChipClasses(tone, hasError)}
          style={{ borderColor: "currentColor" }}
        >
          {parametersCode !== null || outputCode !== null ? (
            <div className="overflow-hidden rounded-md border bg-background">
              {parametersCode !== null ? (
                <GenericToolCodeSection
                  code={parametersCode}
                  label="Parameters"
                  language="json"
                  maxHeightClassName="max-h-64"
                />
              ) : null}
              {parametersCode !== null && outputCode !== null ? (
                <div className="border-t" />
              ) : null}
              {outputCode !== null ? (
                <GenericToolCodeSection
                  code={outputCode.code}
                  label={outputCode.label}
                  language={outputCode.language}
                  maxHeightClassName="max-h-96"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const AssistantMessagePart = ({
  part,
  isStreaming = false,
  onToolApproval,
  projectPath,
  showReasoningSummaries = true,
}: {
  part: MessagePart;
  isStreaming?: boolean;
  onToolApproval?: ToolApprovalHandler;
  projectPath: string;
  showReasoningSummaries?: boolean;
}) => {
  if (isTodoListPart(part)) {
    return null;
  }

  if (part.type === "text") {
    return (
      <StreamingMessageResponse
        isStreaming={isStreaming}
        projectPath={projectPath}
        text={part.text}
      />
    );
  }

  if (part.type === "reasoning") {
    const hasReasoningText = part.text.trim().length > 0;

    // Hide when there's no content to show — the lull indicator in
    // ChatPanel already signals "working" during streaming.
    if (!showReasoningSummaries || !hasReasoningText) {
      return null;
    }

    return (
      <Reasoning
        className="my-3 w-full"
        defaultOpen={showReasoningSummaries}
        isStreaming={isStreaming}
        hasContent={hasReasoningText}
      >
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }

  if (part.type === "file") {
    const label = part.filename ?? part.url ?? "Attached file";

    return <Badge variant="secondary">File: {label}</Badge>;
  }

  if (part.type === "source-url" || part.type === "source-document") {
    // Sources are grouped and rendered at the message level in chat-panel
    return null;
  }

  if (part.type === "step-start") {
    return null;
  }

  if (isToolLikePart(part)) {
    return <GenericToolChip onToolApproval={onToolApproval} part={part} />;
  }

  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-surface-100 dark:bg-surface-900 p-3 text-xs">
      {stringifyPart(part)}
    </pre>
  );
};
