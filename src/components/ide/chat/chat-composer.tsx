import type { ChatStatus } from "ai";
import { Shield, XIcon } from "lucide-react";
import {
  type ChangeEventHandler,
  type KeyboardEventHandler,
  useCallback,
  useEffect,
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
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
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
import { cn } from "@/lib/utils";
import type {
  AiProvider,
  ModelSpeed,
  ProjectReference,
  ReasoningEffort,
} from "@/types/ide";
import { BranchSwitcher } from "../branch-switcher";
import { PromptAttachments } from "../chat";
import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  type ClaudePermissionMode,
  CODEX_PERMISSION_MODE_OPTIONS,
  type CodexPermissionMode,
  getClaudePermissionModeLabel,
  getCodexPermissionModeLabel,
} from "../ide-types";
import { MaterialFileIcon, MaterialFolderIcon } from "../material-file-icon";
import { UsageLimitsPopover } from "./usage-limits-popover";

export interface ChatPanelModelOption {
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

export interface ChatComposerProps {
  allModelOptions: ChatPanelModelOption[];
  chatProvider: AiProvider;
  claudePermissionMode: ClaudePermissionMode;
  codexPermissionMode: CodexPermissionMode;
  contextWindow: number;
  estimatedUsedTokens: number;
  isProcessing: boolean;
  isProviderInstalled: boolean;
  modelId: string;
  onClaudePermissionModeChange: (mode: ClaudePermissionMode) => void;
  onCodexPermissionModeChange: (mode: CodexPermissionMode) => void;
  onModelChange: (option: ChatPanelModelOption) => void;
  onModelSpeedChange: (speed: ModelSpeed) => void;
  onPromptKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onPromptTextChange: (value: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onStop: () => void;
  onSubmit: (prompt: PromptInputMessage) => void | Promise<void>;
  promptDomId: string;
  promptInputDomId: string;
  promptText: string;
  projectId: string;
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
  status: ChatStatus;
}

export const ChatComposer = ({
  allModelOptions,
  chatProvider,
  claudePermissionMode,
  codexPermissionMode,
  contextWindow,
  estimatedUsedTokens,
  isProcessing,
  isProviderInstalled,
  modelId,
  onClaudePermissionModeChange,
  onCodexPermissionModeChange,
  onModelChange,
  onModelSpeedChange,
  onPromptKeyDown,
  onPromptTextChange,
  onReasoningEffortChange,
  onStop,
  onSubmit,
  promptDomId,
  promptInputDomId,
  promptText,
  projectId,
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
  status,
}: ChatComposerProps) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [projectReferences, setProjectReferences] = useState<
    ProjectReferenceItem[]
  >([]);
  const [activeReferenceToken, setActiveReferenceToken] =
    useState<ActiveReferenceToken | null>(null);
  const [highlightedReferenceIndex, setHighlightedReferenceIndex] = useState(0);
  const [selectedReferences, setSelectedReferences] = useState<
    ProjectReference[]
  >([]);

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

  const referenceResults = useMemo(
    () =>
      activeReferenceToken
        ? searchProjectReferences(projectReferences, activeReferenceToken.query)
        : [],
    [activeReferenceToken, projectReferences],
  );

  const showReferenceResults =
    activeReferenceToken !== null && referenceResults.length > 0;

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
      const nextValue = `${before}${after}`;
      const nextCaretIndex = before.length;

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

  const removeProjectReference = useCallback((item: ProjectReference) => {
    setSelectedReferences((current) =>
      current.filter(
        (reference) =>
          reference.kind !== item.kind || reference.path !== item.path,
      ),
    );
  }, []);

  const handleComposerSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      await onSubmit({
        ...prompt,
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
        referenceResults,
        showReferenceResults,
      ],
    );

