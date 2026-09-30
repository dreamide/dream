import type { ChatStatus, LanguageModelUsage } from "ai";
import {
  FolderGit2,
  Grid2x2,
  LaptopMinimal,
  Package,
  Settings2,
  Trash2,
  UserRound,
} from "lucide-react";
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
import { PermissionSelector } from "@/components/ide/chat/permission-selector";
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
import { apiClient, isAbortError } from "@/lib/api-client";
import {
  createAccentSparklesPalette,
  type SparklesPaletteName,
} from "@/lib/sparkles-palettes";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type {
  AiProvider,
  ChatPermissionMode,
  ModelSpeed,
  ProjectReference,
  ProviderSkill,
  ReasoningEffort,
} from "@/types/ide";
import { PromptAttachments } from "../chat";
import { MaterialFileIcon, MaterialFolderIcon } from "../material-file-icon";
import { ChatComposerInsertContext } from "./chat-composer-insert-context";
import {
  type ChatModelSelection,
  type ChatPanelModelOption,
  findModelOption,
  getModelSelectionControls,
} from "./chat-model-selection";
import {
  applyComposerEdit,
  buildProjectReferenceIndex,
  type ComposerCatalog,
  type ComposerEdit,
  type ComposerEditResult,
  type ComposerSegment,
  type ComposerState,
  composerNeedsSkillCatalog,
  getSkillLabel,
  handleComposerKey,
  MENTION_ICON_SLOT,
  readComposerDraft,
  serializeComposerDraft,
} from "./composer-draft";
import { providerSupportsSkills } from "./provider-skills";
import type { ChatTodoSummary } from "./todo-list";
import { TodoListPopover } from "./todo-list-popover";
import { UsageLimitsPopover } from "./usage-limits-popover";
import { useProviderSkills } from "./use-provider-skills";

export type { ChatPanelModelOption } from "./chat-model-selection";

const PROJECT_REFERENCE_FILE_LIMIT = 2500;

/** The project's files and folders, for the `@` menu. */
const useProjectReferenceIndex = (projectPath: string) => {
  const [index, setIndex] = useState<ProjectReference[]>([]);

  useEffect(() => {
    const abortController = new AbortController();

    const load = async () => {
      try {
        const payload = await apiClient.projectFiles(
          {
            directory: ".",
            maxResults: PROJECT_REFERENCE_FILE_LIMIT,
            projectPath,
          },
          { signal: abortController.signal },
        );
        setIndex(buildProjectReferenceIndex(payload.files));
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        setIndex([]);
      }
    };

    void load();
    return () => abortController.abort();
  }, [projectPath]);

  return index;
};

const MENTION_CLASS_NAME =
  "text-foreground [-webkit-text-stroke:0.35px_currentColor]";
const MENTION_ICON_CLASS_NAME =
  "absolute left-0.5 top-1/2 size-3.5 -translate-y-1/2";

const MentionIconSlot = ({ children }: { children: ReactNode }) => (
  <span className="relative inline-block text-transparent">
    {MENTION_ICON_SLOT}
    {children}
  </span>
);

const renderSegment = (segment: ComposerSegment) => {
  switch (segment.kind) {
    case "text":
      return (
        <span className="whitespace-pre-wrap" key={`text-${segment.start}`}>
          {segment.text}
        </span>
      );
    case "typed-skill":
      return (
        <span className={MENTION_CLASS_NAME} key={`skill-${segment.start}`}>
          {segment.text}
        </span>
      );
    case "picked-skill":
      return (
        <span
          className={MENTION_CLASS_NAME}
          key={`picked-skill-${segment.start}`}
        >
          <MentionIconSlot>
            <Package
              className={cn(MENTION_ICON_CLASS_NAME, "text-muted-foreground")}
            />
          </MentionIconSlot>
          {segment.label}
        </span>
      );
    case "reference":
      return (
        <span className={MENTION_CLASS_NAME} key={`reference-${segment.start}`}>
          <MentionIconSlot>
            {segment.reference.kind === "folder" ? (
              <MaterialFolderIcon
                className={MENTION_ICON_CLASS_NAME}
                name={segment.reference.name}
              />
            ) : (
              <MaterialFileIcon
                className={MENTION_ICON_CLASS_NAME}
                path={segment.reference.path}
              />
            )}
          </MentionIconSlot>
          {segment.reference.name}
        </span>
      );
  }
};

