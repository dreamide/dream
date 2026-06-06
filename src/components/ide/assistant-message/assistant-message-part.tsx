import {
  CheckIcon,
  CircleQuestionMarkIcon,
  MapIcon,
  WrenchIcon,
} from "lucide-react";
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

type AskUserQuestionOption = {
  description: string;
  label: string;
};

type AskUserQuestionItem = {
  header: string;
  id: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
  question: string;
};

type AskUserQuestionSummaryItem = {
  answer: string;
  question: string;
};

const askUserQuestionAnswerCache = new Map<string, Record<string, string>>();

const getAskUserQuestions = (input: unknown): AskUserQuestionItem[] => {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return [];
  }

  return input.questions.flatMap((question): AskUserQuestionItem[] => {
    if (!isRecord(question) || !Array.isArray(question.options)) {
      return [];
    }

    const questionText = isString(question.question) ? question.question : "";
    const header = isString(question.header) ? question.header : "Question";
    if (!questionText) {
      return [];
    }
    const id =
      isString(question.id) && question.id.trim()
        ? question.id.trim()
        : questionText;

    const options = question.options.flatMap(
      (option): AskUserQuestionOption[] => {
        if (!isRecord(option) || !isString(option.label)) {
          return [];
        }

        return [
          {
            description: isString(option.description) ? option.description : "",
            label: option.label,
          },
        ];
      },
    );

    if (options.length === 0) {
      return [];
    }

    return [
      {
        header,
        id,
        multiSelect: question.multiSelect === true,
        options,
        question: questionText,
      },
    ];
  });
};

const getAnswerMapFromValue = (
  value: unknown,
): Record<string, string> | null => {
  if (!isRecord(value)) {
    return null;
  }

  const answers = isRecord(value.answers) ? value.answers : value;
  const answerEntries = Object.entries(answers).flatMap(([key, answer]) => {
    if (isString(answer)) {
      return [[key, answer] as const];
    }

    if (Array.isArray(answer)) {
      const labels = answer.filter(isString);
      return labels.length > 0 ? [[key, labels.join(", ")] as const] : [];
    }

    return [];
  });

  return answerEntries.length > 0 ? Object.fromEntries(answerEntries) : null;
};

const getAnswerMapFromJson = (
  value: unknown,
): Record<string, string> | null => {
  if (!isString(value) || value.trim().length === 0) {
    return null;
  }

  try {
    return getAnswerMapFromValue(JSON.parse(value));
  } catch {
    return null;
  }
};

const getAnswerMapFromClaudeOutputText = (
  value: unknown,
): Record<string, string> | null => {
  if (!isString(value)) {
    return null;
  }

  const answerEntries = [...value.matchAll(/"([^"]+)"="([^"]*)"/g)].map(
    ([, question, answer]) => [question, answer] as const,
  );

  return answerEntries.length > 0 ? Object.fromEntries(answerEntries) : null;
};

const getAskUserQuestionAnswerMap = (
  part: ToolLikePart,
  approvalId: string | null,
): Record<string, string> => {
  return (
    (approvalId ? askUserQuestionAnswerCache.get(approvalId) : null) ??
    getAnswerMapFromJson(part.approval?.reason) ??
    getAnswerMapFromValue(part.input) ??
    getAnswerMapFromValue(part.output) ??
    getAnswerMapFromJson(part.output) ??
    getAnswerMapFromClaudeOutputText(part.output) ??
    {}
  );
};

const getAskUserQuestionSummary = (
  questions: AskUserQuestionItem[],
  part: ToolLikePart,
  approvalId: string | null,
): AskUserQuestionSummaryItem[] => {
  const answerMap = getAskUserQuestionAnswerMap(part, approvalId);
  const answerValues = Object.values(answerMap).filter(
    (answer) => answer.length > 0,
  );

  const summaries = questions.flatMap((question) => {
    const answer = answerMap[question.id] ?? answerMap[question.question];
    return answer
      ? [
          {
            answer,
            question: question.question,
          },
        ]
      : [];
  });

  if (summaries.length > 0) {
    return summaries;
  }

  if (questions.length === 1 && answerValues.length === 1) {
    return [
      {
        answer: answerValues[0],
        question: questions[0].question,
      },
    ];
  }

  return Object.entries(answerMap).map(([question, answer]) => ({
    answer,
    question,
  }));
};

