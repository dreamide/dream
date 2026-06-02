import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import type { ToolPart } from "@/components/ai-elements/tool";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import {
  getToolName,
  isToolLikePart,
  type MessagePart,
  type ToolLikePart,
} from "../assistant-message-tools";
import { isTodoListPart } from "../chat/todo-list";
import { stringifyPart } from "../ide-state";
import {
  ActionApproval,
  formatToolName,
  getStringFromPaths,
  isRecord,
  isString,
  JsonBlock,
  StreamingMessageResponse,
  type ToolApprovalHandler,
} from "./shared";

const renderToolOutput = (part: ToolLikePart) => {
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  if (hasError) {
    return (
      <div className="space-y-2">
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Error
        </h4>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive-surface p-3 text-destructive text-xs">
          {part.errorText}
        </pre>
      </div>
    );
  }

  if (part.output === undefined) {
    return null;
  }

  const outputContent = <JsonBlock value={part.output} />;

  return (
    <div className="space-y-2">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Result
      </h4>
      {outputContent}
    </div>
  );
};

const ToolPartCard = ({
  onToolApproval,
  part,
}: {
  onToolApproval?: ToolApprovalHandler;
  part: ToolLikePart;
}) => {
  const toolName = getToolName(part);
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isCompleted = state === "output-available" || state === "output-error";
  const approvalTitle =
    getStringFromPaths(part.input, [["title"], ["permission", "title"]]) ??
    `Allow ${formatToolName(toolName)}?`;
  const approvalDescription = getStringFromPaths(part.input, [
    ["description"],
    ["decisionReason"],
    ["blockedPath"],
    ["permission", "description"],
  ]);

  const toolHeaderProps =
    part.type === "dynamic-tool"
      ? {
          type: "dynamic-tool" as const,
          state,
          toolName: isString(part.toolName) ? part.toolName : toolName,
        }
      : {
          type: part.type as `tool-${string}`,
          state,
        };

  return (
    <Tool defaultOpen={isCompleted}>
      <ToolHeader title={formatToolName(toolName)} {...toolHeaderProps} />
      <ToolContent>
        {part.approval?.id && part.approval && onToolApproval ? (
          <ActionApproval
            approval={part.approval}
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
        {isRecord(part.input) ? (
          <ToolInput input={part.input as ToolPart["input"]} />
        ) : null}
        {renderToolOutput(part)}
      </ToolContent>
    </Tool>
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
    return <ToolPartCard onToolApproval={onToolApproval} part={part} />;
  }

  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-surface-100 dark:bg-surface-900 p-3 text-xs">
      {stringifyPart(part)}
    </pre>
  );
};