/** Draws the draft's mentions over the (then transparent) textarea text. */
const ComposerMentionOverlay = ({
  segments,
}: {
  segments: ComposerSegment[];
}) => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm leading-normal"
  >
    {segments.map(renderSegment)}
  </div>
);

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
  /** The chat's saved provider; wins a tie between same-id models. */
  chatProvider: AiProvider;
  className?: string;
  contextWindow: number;
  contextUsage?: LanguageModelUsage;
  contextUsedTokens: number;
  hideUsageAndContext?: boolean;
  isActive: boolean;
  isProcessing: boolean;
  isProviderInstalled: boolean;
  modelId: string;
  /** The model, effort and speed the pickers show, and what they offer. */
  modelSelection: ChatModelSelection;
  onDelete?: () => void;
  onModelChange: (option: ChatPanelModelOption) => void;
  onModelSpeedChange: (speed: ModelSpeed) => void;
  onPermissionModeChange: (mode: ChatPermissionMode) => void;
  /** Keys the draft leaves alone (Enter to send, prompt history). */
  onPromptKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  onPromptTextChange: (value: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onSparklesPaletteChange?: (palette: SparklesPaletteName) => void;
  onStop?: () => void;
  onSubmit: (prompt: PromptInputMessage) => void | Promise<void>;
  promptDomId: string;
  promptInputDomId: string;
  promptText: string;
  permissionMode: ChatPermissionMode;
  projectPath: string;
  sparklesPalette: SparklesPaletteName;
  status: ChatStatus;
  todoSummary: ChatTodoSummary;
  /** Extra items for the + menu, after "Add photos & files". */
  actionMenuItems?: ReactNode;
}

type ComposerLocalState = Pick<ComposerState, "references" | "token">;

const EMPTY_LOCAL_STATE: ComposerLocalState = { references: [], token: null };

const noop = () => {};

