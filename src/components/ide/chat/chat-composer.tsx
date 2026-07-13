import type { ChatStatus, LanguageModelUsage } from "ai";
import { Bot, MapIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type ChangeEventHandler,
  type KeyboardEventHandler,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Sparkles from "@/components/ui/sparkles";
import {
  createAccentSparklesPalette,
  type SparklesPaletteName,
} from "@/lib/sparkles-palettes";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type {
  AgentMode,
  AiProvider,
  ModelSpeed,
  ProjectReference,
  ReasoningEffort,
} from "@/types/ide";
import { PromptAttachments } from "../chat";
import { AGENT_MODE_OPTIONS } from "../ide-types";
import { MaterialFileIcon, MaterialFolderIcon } from "../material-file-icon";
import type { ChatTodoSummary } from "./todo-list";
import { TodoListPanel, TodoListPanelTrigger } from "./todo-list-popover";
import { UsageLimitsPopover } from "./usage-limits-popover";

export interface ChatPanelModelOption {
  contextWindow?: number;
  id: string;
  label: string;
  provider: AiProvider;
  reasoningEfforts: ReasoningEffort[];
  speedTiers: ModelSpeed[];
}

export interface ChatPanelReasoningOption {
  label: string;
  value: ReasoningEffort;
}

export interface ChatPanelSpeedOption {
  description: string;
  label: string;
  value: ModelSpeed;
}

type ProjectReferenceItem = ProjectReference;

type ProjectFilesListResponse = {
  count: number;
  files: string[];
};

type ActiveReferenceToken = {
  end: number;
  query: string;
  start: number;
};

const PROJECT_REFERENCE_RESULT_LIMIT = 8;
const PROJECT_REFERENCE_FILE_LIMIT = 2500;

const getAgentModeIcon = (mode: AgentMode) => (mode === "plan" ? MapIcon : Bot);

const normalizeProjectPath = (path: string) => path.replace(/\\/g, "/");

const getReferenceName = (path: string) => {
  const normalized = normalizeProjectPath(path);
  return normalized.split("/").pop() || normalized;
};

const getReferenceParentPath = (path: string) => {
  const normalized = normalizeProjectPath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
};

const isReferenceMentionBoundary = (character: string | undefined) =>
  !character || /\s|[),.;:!?]/.test(character);

const getTextCharacter = (text: string, index: number) =>
  index >= 0 && index < text.length ? text[index] : undefined;

const REFERENCE_ICON_TEXT_SLOT = "      ";

const getReferenceMentionText = (reference: ProjectReference) =>
  `${REFERENCE_ICON_TEXT_SLOT}${reference.name}`;

const isReferenceMentionRange = (
  text: string,
  start: number,
  mentionLength: number,
) =>
  (/\s/.test(getTextCharacter(text, start) ?? "") ||
    isReferenceMentionBoundary(getTextCharacter(text, start - 1))) &&
  isReferenceMentionBoundary(getTextCharacter(text, start + mentionLength));

const hasReferenceMention = (text: string, reference: ProjectReference) => {
  const mention = getReferenceMentionText(reference);
  let index = text.indexOf(mention);

  while (index !== -1) {
    if (isReferenceMentionRange(text, index, mention.length)) {
      return true;
    }
    index = text.indexOf(mention, index + mention.length);
  }

  return false;
};

type ReferenceMentionRange = {
  end: number;
  reference: ProjectReference;
  start: number;
};

const getReferenceMentionRanges = (
  text: string,
  references: ProjectReference[],
) =>
  references.flatMap((reference): ReferenceMentionRange[] => {
    const mention = getReferenceMentionText(reference);
    const ranges: ReferenceMentionRange[] = [];
    let index = text.indexOf(mention);

    while (index !== -1) {
      const end = index + mention.length;
      if (isReferenceMentionRange(text, index, mention.length)) {
        ranges.push({ end, reference, start: index });
      }
      index = text.indexOf(mention, index + mention.length);
    }

    return ranges;
  });