  return (
    <div id={promptDomId} className="shrink-0 px-2 pb-2">
      <div className="mx-auto w-full max-w-[700px]">
        {showReferenceResults ? (
          <div className="mb-2 overflow-hidden rounded-lg border border-foreground/15 bg-background text-foreground shadow-lg">
            <div className="max-h-80 overflow-y-auto p-1">
              {referenceResults.map((item, index) => (
                <button
                  aria-label={`Reference ${item.path}`}
                  className={cn(
                    "flex h-11 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left transition-colors",
                    index === highlightedReferenceIndex
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
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
        <Sparkles
          density={70}
          disabled={!isProcessing}
          height={30}
          sway={0}
          speed={2}
          palette={["#9bf2ff", "#6ac7ff", "#caf8ff", "#5ea3ff"]}
        >
          <div className="overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md">
            <PromptInput
              clearOnSubmit="immediate"
              id={promptInputDomId}
              className="w-full [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:backdrop-blur-none [&_[data-slot=input-group]]:ring-0 [&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-0"
              onSubmit={handleComposerSubmit}
            >
              <PromptInputBody>
                <PromptAttachments />
                {selectedReferences.length > 0 ? (
                  <div className="flex w-full flex-wrap gap-2 px-3 pt-3">
                    {selectedReferences.map((reference) => (
                      <span
                        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 font-medium text-blue-700 text-sm dark:text-blue-300"
                        key={`${reference.kind}:${reference.path}`}
                      >
                        {reference.kind === "folder" ? (
                          <MaterialFolderIcon
                            className="size-4 shrink-0"
                            name={reference.name}
                          />
                        ) : (
                          <MaterialFileIcon
                            className="size-4 shrink-0"
                            path={reference.path}
                          />
                        )}
                        <span className="min-w-0 truncate">
                          {reference.name}
                        </span>
                        <button
                          aria-label={`Remove ${reference.path} reference`}
                          className="-mr-1 rounded-full p-0.5 text-blue-700/70 transition-colors hover:bg-blue-500/15 hover:text-blue-700 dark:text-blue-300/70 dark:hover:text-blue-300"
                          onClick={() => removeProjectReference(reference)}
                          type="button"
                        >
                          <XIcon className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <PromptInputTextarea
                  className="min-h-0 border-none bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
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
                  placeholder="Ask anything..."
                  ref={textareaRef}
                  rows={1}
                  value={promptText}
                />
              </PromptInputBody>
              <PromptInputFooter className="items-center">
                <PromptInputTools>
                  <PromptInputActionMenu>
                    <PromptInputActionMenuTrigger tooltip="Attach file" />
                    <PromptInputActionMenuContent>
                      <PromptInputActionAddAttachments />
                    </PromptInputActionMenuContent>
                  </PromptInputActionMenu>
                </PromptInputTools>
                <div className="ml-auto flex items-center gap-2">
                  <PromptInputSubmit
                    className="size-8 rounded-md"
                    disabled={
                      !isProcessing &&
                      (!isProviderInstalled ||
                        selectedModel === "" ||
                        (promptText.trim() === "" &&
                          selectedReferences.length === 0))
                    }
                    onStop={onStop}
                    status={status}
                  />
                </div>
              </PromptInputFooter>
            </PromptInput>

            <div className="flex items-center gap-1 border-t border-foreground/10 px-2 py-1.5">
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
                  className="h-7 w-auto max-w-[260px] gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
                  disabled={allModelOptions.length === 0}
                >
                  <SelectValue placeholder="Model">
                    <span className="flex items-center gap-1.5">
                      <ProviderIcon
                        className="size-3.5 shrink-0 text-muted-foreground/70"
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
                    <SelectLabel>Model</SelectLabel>
                    {allModelOptions.map((option) => (
                      <SelectItem
                        className="text-xs"
                        key={`${option.provider}:${option.id}`}
                        value={option.id}
                      >
                        <span className="flex items-center gap-1.5">
                          <ProviderIcon
                            className="size-3.5 shrink-0 text-muted-foreground/70"
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
                  <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                    <span className="truncate">{selectedReasoningLabel}</span>
                  </SelectTrigger>
                  <SelectContent className="text-xs" side="top">
                    <SelectGroup>
                      <SelectLabel>Effort</SelectLabel>
                      {reasoningEffortOptions.map((option) => (
                        <SelectItem
                          className="text-xs"
                          key={option.value}
                          value={option.value}
                        >
                          {option.label}
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
                  <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                    <span className="truncate">{selectedModelSpeedLabel}</span>
                  </SelectTrigger>
                  <SelectContent className="text-xs" side="top">
                    <SelectGroup>
                      <SelectLabel>Speed</SelectLabel>
                      {speedOptions.map((option) => (
                        <SelectItem
                          className="text-xs"
                          key={option.value}
                          value={option.value}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : null}

              {selectedProvider === "openai" ? (
                <Select
                  onValueChange={(value) =>
                    onCodexPermissionModeChange(value as CodexPermissionMode)
                  }
                  value={codexPermissionMode}
                >
                  <SelectTrigger className="h-7 w-auto max-w-52 gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                    <Shield className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {getCodexPermissionModeLabel(codexPermissionMode)}
                    </span>
                  </SelectTrigger>
                  <SelectContent className="text-xs" side="top">
                    <SelectGroup>
                      <SelectLabel>Permissions</SelectLabel>
                      {CODEX_PERMISSION_MODE_OPTIONS.map((option) => (
                        <SelectItem
                          className="text-xs"
                          key={option.value}
                          value={option.value}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : selectedProvider === "anthropic" ? (
                <Select
                  onValueChange={(value) =>
                    onClaudePermissionModeChange(value as ClaudePermissionMode)
                  }
                  value={claudePermissionMode}
                >
                  <SelectTrigger className="h-7 w-auto max-w-52 gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                    <Shield className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {getClaudePermissionModeLabel(claudePermissionMode)}
                    </span>
                  </SelectTrigger>
                  <SelectContent className="text-xs" side="top">
                    <SelectGroup>
                      <SelectLabel>Permissions</SelectLabel>
                      {CLAUDE_PERMISSION_MODE_OPTIONS.map((option) => (
                        <SelectItem
                          className="text-xs"
                          key={option.value}
                          value={option.value}
                        >
                          {option.label}
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
                  usedTokens={estimatedUsedTokens}
                >
                  <ContextTrigger className="h-7 gap-1.5 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground" />
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
        <div className="mt-1 flex justify-end">
          <BranchSwitcher projectId={projectId} projectPath={projectPath} />
        </div>
      </div>
    </div>
  );
};