export const ChatComposer = ({
  chatProvider,
  className,
  contextWindow,
  contextUsage,
  contextUsedTokens,
  hideUsageAndContext = false,
  isActive,
  isProcessing,
  isProviderInstalled,
  modelId,
  modelSelection,
  onDelete,
  onModelChange,
  onModelSpeedChange,
  onPermissionModeChange,
  onPromptKeyDown,
  onPromptTextChange,
  onReasoningEffortChange,
  onSparklesPaletteChange = noop,
  onStop = noop,
  onSubmit,
  promptDomId,
  promptInputDomId,
  promptText,
  permissionMode,
  projectPath,
  sparklesPalette,
  status,
  todoSummary,
  actionMenuItems,
}: ChatComposerProps) => {
  const chatT = useTranslations("chat");
  const modelT = useTranslations("models");
  const settingsT = useTranslations("settings");
  const skillsT = useTranslations("skills");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Set when a + menu item inserted text, so closing the menu lands the caret
  // at the end of the prompt instead of back on the + button.
  const focusPromptOnActionMenuCloseRef = useRef(false);
  const insertPromptText = useCallback(
    (text: string) => {
      const existing = promptText.trimEnd();
      onPromptTextChange(existing ? [existing, text].join("\n\n") : text);
      focusPromptOnActionMenuCloseRef.current = true;
    },
    [onPromptTextChange, promptText],
  );
  const resolveActionMenuFinalFocus = useCallback(() => {
    if (!focusPromptOnActionMenuCloseRef.current) {
      return true;
    }
    focusPromptOnActionMenuCloseRef.current = false;
    const textarea = textareaRef.current;
    requestAnimationFrame(() => {
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return textarea;
  }, []);
  const todoPanelId = useId();
  const [isTodoPanelOpen, setIsTodoPanelOpen] = useState(false);

  // The draft: the text is the caller's (it is the saved chat draft); the
  // picked files and the token at the caret are held here.
  const [local, setLocal] = useState<ComposerLocalState>(EMPTY_LOCAL_STATE);
  const draft = useMemo<ComposerState>(
    () => ({ ...local, text: promptText }),
    [local, promptText],
  );

  const { selectedProvider } = modelSelection;
  const skillsSupported = providerSupportsSkills(selectedProvider);
  const { skills } = useProviderSkills({
    enabled: composerNeedsSkillCatalog(draft, skillsSupported),
    projectPath,
    provider: selectedProvider,
  });
  const projectReferences = useProjectReferenceIndex(projectPath);
  const catalog = useMemo<ComposerCatalog>(
    () => ({ projectReferences, skills, skillsSupported }),
    [projectReferences, skills, skillsSupported],
  );
  const view = useMemo(
    () => readComposerDraft(draft, catalog),
    [catalog, draft],
  );
  const { menu } = view;

  const accentColor = useUiStore((s) => s.accentColor);
  const accentSparklesPalette = useMemo(
    () => createAccentSparklesPalette(accentColor),
    [accentColor],
  );
  const resolvedSparklesPalette =
    sparklesPalette === "accent" ? accentSparklesPalette : sparklesPalette;

  // Sent or cleared from outside: nothing is picked any more.
  useEffect(() => {
    if (promptText === "") {
      setLocal(EMPTY_LOCAL_STATE);
    }
  }, [promptText]);

  useEffect(() => {
    if (todoSummary.totalCount === 0) {
      setIsTodoPanelOpen(false);
    }
  }, [todoSummary.totalCount]);

  const commit = useCallback(
    ({ caret, state }: ComposerEditResult) => {
      if (state.text !== promptText) {
        onPromptTextChange(state.text);
      }
      setLocal((current) =>
        current.references === state.references && current.token === state.token
          ? current
          : { references: state.references, token: state.token },
      );
      if (caret !== undefined) {
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(caret, caret);
        });
      }
    },
    [onPromptTextChange, promptText],
  );

  const edit = useCallback(
    (composerEdit: ComposerEdit) =>
      commit(applyComposerEdit(draft, composerEdit, catalog)),
    [catalog, commit, draft],
  );

  const handlePromptChange: ChangeEventHandler<HTMLTextAreaElement> =
    useCallback(
      (event) =>
        edit({
          caret: event.currentTarget.selectionStart,
          text: event.currentTarget.value,
          type: "input",
        }),
      [edit],
    );

  // Reads the textarea's own value: a select event can arrive before the
  // parent's new text has rendered.
  const handleCaretMove = useCallback(
    ({ currentTarget }: { currentTarget: HTMLTextAreaElement }) =>
      edit(
        currentTarget.value === draft.text
          ? { caret: currentTarget.selectionStart, type: "caret" }
          : {
              caret: currentTarget.selectionStart,
              text: currentTarget.value,
              type: "input",
            },
      ),
    [draft.text, edit],
  );

  const handlePromptKeyDown: KeyboardEventHandler<HTMLTextAreaElement> =
    useCallback(
      (event) => {
        const result = handleComposerKey(
          draft,
          {
            key: event.key,
            selectionEnd: event.currentTarget.selectionEnd,
            selectionStart: event.currentTarget.selectionStart,
          },
          catalog,
        );
        if (result) {
          event.preventDefault();
          commit(result);
          return;
        }
        onPromptKeyDown?.(event);
      },
      [catalog, commit, draft, onPromptKeyDown],
    );

  const handleComposerSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      const sent = serializeComposerDraft(
        { references: draft.references, text: prompt.text },
        skills,
        { skillsSupported },
      );
      await onSubmit({ ...prompt, ...sent });
      edit({ type: "submitted" });
    },
    [draft.references, edit, onSubmit, skills, skillsSupported],
  );

  const controls = getModelSelectionControls(modelSelection);
  const { allModelOptions } = modelSelection;

  const getSkillBadge = (skill: ProviderSkill) => {
    if (skill.kind === "command") {
      return { icon: Package, label: skillsT("badgeCommand") };
    }
    switch (skill.scope) {
      case "project":
        return { icon: FolderGit2, label: skillsT("scopeProject") };
      case "system":
        return { icon: LaptopMinimal, label: skillsT("scopeSystem") };
      case "plugin":
        return { icon: Grid2x2, label: skillsT("scopePlugin") };
      case "admin":
        return { icon: Settings2, label: skillsT("scopeAdmin") };
      default:
        return { icon: UserRound, label: skillsT("scopeUser") };
    }
  };

  return (
    <div id={promptDomId} className={cn("shrink-0 px-2 pb-2", className)}>
      <div className="@container/chat-composer mx-auto w-full max-w-[700px]">
        {menu?.kind === "reference" ? (
          <div className="mb-2 overflow-hidden rounded-lg border border-surface-200 dark:border-surface-700 bg-background text-foreground shadow-lg">
            <div className="max-h-80 overflow-y-auto p-1">
              {menu.items.map((item, index) => (
                <button
                  aria-label={`Reference ${item.path}`}
                  className={cn(
                    "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left",
                    index === menu.highlighted
                      ? "bg-surface-100 text-foreground dark:bg-surface-900"
                      : "text-muted-foreground",
                  )}
                  key={`${item.kind}:${item.path}`}
                  onClick={() =>
                    edit({ reference: item, type: "pick-reference" })
                  }
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => edit({ index, type: "highlight" })}
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
                  <span className="min-w-0 flex-1 truncate text-xs">
                    <span className="font-medium text-foreground">
                      {item.name}
                    </span>
                    {item.parentPath ? (
                      <span className="ml-2 truncate text-muted-foreground">
                        {item.parentPath}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {menu?.kind === "skill" ? (
          <div className="mb-2 overflow-hidden rounded-lg border border-surface-200 dark:border-surface-700 bg-background text-foreground shadow-lg">
            <div className="max-h-80 overflow-y-auto p-1">
              {menu.items.map((skill, index) => {
                const badge = getSkillBadge(skill);
                const BadgeIcon = badge.icon;
                const description = skill.shortDescription || skill.description;
                return (
                  <button
                    aria-label={`Skill ${skill.name}`}
                    className={cn(
                      "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left",
                      index === menu.highlighted
                        ? "bg-surface-100 text-foreground dark:bg-surface-900"
                        : "text-muted-foreground",
                    )}
                    key={`${skill.source}:${skill.path || skill.name}`}
                    onClick={() => edit({ skill, type: "pick-skill" })}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => edit({ index, type: "highlight" })}
                    title={skill.path || undefined}
                    type="button"
                  >
                    <BadgeIcon
                      aria-label={badge.label}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    >
                      <title>{badge.label}</title>
                    </BadgeIcon>
                    <span className="min-w-0 flex-1 truncate text-xs">
                      <span className="font-semibold text-foreground">
                        {getSkillLabel(skill)}
                      </span>
                      {description ? (
                        <span className="ml-2 text-muted-foreground">
                          {description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
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
            <div className="overflow-hidden rounded-lg border border-surface-300 bg-surface-50 shadow-md dark:border-surface-700 dark:bg-surface-900">
              <PromptInput
                clearOnSubmit="immediate"
                id={promptInputDomId}
                className="relative z-10 -mx-px -mt-px w-[calc(100%+2px)] overflow-hidden rounded-lg border border-surface-300 bg-background dark:border-surface-700 [&_[data-slot=input-group]]:h-auto [&_[data-slot=input-group]]:flex-wrap [&_[data-slot=input-group]]:py-1.5 [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:backdrop-blur-none [&_[data-slot=input-group]]:ring-0 [&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-0"
                onSubmit={handleComposerSubmit}
              >
                <PromptInputBody>
                  <PromptAttachments />
                  <PromptInputTools className="shrink-0 pl-2">
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger
                        className="text-muted-foreground hover:text-foreground"
                        tooltip={chatT("attachFile")}
                      />
                      <PromptInputActionMenuContent
                        finalFocus={resolveActionMenuFinalFocus}
                        side="top"
                      >
                        <PromptInputActionAddAttachments />
                        <ChatComposerInsertContext value={insertPromptText}>
                          {actionMenuItems}
                        </ChatComposerInsertContext>
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                  </PromptInputTools>
                  <div className="relative min-w-0 flex-1">
                    {view.hasMentions ? (
                      <ComposerMentionOverlay segments={view.segments} />
                    ) : null}
                    <PromptInputTextarea
                      className={cn(
                        "relative min-h-0 border-none bg-transparent px-3 py-2 shadow-none caret-foreground focus-visible:ring-0 selection:bg-foreground/20 selection:text-foreground",
                        view.hasMentions &&
                          "text-transparent placeholder:text-muted-foreground selection:text-transparent",
                      )}
                      disabled={!isActive}
                      onChange={handlePromptChange}
                      onClick={handleCaretMove}
                      onKeyDown={handlePromptKeyDown}
                      onSelect={handleCaretMove}
                      placeholder={chatT("askAnything")}
                      ref={textareaRef}
                      rows={1}
                      value={promptText}
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-1 pr-2">
                    <TodoListPopover
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
                      selectedModel={modelSelection.selectedModel}
                      selectedReferenceCount={draft.references.length}
                      status={status}
                    />
                  </div>
                </PromptInputBody>
              </PromptInput>

              <div className="flex items-center px-2 py-1.5">
                <Select
                  onValueChange={(value) => {
                    if (typeof value !== "string") return;
                    const nextOption = findModelOption(
                      allModelOptions,
                      value,
                      chatProvider,
                    );
                    if (nextOption) {
                      onModelChange(nextOption);
                    }
                  }}
                  value={controls.modelValue}
                >
                  <SelectTrigger
                    className="h-7 w-auto max-w-[260px] gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground data-[popup-open]:bg-transparent dark:bg-transparent dark:hover:bg-surface-900 dark:data-[popup-open]:bg-transparent"
                    disabled={allModelOptions.length === 0}
                    showChevron={false}
                  >
                    <SelectValue placeholder={chatT("model")}>
                      <span className="flex items-center gap-1.5">
                        <ProviderIcon
                          className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400"
                          provider={selectedProvider}
                        />
                        <span className="truncate">{controls.modelLabel}</span>
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

                {controls.reasoningEfforts.length > 0 ? (
                  <Select
                    onValueChange={(value) =>
                      onReasoningEffortChange(value as ReasoningEffort)
                    }
                    value={controls.reasoningEffort}
                  >
                    <SelectTrigger
                      className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground data-[popup-open]:bg-transparent dark:bg-transparent dark:hover:bg-surface-900 dark:data-[popup-open]:bg-transparent"
                      showChevron={false}
                    >
                      <span className="truncate">
                        {modelT(controls.reasoningEffort)}
                      </span>
                    </SelectTrigger>
                    <SelectContent className="text-xs" side="top">
                      <SelectGroup>
                        <SelectLabel>{settingsT("effort")}</SelectLabel>
                        {controls.reasoningEfforts.map((value) => (
                          <SelectItem
                            className="text-xs"
                            key={value}
                            value={value}
                          >
                            {modelT(value)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : null}

                {controls.speeds.length > 0 ? (
                  <Select
                    onValueChange={(value) =>
                      onModelSpeedChange(value as ModelSpeed)
                    }
                    value={modelSelection.selectedModelSpeed}
                  >
                    <SelectTrigger
                      className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground data-[popup-open]:bg-transparent dark:bg-transparent dark:hover:bg-surface-900 dark:data-[popup-open]:bg-transparent"
                      showChevron={false}
                    >
                      <span className="truncate">
                        {modelT(modelSelection.selectedModelSpeed)}
                      </span>
                    </SelectTrigger>
                    <SelectContent className="text-xs" side="top">
                      <SelectGroup>
                        <SelectLabel>{settingsT("speed")}</SelectLabel>
                        {controls.speeds.map((value) => (
                          <SelectItem
                            className="text-xs"
                            key={value}
                            value={value}
                          >
                            {modelT(value)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : null}

                <PermissionSelector
                  value={permissionMode}
                  onChange={onPermissionModeChange}
                />

                {hideUsageAndContext ? (
                  onDelete ? (
                    <div className="ml-auto flex items-center">
                      <button
                        aria-label={chatT("deleteStashItem")}
                        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                        onClick={onDelete}
                        title={chatT("deleteStashItem")}
                        type="button"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ) : null
                ) : (
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
                )}
              </div>
            </div>
          </Sparkles>
        </div>
      </div>
    </div>
  );
};