const getReferenceDeletionRange = ({
  key,
  references,
  selectionEnd,
  selectionStart,
  text,
}: {
  key: "Backspace" | "Delete";
  references: ProjectReference[];
  selectionEnd: number;
  selectionStart: number;
  text: string;
}) => {
  const ranges = getReferenceMentionRanges(text, references);
  if (ranges.length === 0) {
    return null;
  }

  if (selectionStart !== selectionEnd) {
    const overlappingRanges = ranges.filter(
      (range) => selectionStart < range.end && selectionEnd > range.start,
    );
    if (overlappingRanges.length === 0) {
      return null;
    }

    return {
      end: Math.max(
        selectionEnd,
        ...overlappingRanges.map((range) => range.end),
      ),
      start: Math.min(
        selectionStart,
        ...overlappingRanges.map((range) => range.start),
      ),
    };
  }

  return ranges.find((range) =>
    key === "Backspace"
      ? selectionStart > range.start && selectionStart <= range.end
      : selectionStart >= range.start && selectionStart < range.end,
  );
};

const removeReferenceMentionRange = (
  text: string,
  range: { end: number; start: number },
) => {
  let { end, start } = range;

  if (
    getTextCharacter(text, start - 1) === " " &&
    getTextCharacter(text, end) === " "
  ) {
    end += 1;
  } else if (start === 0 && getTextCharacter(text, end) === " ") {
    end += 1;
  } else if (
    getTextCharacter(text, start - 1) === " " &&
    (end === text.length ||
      isReferenceMentionBoundary(getTextCharacter(text, end)))
  ) {
    start -= 1;
  }

  return {
    nextCaretIndex: start,
    nextText: `${text.slice(0, start)}${text.slice(end)}`,
  };
};

const expandReferenceMentionsForSubmit = (
  text: string,
  references: ProjectReference[],
) => {
  if (!text || references.length === 0) {
    return text;
  }

  const sortedReferences = [...references].sort(
    (left, right) =>
      getReferenceMentionText(right).length -
      getReferenceMentionText(left).length,
  );
  let output = "";
  let index = 0;

  while (index < text.length) {
    const reference = sortedReferences.find((item) => {
      const mention = getReferenceMentionText(item);
      return (
        text.startsWith(mention, index) &&
        isReferenceMentionRange(text, index, mention.length)
      );
    });

    if (!reference) {
      output += text[index];
      index += 1;
      continue;
    }

    const mention = getReferenceMentionText(reference);
    output += `${index > 0 ? " " : ""}@${reference.path}`;
    index += mention.length;
  }

  return output;
};

const getActiveReferenceToken = (
  text: string,
  caretIndex: number,
): ActiveReferenceToken | null => {
  const beforeCaret = text.slice(0, caretIndex);
  const atIndex = beforeCaret.lastIndexOf("@");

  if (atIndex === -1) {
    return null;
  }

  const characterBeforeAt = atIndex > 0 ? beforeCaret.at(atIndex - 1) : "";
  if (characterBeforeAt && !/\s|[([{]/.test(characterBeforeAt)) {
    return null;
  }

  const query = beforeCaret.slice(atIndex + 1);
  if (/\s/.test(query)) {
    return null;
  }

  return {
    end: caretIndex,
    query,
    start: atIndex,
  };
};

const buildProjectReferences = (files: string[]): ProjectReferenceItem[] => {
  const folders = new Set<string>();
  const normalizedFiles = files.map(normalizeProjectPath);

  for (const filePath of normalizedFiles) {
    const segments = filePath.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      folders.add(segments.slice(0, index).join("/"));
    }
  }

  return [
    ...[...folders].map((path) => ({
      kind: "folder" as const,
      name: getReferenceName(path),
      parentPath: getReferenceParentPath(path),
      path,
    })),
    ...normalizedFiles.map((path) => ({
      kind: "file" as const,
      name: getReferenceName(path),
      parentPath: getReferenceParentPath(path),
      path,
    })),
  ].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "folder" ? -1 : 1;
    }

    return left.path.localeCompare(right.path);
  });
};