const AskUserQuestionSummary = ({
  items,
}: {
  items: AskUserQuestionSummaryItem[];
}) => {
  return (
    <div className="space-y-3 p-2 text-sm">
      {items.map((item) => (
        <div className="space-y-1" key={item.question}>
          <div className="text-foreground">{item.question}</div>
          <div className="text-muted-foreground">{item.answer}</div>
        </div>
      ))}
    </div>
  );
};

const AskUserQuestionApproval = ({
  approvalId,
  onToolApproval,
  questions,
}: {
  approvalId: string;
  onToolApproval: ToolApprovalHandler;
  questions: AskUserQuestionItem[];
}) => {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});

  const buildReason = (nextAnswers: Record<string, string[]>) =>
    JSON.stringify({
      answers: Object.fromEntries(
        questions.map((question) => [
          question.id,
          (nextAnswers[question.id] ?? []).join(", "),
        ]),
      ),
    });

  const canSubmit = questions.every(
    (question) => (answers[question.id] ?? []).length > 0,
  );

  const submit = (nextAnswers = answers) => {
    askUserQuestionAnswerCache.set(
      approvalId,
      Object.fromEntries(
        questions.map((question) => [
          question.id,
          (nextAnswers[question.id] ?? []).join(", "),
        ]),
      ),
    );
    onToolApproval({
      approved: true,
      id: approvalId,
      reason: buildReason(nextAnswers),
    });
  };

  const chooseSingle = (question: AskUserQuestionItem, label: string) => {
    setAnswers({ ...answers, [question.id]: [label] });
  };

  const toggleMulti = (question: AskUserQuestionItem, label: string) => {
    const current = answers[question.id] ?? [];
    const nextSelected = current.includes(label)
      ? current.filter((item) => item !== label)
      : [...current, label];
    setAnswers({ ...answers, [question.id]: nextSelected });
  };

  return (
    <div className="mt-2 w-full rounded-md border border-success-border bg-success-surface p-3 text-sm">
      <div className="space-y-3">
        {questions.map((question) => {
          const selected = answers[question.id] ?? [];

          return (
            <div className="space-y-2" key={question.id}>
              <div>
                <div className="font-medium">{question.question}</div>
                <div className="text-emerald-200/80 text-xs">
                  {question.header}
                </div>
              </div>
              <div className="space-y-2">
                {question.options.map((option, optionIndex) => {
                  const isSelected = selected.includes(option.label);

                  return (
                    <button
                      className={cn(
                        "flex w-full items-start gap-3 rounded-md bg-[#021f12] px-3 py-2 text-left text-emerald-50 transition-colors hover:bg-[#01170d]",
                        isSelected && "bg-[#01170d]",
                      )}
                      key={option.label}
                      onClick={() =>
                        question.multiSelect
                          ? toggleMulti(question, option.label)
                          : chooseSingle(question, option.label)
                      }
                      type="button"
                    >
                      <span className="shrink-0 font-medium text-emerald-200 text-sm">
                        {optionIndex + 1}.
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-sm">
                          {option.label}
                        </span>
                        {option.description ? (
                          <span className="block text-emerald-200/80 text-xs">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                      {isSelected ? (
                        <CheckIcon className="size-4 shrink-0 self-center text-emerald-300" />
                      ) : (
                        <span className="size-4 shrink-0 self-center" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          className="h-8 rounded-md border px-3 text-sm"
          onClick={() =>
            onToolApproval({
              approved: false,
              id: approvalId,
            })
          }
          type="button"
        >
          Cancel
        </button>
        <button
          className="h-8 rounded-md bg-emerald-600 px-3 text-sm text-white disabled:opacity-50"
          disabled={!canSubmit}
          onClick={() => submit()}
          type="button"
        >
          Save
        </button>
      </div>
    </div>
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
  const normalizedToolName = normalizeToolName(toolName);
  const isPlanModeTool =
    normalizedToolName === "enter-plan-mode" ||
    normalizedToolName === "exit-plan-mode";
  const isAskUserQuestion = normalizedToolName === "ask-user-question";
  const ToolIcon = isAskUserQuestion
    ? CircleQuestionMarkIcon
    : isPlanModeTool
      ? MapIcon
      : WrenchIcon;
  const tone = isAskUserQuestion ? "green" : "slate";
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const isCompleted = state === "output-available" || state === "output-error";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const hasParameters =
    !isAskUserQuestion && !isPlanModeTool && isRecord(part.input);
  const parametersCode = hasParameters
    ? JSON.stringify(part.input, null, 2)
    : null;
  const outputCode = isAskUserQuestion ? null : getGenericToolOutputCode(part);
  const hasOutput =
    !isAskUserQuestion && (part.output !== undefined || hasError);
  const approvalTitle =
    getStringFromPaths(part.input, [
      ["title"],
      ["displayName"],
      ["permission", "title"],
      ["permission", "displayName"],
    ]) ?? `Allow ${formatToolName(toolName)}?`;
  const approvalDescription = getStringFromPaths(part.input, [
    ["description"],
    ["decisionReason"],
    ["blockedPath"],
    ["permission", "description"],
  ]);
  const askUserQuestions = isAskUserQuestion
    ? getAskUserQuestions(part.input)
    : [];
  const askUserQuestionApprovalId =
    isAskUserQuestion && typeof part.toolCallId === "string"
      ? (part.approval?.id ?? `anthropic:${part.toolCallId}`)
      : null;
  const askUserQuestionSummary = isAskUserQuestion
    ? getAskUserQuestionSummary(
        askUserQuestions,
        part,
        askUserQuestionApprovalId,
      )
    : [];
  const hasAskUserQuestionSummary = askUserQuestionSummary.length > 0;
  const shouldShowAskUserQuestionApproval =
    isAskUserQuestion &&
    askUserQuestions.length > 0 &&
    !!askUserQuestionApprovalId &&
    !!onToolApproval &&
    state !== "output-available" &&
    state !== "output-error" &&
    state !== "approval-responded" &&
    state !== "output-denied";
  const canExpandAskUserQuestion =
    isAskUserQuestion &&
    !shouldShowAskUserQuestionApproval &&
    hasAskUserQuestionSummary &&
    (isCompleted || state === "approval-responded");
  const canExpand =
    canExpandAskUserQuestion ||
    (!isAskUserQuestion &&
      (hasParameters || hasOutput || state === "approval-requested"));

  useEffect(() => {
    if (isCompleted && (!isAskUserQuestion || hasAskUserQuestionSummary)) {
      setExpanded(true);
    }
  }, [hasAskUserQuestionSummary, isCompleted, isAskUserQuestion]);

  return (
    <div
      className={
        expanded ||
        state === "approval-requested" ||
        shouldShowAskUserQuestionApproval
          ? "w-full"
          : undefined
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
          {!isRunning || isAskUserQuestion ? (
            <>
              <span className="max-w-56 truncate font-medium">
                {formatToolName(toolName)}
              </span>
              <span className={CHIP_SUBTEXT_CLASSES}>
                {TOOL_STATE_LABELS[state]}
              </span>
            </>
          ) : null}
        </ChipButton>
      </div>

      {shouldShowAskUserQuestionApproval ? (
        <AskUserQuestionApproval
          approvalId={askUserQuestionApprovalId}
          onToolApproval={onToolApproval}
          questions={askUserQuestions}
        />
      ) : part.approval?.id && part.approval && onToolApproval ? (
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
          {hasAskUserQuestionSummary ? (
            <AskUserQuestionSummary items={askUserQuestionSummary} />
          ) : parametersCode !== null || outputCode !== null ? (
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