const getReferenceScore = (item: ProjectReferenceItem, query: string) => {
  if (!query) {
    return item.kind === "folder" ? 1 : 2;
  }

  const normalizedQuery = query.toLowerCase();
  const name = item.name.toLowerCase();
  const path = item.path.toLowerCase();

  if (name === normalizedQuery) {
    return 0;
  }
  if (name.startsWith(normalizedQuery)) {
    return 1;
  }
  if (path.startsWith(normalizedQuery)) {
    return 2;
  }
  if (name.includes(normalizedQuery)) {
    return 3;
  }
  if (path.includes(normalizedQuery)) {
    return 4;
  }

  return null;
};

const searchProjectReferences = (
  items: ProjectReferenceItem[],
  query: string,
) =>
  items
    .flatMap((item) => {
      const score = getReferenceScore(item, query);
      return score === null ? [] : [{ item, score }];
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.item.path.localeCompare(right.item.path),
    )
    .slice(0, PROJECT_REFERENCE_RESULT_LIMIT)
    .map(({ item }) => item);

const InlineProjectReferenceMentions = ({
  references,
  text,
}: {
  references: ProjectReference[];
  text: string;
}) => {
  if (!text || references.length === 0) {
    return null;
  }

  const sortedReferences = [...references].sort(
    (left, right) =>
      getReferenceMentionText(right).length -
      getReferenceMentionText(left).length,
  );
  const nodes: ReactNode[] = [];
  let pendingText = "";
  let index = 0;

  const flushText = () => {
    if (!pendingText) {
      return;
    }

    nodes.push(
      <span key={`text-${nodes.length}`} className="whitespace-pre-wrap">
        {pendingText}
      </span>,
    );
    pendingText = "";
  };

  while (index < text.length) {
    const reference = sortedReferences.find((item) => {
      const mention = getReferenceMentionText(item);
      return (
        text.startsWith(mention, index) &&
        isReferenceMentionRange(text, index, mention.length)
      );
    });

    if (!reference) {
      pendingText += text[index];
      index += 1;
      continue;
    }

    flushText();
    nodes.push(
      <span
        className="text-info-foreground dark:text-info-foreground"
        key={`reference-${reference.kind}:${reference.path}:${index}`}
      >
        <span className="relative inline-block text-transparent">
          {REFERENCE_ICON_TEXT_SLOT}
          {reference.kind === "folder" ? (
            <MaterialFolderIcon
              className="absolute left-0.5 top-1/2 size-3.5 -translate-y-1/2 text-info-foreground dark:text-info-foreground"
              name={reference.name}
            />
          ) : (
            <MaterialFileIcon
              className="absolute left-0.5 top-1/2 size-3.5 -translate-y-1/2 text-info-foreground dark:text-info-foreground"
              path={reference.path}
            />
          )}
        </span>
        {reference.name}
      </span>,
    );
    index += getReferenceMentionText(reference).length;
  }

  flushText();

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm leading-normal"
    >
      {nodes}
    </div>
  );
};

const ChatComposerSubmitButton = ({
  isActive,
  isProcessing,
  isProviderInstalled,
  onStop,
  promptText,
  selectedModel,
  selectedReferenceCount,
  status,
}: {
  isActive: boolean;
  isProcessing: boolean;
  isProviderInstalled: boolean;
  onStop: () => void;
  promptText: string;
  selectedModel: string;
  selectedReferenceCount: number;
  status: ChatStatus;
}) => {
  const attachments = usePromptInputAttachments();
  const hasPromptContent =
    promptText.trim() !== "" ||
    selectedReferenceCount > 0 ||
    attachments.files.length > 0;

  return (
    <PromptInputSubmit
      className="size-8 rounded-md bg-surface-900 text-surface-50 hover:bg-surface-800 dark:bg-surface-200 dark:text-surface-900 dark:hover:bg-surface-300"
      disabled={
        !isActive ||
        (!isProcessing &&
          (!isProviderInstalled || selectedModel === "" || !hasPromptContent))
      }
      onStop={onStop}
      status={status}
    />
  );
};

export interface ChatComposerProps {
  agentMode: AgentMode;
  allModelOptions: ChatPanelModelOption[];
  chatProvider: AiProvider;
  contextWindow: number;
  contextUsage?: LanguageModelUsage;
  contextUsedTokens: number;
  isActive: boolean;
  isProcessing: boolean;
  isProviderInstalled: boolean;
  modelId: string;
  onAgentModeChange: (mode: AgentMode) => void;
  onModelChange: (option: ChatPanelModelOption) => void;
  onModelSpeedChange: (speed: ModelSpeed) => void;
  onPromptKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onPromptTextChange: (value: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onSparklesPaletteChange: (palette: SparklesPaletteName) => void;
  onStop: () => void;
  onSubmit: (prompt: PromptInputMessage) => void | Promise<void>;
  promptDomId: string;
  promptInputDomId: string;
  promptText: string;
  projectPath: string;
  reasoningEffortOptions: ChatPanelReasoningOption[];
  speedOptions: ChatPanelSpeedOption[];
  selectedModel: string;
  selectedModelLabel: string;
  selectedModelValue: string | undefined;
  selectedProvider: AiProvider;
  selectedModelSpeed: ModelSpeed;
  selectedModelSpeedLabel: string;
  selectedReasoningEffort: ReasoningEffort;
  selectedReasoningLabel: string;
  sparklesPalette: SparklesPaletteName;
  status: ChatStatus;
  todoSummary: ChatTodoSummary;
}

export const ChatComposer = ({
  agentMode,
  allModelOptions,
  chatProvider,
  contextWindow,
  contextUsage,
  contextUsedTokens,
  isActive,
  isProcessing,
  isProviderInstalled,
  modelId,
  onAgentModeChange,
  onModelChange,
  onModelSpeedChange,
  onPromptKeyDown,
  onPromptTextChange,
  onReasoningEffortChange,
  onSparklesPaletteChange,
  onStop,
  onSubmit,
  promptDomId,
  promptInputDomId,
  promptText,
  projectPath,
  reasoningEffortOptions,
  speedOptions,
  selectedModel,
  selectedModelLabel,
  selectedModelValue,
  selectedProvider,
  selectedModelSpeed,
  selectedModelSpeedLabel,
  selectedReasoningEffort,
  selectedReasoningLabel,
  sparklesPalette,
  status,
  todoSummary,
}: ChatComposerProps) => {
  const chatT = useTranslations("chat");
  const modelT = useTranslations("models");
  const settingsT = useTranslations("settings");
  const AgentModeIcon = getAgentModeIcon(agentMode);
  const selectedAgentModeLabel = chatT(agentMode);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const todoPanelId = useId();
  const [projectReferences, setProjectReferences] = useState<
    ProjectReferenceItem[]
  >([]);
  const [isTodoPanelOpen, setIsTodoPanelOpen] = useState(false);
  const [activeReferenceToken, setActiveReferenceToken] =
    useState<ActiveReferenceToken | null>(null);
  const [highlightedReferenceIndex, setHighlightedReferenceIndex] = useState(0);
  const [selectedReferences, setSelectedReferences] = useState<
    ProjectReference[]
  >([]);
  const accentColor = useUiStore((s) => s.accentColor);
  const accentSparklesPalette = useMemo(
    () => createAccentSparklesPalette(accentColor),
    [accentColor],
  );
  const resolvedSparklesPalette =
    sparklesPalette === "accent" ? accentSparklesPalette : sparklesPalette;

  useEffect(() => {
    const abortController = new AbortController();

    const loadProjectReferences = async () => {
      try {
        const response = await fetch("/api/project-files", {
          body: JSON.stringify({
            directory: ".",
            maxResults: PROJECT_REFERENCE_FILE_LIMIT,
            projectPath,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: abortController.signal,
        });

        if (!response.ok) {
          setProjectReferences([]);
          return;
        }

        const payload = (await response.json()) as ProjectFilesListResponse;
        setProjectReferences(buildProjectReferences(payload.files));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setProjectReferences([]);
      }
    };

    void loadProjectReferences();

    return () => abortController.abort();
  }, [projectPath]);

  useEffect(() => {
    if (promptText !== "") {
      return;
    }

    setActiveReferenceToken(null);
    setHighlightedReferenceIndex(0);
  }, [promptText]);

  useEffect(() => {
    if (todoSummary.totalCount === 0) {
      setIsTodoPanelOpen(false);
    }
  }, [todoSummary.totalCount]);

  const referenceResults = useMemo(
    () =>
      activeReferenceToken
        ? searchProjectReferences(projectReferences, activeReferenceToken.query)
        : [],
    [activeReferenceToken, projectReferences],
  );
  const activeTokenIsSelectedReference =
    activeReferenceToken !== null &&
    selectedReferences.some(
      (reference) => reference.name === activeReferenceToken.query,
    );

  const showReferenceResults =
    activeReferenceToken !== null &&
    !activeTokenIsSelectedReference &&
    referenceResults.length > 0;

  const updateActiveReferenceToken = useCallback(
    (text: string, caretIndex: number | null | undefined) => {
      setActiveReferenceToken(
        typeof caretIndex === "number"
          ? getActiveReferenceToken(text, caretIndex)
          : null,
      );
      setHighlightedReferenceIndex(0);
    },
    [],
  );

  const handlePromptChange: ChangeEventHandler<HTMLTextAreaElement> =
    useCallback(
      (event) => {
        const nextValue = event.currentTarget.value;
        onPromptTextChange(nextValue);
        setSelectedReferences((current) =>
          current.filter((reference) =>
            hasReferenceMention(nextValue, reference),
          ),
        );
        updateActiveReferenceToken(
          nextValue,
          event.currentTarget.selectionStart,
        );
      },
      [onPromptTextChange, updateActiveReferenceToken],
    );

  const insertProjectReference = useCallback(
    (item: ProjectReferenceItem) => {
      if (!activeReferenceToken) {
        return;
      }

      const before = promptText.slice(0, activeReferenceToken.start);
      const after = promptText.slice(activeReferenceToken.end);
      const mentionText = getReferenceMentionText(item);
      const separator =
        after.length > 0 && !isReferenceMentionBoundary(after.at(0)) ? " " : "";
      const nextValue = `${before}${mentionText}${separator}${after}`;
      const nextCaretIndex =
        before.length + mentionText.length + separator.length;

      onPromptTextChange(nextValue);
      setSelectedReferences((current) =>
        current.some(
          (reference) =>
            reference.kind === item.kind && reference.path === item.path,
        )
          ? current
          : [...current, item],
      );
      setActiveReferenceToken(null);
      setHighlightedReferenceIndex(0);

      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextCaretIndex, nextCaretIndex);
      });
    },
    [activeReferenceToken, onPromptTextChange, promptText],
  );

  const handleComposerSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      await onSubmit({
        ...prompt,
        text: expandReferenceMentionsForSubmit(prompt.text, selectedReferences),
        references: selectedReferences,
      });
      setSelectedReferences([]);
      setActiveReferenceToken(null);
      setHighlightedReferenceIndex(0);
    },
    [onSubmit, selectedReferences],
  );

  const handlePromptKeyDown: KeyboardEventHandler<HTMLTextAreaElement> =
    useCallback(
      (event) => {
        if (
          (event.key === "Backspace" || event.key === "Delete") &&
          selectedReferences.length > 0
        ) {
          const deletionRange = getReferenceDeletionRange({
            key: event.key,
            references: selectedReferences,
            selectionEnd: event.currentTarget.selectionEnd,
            selectionStart: event.currentTarget.selectionStart,
            text: promptText,
          });

          if (deletionRange) {
            event.preventDefault();
            const { nextCaretIndex, nextText } = removeReferenceMentionRange(
              promptText,
              deletionRange,
            );

            onPromptTextChange(nextText);
            setSelectedReferences((current) =>
              current.filter((reference) =>
                hasReferenceMention(nextText, reference),
              ),
            );
            setActiveReferenceToken(null);
            setHighlightedReferenceIndex(0);

            requestAnimationFrame(() => {
              textareaRef.current?.focus();
              textareaRef.current?.setSelectionRange(
                nextCaretIndex,
                nextCaretIndex,
              );
            });
            return;
          }
        }

        if (showReferenceResults) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlightedReferenceIndex(
              (current) => (current + 1) % referenceResults.length,
            );
            return;
          }

          if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlightedReferenceIndex(
              (current) =>
                (current - 1 + referenceResults.length) %
                referenceResults.length,
            );
            return;
          }

          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            const selected = referenceResults[highlightedReferenceIndex];
            if (selected) {
              insertProjectReference(selected);
            }
            return;
          }
        }

        if (activeReferenceToken && event.key === "Escape") {
          event.preventDefault();
          setActiveReferenceToken(null);
          setHighlightedReferenceIndex(0);
          return;
        }

        onPromptKeyDown(event);
      },
      [
        activeReferenceToken,
        highlightedReferenceIndex,
        insertProjectReference,
        onPromptKeyDown,
        onPromptTextChange,
        promptText,
        referenceResults,
        selectedReferences,
        showReferenceResults,
      ],
    );

  return (
    <div id={promptDomId} className="shrink-0 px-2 pb-2">
      <div className="mx-auto w-full max-w-[700px]">
        {showReferenceResults ? (
          <div className="mb-2 overflow-hidden rounded-lg border border-surface-200 dark:border-surface-700 bg-background text-foreground shadow-lg">
            <div className="max-h-80 overflow-y-auto p-1">
              {referenceResults.map((item, index) => (
                <button
                  aria-label={`Reference ${item.path}`}
                  className={cn(
                    "flex h-11 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left transition-colors",
                    index === highlightedReferenceIndex
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-surface-100 dark:hover:bg-surface-800 hover:text-foreground",
                  )}
                  key={`${item.kind}:${item.path}`}
                  onClick={() => insertProjectReference(item)}
                  onMouseDown={(event) => event.preventDefault()}
                  type="button"
                >
                  {item.kind === "folder" ? (
                    <MaterialFolderIcon
                      className="size-4 shrink-0"
                      name={item.name}
                    />
                  ) : (
                    <MaterialFileIcon
                      className="size-4 shrink-0"
                      path={item.path}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium text-sm">{item.name}</span>
                    {item.parentPath ? (
                      <span className="ml-2 truncate text-muted-foreground text-sm">
                        {item.parentPath}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <TodoListPanel
          isOpen={isTodoPanelOpen}
          panelId={todoPanelId}
          summary={todoSummary}
        />
        <div className="relative z-10">
          <Sparkles
            cyclePalette={sparklesPalette}
            cycleOnClick={isProcessing}
            density={70}
            disabled={!isProcessing}
            height={30}
            onPaletteChange={onSparklesPaletteChange}
            palette={resolvedSparklesPalette}
            sway={0}
            speed={2}
          >
            <div className="overflow-hidden rounded-lg border border-surface-300 bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))] shadow-md dark:border-surface-700">
              <PromptInput
                clearOnSubmit="immediate"
                id={promptInputDomId}
                className="relative z-10 -mx-px -mt-px w-[calc(100%+2px)] overflow-hidden rounded-lg border border-surface-300 bg-background dark:border-surface-700 [&_[data-slot=input-group]]:h-auto [&_[data-slot=input-group]]:flex-wrap [&_[data-slot=input-group]]:py-1 [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:backdrop-blur-none [&_[data-slot=input-group]]:ring-0 [&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-0"
                onSubmit={handleComposerSubmit}
              >
                <PromptInputBody>
                  <PromptAttachments />
                  <PromptInputTools className="shrink-0 pl-2">
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger tooltip="Attach file" />
                      <PromptInputActionMenuContent>
                        <PromptInputActionAddAttachments />
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                  </PromptInputTools>
                  <div className="relative min-w-0 flex-1">
                    <InlineProjectReferenceMentions
                      references={selectedReferences}
                      text={promptText}
                    />
                    <PromptInputTextarea
                      className={cn(
                        "relative min-h-0 border-none bg-transparent px-3 py-2 shadow-none caret-foreground focus-visible:ring-0",
                        selectedReferences.length > 0 &&
                          "text-transparent placeholder:text-muted-foreground selection:bg-primary-selection",
                      )}
                      disabled={!isActive}
                      onChange={handlePromptChange}
                      onClick={(event) =>
                        updateActiveReferenceToken(
                          event.currentTarget.value,
                          event.currentTarget.selectionStart,
                        )
                      }
                      onKeyDown={handlePromptKeyDown}
                      onSelect={(event) =>
                        updateActiveReferenceToken(
                          event.currentTarget.value,
                          event.currentTarget.selectionStart,
                        )
                      }
                      placeholder={chatT("askAnything")}
                      ref={textareaRef}
                      rows={1}
                      value={promptText}
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-1 pr-2">
                    <TodoListPanelTrigger
                      isOpen={isTodoPanelOpen}
                      onOpenChange={setIsTodoPanelOpen}
                      panelId={todoPanelId}
                      summary={todoSummary}
                    />
                    <ChatComposerSubmitButton
                      isActive={isActive}
                      isProcessing={isProcessing}
                      isProviderInstalled={isProviderInstalled}
                      onStop={onStop}
                      promptText={promptText}
                      selectedModel={selectedModel}
                      selectedReferenceCount={selectedReferences.length}
                      status={status}
                    />
                  </div>
                </PromptInputBody>
              </PromptInput>

              <div className="flex items-center gap-1 px-2 py-1.5">
                <Select
                  onValueChange={(value) =>
                    onAgentModeChange(value as AgentMode)
                  }
                  value={agentMode}
                >
                  <SelectTrigger
                    className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground data-[popup-open]:bg-transparent dark:bg-transparent dark:hover:bg-transparent dark:data-[popup-open]:bg-transparent"
                    title={chatT("agentMode")}
                  >
                    <AgentModeIcon className="size-3.5 shrink-0" />
                    <span className="truncate">{selectedAgentModeLabel}</span>
                  </SelectTrigger>
                  <SelectContent className="text-xs" side="top">
                    <SelectGroup>
                      <SelectLabel>{chatT("mode")}</SelectLabel>
                      {AGENT_MODE_OPTIONS.map((option) => {
                        const OptionIcon = getAgentModeIcon(option.value);

                        return (
                          <SelectItem
                            className="text-xs"
                            key={option.value}
                            value={option.value}
                          >
                            <span className="flex items-center gap-1.5">
                              <OptionIcon className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400" />
                              <span>{chatT(option.value)}</span>
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                <Select
                  onValueChange={(value) => {
                    if (typeof value !== "string") return;
                    const matchingOptions = allModelOptions.filter(
                      (option) => option.id === value,
                    );
                    const nextOption =
                      matchingOptions.find(
                        (option) => option.provider === chatProvider,
                      ) ?? matchingOptions[0];
                    if (!nextOption) return;

                    onModelChange(nextOption);
                  }}
                  value={selectedModelValue}
                >
                  <SelectTrigger
                    className="h-7 w-auto max-w-[260px] gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground data-[popup-open]:bg-transparent dark:bg-transparent dark:hover:bg-transparent dark:data-[popup-open]:bg-transparent"
                    disabled={allModelOptions.length === 0}
                  >
                    <SelectValue placeholder={chatT("model")}>
                      <span className="flex items-center gap-1.5">
                        <ProviderIcon
                          className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400"
                          provider={selectedProvider}
                        />
                        <span className="truncate">{selectedModelLabel}</span>
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    alignItemWithTrigger={false}
                    className="text-xs"
                    side="top"
                  >
                    <SelectGroup>
                      <SelectLabel>{chatT("model")}</SelectLabel>
                      {allModelOptions.map((option) => (
                        <SelectItem
                          className="text-xs"
                          key={`${option.provider}:${option.id}`}
                          value={option.id}
                        >
                          <span className="flex items-center gap-1.5">
                            <ProviderIcon
                              className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400"
                              provider={option.provider}
                            />
                            <span className="truncate">{option.label}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                {reasoningEffortOptions.length > 0 ? (
                  <Select
                    onValueChange={(value) =>
                      onReasoningEffortChange(value as ReasoningEffort)
                    }
                    value={selectedReasoningEffort}
                  >
                    <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground data-[popup-open]:bg-transparent dark:bg-transparent dark:hover:bg-transparent dark:data-[popup-open]:bg-transparent">
                      <span className="truncate">
                        {selectedReasoningEffort
                          ? modelT(selectedReasoningEffort)
                          : selectedReasoningLabel}
                      </span>
                    </SelectTrigger>
                    <SelectContent className="text-xs" side="top">
                      <SelectGroup>
                        <SelectLabel>{settingsT("effort")}</SelectLabel>
                        {reasoningEffortOptions.map((option) => (
                          <SelectItem
                            className="text-xs"
                            key={option.value}
                            value={option.value}
                          >
                            {modelT(option.value)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : null}

                {speedOptions.length > 0 ? (
                  <Select
                    onValueChange={(value) =>
                      onModelSpeedChange(value as ModelSpeed)
                    }
                    value={selectedModelSpeed}
                  >
                    <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground data-[popup-open]:bg-transparent dark:bg-transparent dark:hover:bg-transparent dark:data-[popup-open]:bg-transparent">
                      <span className="truncate">
                        {selectedModelSpeed
                          ? modelT(selectedModelSpeed)
                          : selectedModelSpeedLabel}
                      </span>
                    </SelectTrigger>
                    <SelectContent className="text-xs" side="top">
                      <SelectGroup>
                        <SelectLabel>{settingsT("speed")}</SelectLabel>
                        {speedOptions.map((option) => (
                          <SelectItem
                            className="text-xs"
                            key={option.value}
                            value={option.value}
                          >
                            {modelT(option.value)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : null}

                <div className="ml-auto flex items-center gap-1">
                  <UsageLimitsPopover provider={selectedProvider} />
                  <Context
                    maxTokens={contextWindow}
                    modelId={modelId}
                    usage={contextUsage}
                    usedTokens={contextUsedTokens}
                  >
                    <ContextTrigger
                      className="h-7 gap-1.5 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
                      title={chatT("contextUsage")}
                    />
                    <ContextContent side="top" align="end">
                      <ContextContentHeader />
                      <ContextContentBody className="space-y-1.5">
                        <ContextInputUsage />
                        <ContextOutputUsage />
                        <ContextReasoningUsage />
                        <ContextCacheUsage />
                      </ContextContentBody>
                    </ContextContent>
                  </Context>
                </div>
              </div>
            </div>
          </Sparkles>
        </div>
      </div>
    </div>
  );
};
