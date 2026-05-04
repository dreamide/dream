import { useChat } from "@ai-sdk/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  AlertCircle,
  Ellipsis,
  FilePenLine,
  GaugeIcon,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type StickToBottomContext,
  useStickToBottomContext,
} from "use-stick-to-bottom";
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
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Sparkles from "@/components/ui/sparkles";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import {
  getConnectedProviders,
  getModelOptionsForProvider,
} from "@/lib/ide-defaults";
import {
  estimateTokenCount,
  getModelContextWindow,
  getModelReasoningEfforts,
} from "@/lib/models";
import type { ChatConfig, ProjectConfig, ReasoningEffort } from "@/types/ide";
import { getChipToolKind } from "./assistant-message-tools";
import { BranchSwitcher } from "./branch-switcher";
import {
  addMetadataToMessage,
  CHAT_CONTENT_BOTTOM_PADDING_PX,
  CHAT_STREAM_UPDATE_THROTTLE_MS,
  ChatMessage,
  type ChatMessageMetadata,
  ConversationScrollMemory,
  inferChatTitle,
  PROVIDER_LABELS,
  PromptAttachments,
  type RenameTarget,
  scrollElementToChatBottom,
  type ToolApprovalResponder,
} from "./chat";
import { mergeChatMessageHistories } from "./chat-message-history";
import {
  getCommitChanges,
  warmProjectCommitMessageForStatus,
} from "./git-commit-message-cache";
import { useIdeStore } from "./ide-store";
import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  type ClaudePermissionMode,
  CODEX_PERMISSION_MODE_OPTIONS,
  type CodexPermissionMode,
  getClaudePermissionModeLabel,
  getCodexPermissionModeLabel,
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "./ide-types";

const EMPTY_MESSAGES: UIMessage[] = [];
const USAGE_LIMIT_PERCENT_MAX = 100;

type UsageLimitWindow = {
  label: string;
  resetAfterSeconds?: number | null;
  resetAt?: string | null;
  usedPercent: number;
};

type UsageLimitsResponse = {
  error?: string | null;
  fetchedAt?: string;
  limits?: UsageLimitWindow[];
  provider?: ChatConfig["provider"];
  source?: string;
  status?: "ok" | "unavailable";
};

type UsageLimitsState = {
  data: UsageLimitsResponse | null;
  error: string | null;
  loading: boolean;
};

const formatResetDuration = (resetAfterMs: number) => {
  const totalMinutes = Math.max(0, Math.ceil(resetAfterMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    if (hours === 0) {
      return `${days}d`;
    }

    return `${days}d ${hours}h`;
  }

  if (hours === 0) {
    return `${minutes}m`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
};

const formatResetAt = (resetAt: Date) =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(resetAt);

const getUsageLimitResetAfterMs = (limit: UsageLimitWindow, now: number) => {
  if (limit.resetAt) {
    const resetAtMs = Date.parse(limit.resetAt);
    if (!Number.isNaN(resetAtMs)) {
      return Math.max(0, resetAtMs - now);
    }
  }

  if (
    typeof limit.resetAfterSeconds === "number" &&
    Number.isFinite(limit.resetAfterSeconds)
  ) {
    return Math.max(0, limit.resetAfterSeconds * 1000);
  }

  return null;
};

const UsageLimitRow = ({
  now,
  limit,
}: {
  now: number;
  limit: UsageLimitWindow;
}) => {
  const usedPercent = Math.max(
    0,
    Math.min(USAGE_LIMIT_PERCENT_MAX, limit.usedPercent),
  );
  const resetAfterMs = getUsageLimitResetAfterMs(limit, now);
  const resetAt =
    limit.resetAt && !Number.isNaN(Date.parse(limit.resetAt))
      ? new Date(limit.resetAt)
      : resetAfterMs === null
        ? null
        : new Date(now + resetAfterMs);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-4 text-xs">
        <span>{limit.label}</span>
        <span>{usedPercent}% used</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-black dark:bg-white"
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-4 text-[11px] text-muted-foreground">
        {resetAfterMs === null || resetAt === null ? (
          <span>Reset time unavailable</span>
        ) : (
          <>
            <span>Resets in {formatResetDuration(resetAfterMs)}</span>
            <span>{formatResetAt(resetAt)}</span>
          </>
        )}
      </div>
    </div>
  );
};

const UsageLimitsPopover = ({
  provider,
}: {
  provider: ChatConfig["provider"];
}) => {
  const [open, setOpen] = useState(false);
  const [usageLimits, setUsageLimits] = useState<UsageLimitsState>({
    data: null,
    error: null,
    loading: false,
  });
  const now = Date.now();
  const limits = usageLimits.data?.limits ?? [];

  const fetchUsageLimits = useCallback(async () => {
    setUsageLimits((current) => ({
      ...current,
      error: null,
      loading: true,
    }));

    try {
      const response = await fetch("/api/provider-usage-limits", {
        body: JSON.stringify({ provider }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Usage limits request failed (${response.status}).`);
      }

      const data = (await response.json()) as UsageLimitsResponse;
      setUsageLimits({
        data,
        error: data.status === "unavailable" ? (data.error ?? null) : null,
        loading: false,
      });
    } catch (error) {
      setUsageLimits((current) => ({
        ...current,
        error:
          error instanceof Error
            ? error.message
            : "Unable to fetch usage limits.",
        loading: false,
      }));
    }
  }, [provider]);

  useEffect(() => {
    if (!open) {
      return;
    }

    void fetchUsageLimits();
    const intervalId = window.setInterval(fetchUsageLimits, 60_000);
    return () => window.clearInterval(intervalId);
  }, [fetchUsageLimits, open]);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={`${PROVIDER_LABELS[provider]} usage limits`}
            className="h-7 border-none bg-transparent px-2 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
            type="button"
            variant="ghost"
          />
        }
      >
        <GaugeIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 gap-4 rounded-lg bg-popover p-3"
        side="top"
      >
        <div className="space-y-4">
          {usageLimits.loading && !usageLimits.data ? (
            <p className="text-xs text-muted-foreground">
              Loading usage limits...
            </p>
          ) : limits.length > 0 ? (
            limits.map((limit) => (
              <UsageLimitRow key={limit.label} limit={limit} now={now} />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">
              {usageLimits.error ?? "Usage limits are unavailable."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

const CHAT_MESSAGE_ESTIMATED_HEIGHT_PX = 180;
const CHAT_MESSAGE_VIRTUAL_OVERSCAN = 8;

const VirtualizedChatMessages = ({
  addToolApprovalResponse,
  expandToolCalls,
  groupToolCalls,
  isStreaming,
  messages,
  projectPath,
  showReasoningSummaries,
}: {
  addToolApprovalResponse: ToolApprovalResponder;
  expandToolCalls: boolean;
  groupToolCalls: boolean;
  isStreaming: boolean;
  messages: UIMessage[];
  projectPath: string;
  showReasoningSummaries: boolean;
}) => {
  const conversationContext = useStickToBottomContext();
  const rowVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: messages.length,
    estimateSize: () => CHAT_MESSAGE_ESTIMATED_HEIGHT_PX,
    getItemKey: (index) => messages[index]?.id ?? index,
    getScrollElement: () => conversationContext.scrollRef.current,
    overscan: CHAT_MESSAGE_VIRTUAL_OVERSCAN,
    useAnimationFrameWithResizeObserver: true,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div
      className="relative w-full"
      style={{ height: rowVirtualizer.getTotalSize() }}
    >
      {virtualItems.map((virtualItem) => {
        const message = messages[virtualItem.index];
        if (!message) {
          return null;
        }

        return (
          <div
            className="absolute left-0 top-0 w-full pb-4"
            data-index={virtualItem.index}
            key={virtualItem.key}
            ref={rowVirtualizer.measureElement}
            style={{ transform: `translateY(${virtualItem.start}px)` }}
          >
            <ChatMessage
              addToolApprovalResponse={addToolApprovalResponse}
              expandToolCalls={expandToolCalls}
              groupToolCalls={groupToolCalls}
              isLastMessage={virtualItem.index === messages.length - 1}
              isStreaming={isStreaming}
              message={message}
              projectPath={projectPath}
              showReasoningSummaries={showReasoningSummaries}
            />
          </div>
        );
      })}
    </div>
  );
};

export const ChatPanel = ({
  isActive,
  project,
  chat,
}: {
  isActive: boolean;
  project: ProjectConfig;
  chat: ChatConfig;
}) => {
  const panelDomId = `chat-panel-${chat.id}`;
  const conversationDomId = `chat-conversation-${chat.id}`;
  const conversationContentDomId = `chat-conversation-content-${chat.id}`;
  const promptDomId = `chat-prompt-${chat.id}`;
  const promptInputDomId = `chat-prompt-input-${chat.id}`;
  const settings = useIdeStore((s) => s.settings);
  const chatMessages = useIdeStore(
    (s) => s.messagesByChatId[chat.id] ?? EMPTY_MESSAGES,
  );
  const isDraftChat = useIdeStore(
    (s) => s.draftChatIdByProject[project.id] === chat.id,
  );
  const providerModels = useIdeStore((s) => s.providerModels);
  const claudePermissionMode = useIdeStore((s) => s.claudePermissionMode);
  const setClaudePermissionMode = useIdeStore((s) => s.setClaudePermissionMode);
  const codexPermissionMode = useIdeStore((s) => s.codexPermissionMode);
  const setCodexPermissionMode = useIdeStore((s) => s.setCodexPermissionMode);
  const setMessagesForChat = useIdeStore((s) => s.setMessagesForChat);
  const updateChat = useIdeStore((s) => s.updateChat);
  const deleteChat = useIdeStore((s) => s.deleteChat);
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const bumpProjectFilesRefreshKey = useIdeStore(
    (s) => s.bumpProjectFilesRefreshKey,
  );
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[project.id] ?? 0,
  );
  const { status: projectGitStatus } = useProjectGitStatus(
    project.path,
    gitRefreshKey,
  );
  const connectedProviders = getConnectedProviders(settings);
  const allModelOptions = useMemo(() => {
    return connectedProviders.flatMap((provider) =>
      getModelOptionsForProvider(
        provider,
        settings,
        providerModels[provider].models,
      ).map((model) => ({
        id: model.id,
        label: model.label,
        provider,
        reasoningEfforts: model.reasoningEfforts,
      })),
    );
  }, [connectedProviders, providerModels, settings]);

  const selectedModelOption =
    allModelOptions.find(
      (option) => option.provider === chat.provider && option.id === chat.model,
    ) ?? allModelOptions[0];
  const selectedProvider = selectedModelOption?.provider ?? chat.provider;
  const isProviderInstalled =
    providerModels[selectedProvider]?.installed ?? false;
  const [localError, setLocalError] = useState<string | null>(null);
  const [promptText, setPromptText] = useState("");
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const refreshedWriteEventsRef = useRef(new Set<string>());
  const pendingCommitMessageWarmRefreshTokensRef = useRef(new Set<number>());
  const warmedCommitMessageKeysRef = useRef(new Set<string>());
  const pendingAssistantMetadataRef = useRef<ChatMessageMetadata | null>(null);
  const conversationContextRef = useRef<StickToBottomContext | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const messagesRef = useRef(chatMessages);

  // State for up/down arrow history cycling (derived from messages)
  const historyIndexRef = useRef(-1);
  const savedDraftRef = useRef("");

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    addToolApprovalResponse: addAiSdkToolApprovalResponse,
    clearError,
  } = useChat({
    experimental_throttle: CHAT_STREAM_UPDATE_THROTTLE_MS,
    id: `chat:${chat.id}`,
    messages: chatMessages,
    onError: (error) => {
      console.error("[chat error]", error);

      // The server-side onError already enriches the message, so
      // error.message should be descriptive. Guard against edge cases
      // where only the generic class name "Error" comes through.
      const msg = error.message;
      if (msg && msg !== "Error") {
        setLocalError(msg);
        return;
      }

      // Fallback: try cause chain
      if (error.cause instanceof Error && error.cause.message) {
        setLocalError(error.cause.message);
        return;
      }

      setLocalError(
        "An unexpected error occurred. Check the developer console for details.",
      );
    },
    onFinish: ({ message }) => {
      const metadata = message.metadata as ChatMessageMetadata | undefined;
      const pendingMetadata = pendingAssistantMetadataRef.current;
      pendingAssistantMetadataRef.current = null;

      if (pendingMetadata) {
        setMessages((currentMessages) =>
          addMetadataToMessage(currentMessages, message.id, {
            ...pendingMetadata,
            createdAt:
              typeof metadata?.createdAt === "string" && metadata.createdAt
                ? metadata.createdAt
                : new Date().toISOString(),
          }),
        );
      }

      const remoteConversationId = metadata?.remoteConversationId?.trim();

      if (!remoteConversationId) {
        return;
      }

      updateChat(chat.id, (current) => ({
        ...current,
        remoteConversationId,
        remoteConversationModel:
          metadata?.remoteConversationModel ?? current.model,
        remoteConversationProjectPath:
          metadata?.remoteConversationProjectPath ?? project.path,
      }));
    },
    transport,
  });

  const addToolApprovalResponse = useCallback<ToolApprovalResponder>(
    (response) => {
      void Promise.resolve(
        addAiSdkToolApprovalResponse({
          approved: response.approved,
          id: response.id,
          reason: response.reason,
        }),
      ).catch((error: unknown) => {
        console.debug("[tool approval ai-sdk response]", error);
      });

      void fetch("/api/tool-approval-response", {
        body: JSON.stringify({
          approved: response.approved,
          id: response.id,
          reason: response.reason ?? null,
          scope: response.scope ?? "once",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch((error) => {
        console.error("[tool approval response]", error);
      });
    },
    [addAiSdkToolApprovalResponse],
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const mergedMessages = mergeChatMessageHistories(chatMessages, messages);
    if (mergedMessages !== messages) {
      setMessages(mergedMessages);
    }
  }, [chatMessages, messages, setMessages]);

  useEffect(() => {
    setMessagesForChat(chat.id, messages);
  }, [chat.id, messages, setMessagesForChat]);

  useEffect(() => {
    return () => {
      const latestMessages = messagesRef.current;
      if (latestMessages.length > 0) {
        setMessagesForChat(chat.id, latestMessages);
      }
    };
  }, [chat.id, setMessagesForChat]);

  // Refresh project panels when completed write tools appear.
  useEffect(() => {
    let shouldRefreshProjectPanels = false;

    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }

      for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
        const part = message.parts[partIndex];
        if (getChipToolKind(part) !== "write") {
          continue;
        }

        const partRecord = part as Record<string, unknown>;
        if (partRecord.state !== "output-available") {
          continue;
        }

        const writeRefreshKey = `${chat.id}:${message.id}:${partIndex}`;
        if (!refreshedWriteEventsRef.current.has(writeRefreshKey)) {
          refreshedWriteEventsRef.current.add(writeRefreshKey);
          shouldRefreshProjectPanels = true;
        }
      }
    }

    if (shouldRefreshProjectPanels) {
      const nextGitRefreshKey =
        (useIdeStore.getState().projectGitRefreshKeys[project.id] ?? 0) + 1;
      pendingCommitMessageWarmRefreshTokensRef.current.add(nextGitRefreshKey);
      bumpProjectGitRefreshKey(project.id);
      bumpProjectFilesRefreshKey(project.id);
    }
  }, [
    bumpProjectFilesRefreshKey,
    bumpProjectGitRefreshKey,
    chat.id,
    messages,
    project.id,
  ]);

  useEffect(() => {
    if (!projectGitStatus) {
      return;
    }

    if (!pendingCommitMessageWarmRefreshTokensRef.current.has(gitRefreshKey)) {
      return;
    }

    pendingCommitMessageWarmRefreshTokensRef.current.delete(gitRefreshKey);
    const changes = getCommitChanges(projectGitStatus, true);
    if (changes.length === 0) {
      return;
    }

    const warmKey = JSON.stringify({
      changes: changes.map((change) => ({
        addedLines: change.addedLines,
        path: change.path,
        removedLines: change.removedLines,
        staged: change.staged,
        unstaged: change.unstaged,
      })),
      projectPath: project.path,
      provider: project.provider,
      refreshToken: gitRefreshKey,
    });
    if (warmedCommitMessageKeysRef.current.has(warmKey)) {
      return;
    }

    warmedCommitMessageKeysRef.current.add(warmKey);
    void warmProjectCommitMessageForStatus({
      projectPath: project.path,
      provider: project.provider,
      refreshToken: gitRefreshKey,
      status: projectGitStatus,
    });
  }, [gitRefreshKey, project.path, project.provider, projectGitStatus]);

  // Auto-approve Anthropic writeFile tool calls for non-interactive modes.
  useEffect(() => {
    if (
      claudePermissionMode !== "accept-edits" &&
      claudePermissionMode !== "bypass-permissions"
    ) {
      return;
    }
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (
          typeof part.type === "string" &&
          part.type === "tool-writeFile" &&
          "approval" in part &&
          part.approval &&
          typeof part.approval === "object" &&
          "id" in part.approval &&
          !("approved" in part.approval) &&
          "state" in part &&
          part.state === "approval-requested"
        ) {
          addToolApprovalResponse({
            id: part.approval.id as string,
            approved: true,
          });
        }
      }
    }
  }, [messages, claudePermissionMode, addToolApprovalResponse]);

  const selectedModel = selectedModelOption?.id ?? "";
  const selectedModelLabel = selectedModelOption?.label ?? selectedModel;
  const selectedModelValue = selectedModelOption?.id;
  const availableReasoningEfforts = selectedModelOption?.reasoningEfforts
    ?.length
    ? selectedModelOption.reasoningEfforts
    : getModelReasoningEfforts(selectedProvider, selectedModel);
  const reasoningEffortOptions = REASONING_EFFORT_OPTIONS.filter((option) =>
    availableReasoningEfforts.includes(option.value),
  );
  const normalizedChatReasoningEffort = normalizeReasoningEffort(
    chat.reasoningEffort,
  );
  const selectedReasoningEffort =
    availableReasoningEfforts.length === 0
      ? normalizedChatReasoningEffort
      : availableReasoningEfforts.includes(normalizedChatReasoningEffort)
        ? normalizedChatReasoningEffort
        : availableReasoningEfforts.includes("medium")
          ? "medium"
          : availableReasoningEfforts[0];
  const selectedReasoningLabel =
    reasoningEffortOptions.find(
      (option) => option.value === selectedReasoningEffort,
    )?.label ??
    REASONING_EFFORT_OPTIONS.find(
      (option) => option.value === selectedReasoningEffort,
    )?.label ??
    "Reasoning";

  const contextWindow = getModelContextWindow(selectedModel);
  const estimatedUsedTokens = useMemo(() => {
    let total = 0;
    for (const message of messages) {
      for (const part of message.parts as Record<string, unknown>[]) {
        if (part.type === "text" && typeof part.text === "string") {
          total += estimateTokenCount(part.text);
        } else if (part.type === "reasoning" && typeof part.text === "string") {
          total += estimateTokenCount(part.text);
        } else if (
          typeof part.type === "string" &&
          (part.type.startsWith("tool-") || part.type === "dynamic-tool")
        ) {
          if (part.input) {
            total += estimateTokenCount(JSON.stringify(part.input));
          }
          if (part.output) {
            total += estimateTokenCount(JSON.stringify(part.output));
          }
        }
      }
    }
    return total;
  }, [messages]);

  const modelId =
    selectedProvider === "anthropic"
      ? `anthropic:${selectedModel}`
      : `openai:${selectedModel}`;

  const scheduleConversationScroll = useCallback(
    (mode: "force" | "locked") => {
      if (!isActive || scrollFrameRef.current !== null) {
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        const conversationContext = conversationContextRef.current;
        const element = conversationContext?.scrollRef.current;
        if (!conversationContext || !element) {
          return;
        }
        if (mode === "locked" && conversationContext.escapedFromLock) {
          return;
        }

        scrollElementToChatBottom(element);
        void conversationContext.scrollToBottom({
          animation: "instant",
          ignoreEscapes: true,
        });
      });
    },
    [isActive],
  );

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, []);

  const scrollConversationToBottom = useCallback(() => {
    if (!isActive) {
      return;
    }

    scheduleConversationScroll("force");
  }, [isActive, scheduleConversationScroll]);

  const scrollConversationToBottomIfLocked = useCallback(() => {
    if (!isActive) {
      return;
    }

    scheduleConversationScroll("locked");
  }, [isActive, scheduleConversationScroll]);

  const handlePromptKeyDown = useCallback<
    KeyboardEventHandler<HTMLTextAreaElement>
  >(
    (e) => {
      // Derive history from the existing chat messages
      const history = messages
        .filter((m) => m.role === "user")
        .map((m) =>
          m.parts
            .filter(
              (p): p is Extract<typeof p, { type: "text" }> =>
                p.type === "text",
            )
            .map((p) => p.text.trim())
            .join("\n\n"),
        )
        .filter((text) => text.length > 0);

      if (e.key === "ArrowUp") {
        const textarea = e.currentTarget;
        // Only check cursor position when NOT already browsing history
        if (historyIndexRef.current === -1) {
          if (textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) {
            return;
          }
        }
        if (history.length === 0) {
          return;
        }

        e.preventDefault();

        if (historyIndexRef.current === -1) {
          // Save current input before browsing history
          savedDraftRef.current = promptText;
          historyIndexRef.current = history.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
        } else {
          return; // Already at oldest entry
        }

        setPromptText(history[historyIndexRef.current]);
      }

      if (e.key === "ArrowDown") {
        if (historyIndexRef.current === -1) {
          return; // Not browsing history
        }

        e.preventDefault();

        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current += 1;
          setPromptText(history[historyIndexRef.current]);
        } else {
          // Past the end of history, restore saved draft
          historyIndexRef.current = -1;
          setPromptText(savedDraftRef.current);
        }
      }
    },
    [promptText, messages],
  );

  const isStreaming = status === "streaming";
  const isProcessing = status === "submitted" || status === "streaming";

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      if (isProcessing) {
        throw new Error("Chat response is already streaming.");
      }

      setLocalError(null);
      clearError();

      const activeOption =
        allModelOptions.find(
          (option) =>
            option.provider === chat.provider && option.id === chat.model,
        ) ?? allModelOptions[0];
      const activeProvider = activeOption?.provider ?? selectedProvider;
      const activeModel = activeOption?.id ?? "";
      const activeProviderInstalled =
        providerModels[activeProvider]?.installed ?? false;

      if (!activeProviderInstalled) {
        setLocalError(
          `${PROVIDER_LABELS[activeProvider]} CLI is not available. Check Settings > Providers.`,
        );
        return;
      }

      if (!activeModel) {
        setLocalError("Enable at least one model in Settings first.");
        return;
      }

      if (!prompt.text.trim() && prompt.files.length === 0) {
        return;
      }

      if (chatMessages.length === 0) {
        updateChat(chat.id, (current) => ({
          ...current,
          title: inferChatTitle(prompt.text),
        }));
      }

      const submittedChatId = chat.id;
      pendingAssistantMetadataRef.current = {
        model: activeModel,
        modelLabel: activeOption?.label ?? activeModel,
        reasoningEffort: selectedReasoningEffort,
        reasoningLabel: selectedReasoningLabel,
      };
      historyIndexRef.current = -1;
      savedDraftRef.current = "";

      setPromptText("");
      useIdeStore.getState().setChatStreaming(submittedChatId, true);
      try {
        const sendPromise = sendMessage(
          {
            files: prompt.files,
            metadata: {
              createdAt: new Date().toISOString(),
              model: activeModel,
              modelLabel: activeOption?.label ?? activeModel,
              reasoningEffort: selectedReasoningEffort,
              reasoningLabel: selectedReasoningLabel,
            },
            text: prompt.text,
          },
          {
            body: {
              claudePermissionMode,
              codexPermissionMode,
              model: activeModel,
              modelLabel: activeOption?.label ?? activeModel,
              projectPath: project.path,
              provider: activeProvider,
              reasoningEffort: selectedReasoningEffort,
              reasoningLabel: selectedReasoningLabel,
              remoteConversationId: chat.remoteConversationId,
              remoteConversationModel: chat.remoteConversationModel,
              remoteConversationProjectPath: chat.remoteConversationProjectPath,
              chatId: chat.id,
            },
          },
        );
        scrollConversationToBottom();
        await sendPromise;
      } finally {
        useIdeStore.getState().setChatStreaming(submittedChatId, false);
        const nextGitRefreshKey =
          (useIdeStore.getState().projectGitRefreshKeys[project.id] ?? 0) + 1;
        pendingCommitMessageWarmRefreshTokensRef.current.add(nextGitRefreshKey);
        bumpProjectGitRefreshKey(project.id);
        bumpProjectFilesRefreshKey(project.id);
      }
    },
    [
      allModelOptions,
      bumpProjectFilesRefreshKey,
      bumpProjectGitRefreshKey,
      claudePermissionMode,
      codexPermissionMode,
      clearError,
      chatMessages,
      isProcessing,
      providerModels,
      project.id,
      project.path,
      selectedProvider,
      selectedReasoningEffort,
      selectedReasoningLabel,
      sendMessage,
      scrollConversationToBottom,
      chat,
      updateChat,
    ],
  );

  const closeRenameDialog = useCallback(() => {
    setRenameTarget(null);
    setRenameValue("");
  }, []);

  const handleRenameChat = useCallback(() => {
    setRenameTarget({ id: chat.id, name: chat.title });
    setRenameValue(chat.title);
  }, [chat.id, chat.title]);

  const handleRenameSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const nextName = renameValue.trim();
      if (!renameTarget || !nextName) {
        return;
      }

      updateChat(renameTarget.id, (current) => ({
        ...current,
        title: nextName,
      }));
      closeRenameDialog();
    },
    [closeRenameDialog, renameTarget, renameValue, updateChat],
  );

  const wasProcessingRef = useRef(isProcessing);

  // Build a fingerprint that changes whenever new data arrives.
  const lastMessage = messages[messages.length - 1];
  const showChatHeader = messages.length > 0;
  const canShowChatMenu = !isDraftChat || messages.length > 0;
  const lastPart = lastMessage?.parts?.[lastMessage.parts.length - 1];
  const streamFingerprint = `${messages.length}:${lastMessage?.parts?.length ?? 0}:${
    lastPart && "text" in lastPart ? (lastPart.text as string).length : 0
  }`;

  useEffect(() => {
    const wasProcessing = wasProcessingRef.current;
    wasProcessingRef.current = isProcessing;

    if (isProcessing && !wasProcessing) {
      scrollConversationToBottom();
      return;
    }

    if (!isProcessing && wasProcessing) {
      scrollConversationToBottomIfLocked();
    }
  }, [
    isProcessing,
    scrollConversationToBottom,
    scrollConversationToBottomIfLocked,
  ]);

  useEffect(() => {
    void streamFingerprint;

    if (!isProcessing) {
      return;
    }

    scrollConversationToBottomIfLocked();
  }, [isProcessing, scrollConversationToBottomIfLocked, streamFingerprint]);

  return (
    <>
      <div id={panelDomId} className="flex h-full min-h-0 flex-col">
        {showChatHeader ? (
          <div className="shrink-0 px-2 pt-2">
            <div className="mx-auto flex w-full max-w-[700px] items-center justify-between gap-3 pb-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">{chat.title}</p>
              </div>

              {canShowChatMenu ? (
                <div className="flex shrink-0 items-center gap-1">
                  <DropdownMenu
                    onOpenChange={setChatMenuOpen}
                    open={chatMenuOpen}
                  >
                    <DropdownMenuTrigger
                      render={
                        <Button
                          aria-label={`${chat.title} actions`}
                          className="h-8 w-8 p-0"
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        />
                      }
                    >
                      <Ellipsis className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem onClick={handleRenameChat}>
                        <FilePenLine className="size-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => deleteChat(chat.id)}>
                        <Trash2 className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <Conversation
          contextRef={conversationContextRef}
          id={conversationDomId}
          className="min-h-0 flex-1"
          initial={false}
        >
          <ConversationContent
            id={conversationContentDomId}
            className={
              messages.length === 0
                ? "mx-auto flex min-h-full w-full max-w-[700px] flex-col px-0 pt-3"
                : "relative mx-auto block w-full max-w-[700px] px-0 pt-3"
            }
            style={{ paddingBottom: CHAT_CONTENT_BOTTOM_PADDING_PX }}
          >
            {messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
                <img
                  alt=""
                  className="size-16"
                  draggable={false}
                  src="/icon.png"
                />
                <p className="font-medium text-lg">Build anything</p>
              </div>
            ) : (
              <VirtualizedChatMessages
                addToolApprovalResponse={addToolApprovalResponse}
                expandToolCalls={settings.expandToolCalls}
                groupToolCalls={settings.groupToolCalls}
                isStreaming={isStreaming}
                messages={messages}
                projectPath={project.path}
                showReasoningSummaries={settings.showReasoningSummaries}
              />
            )}
          </ConversationContent>
          <ConversationScrollMemory isActive={isActive} />
          <ConversationScrollButton />
        </Conversation>

        {localError ? (
          <div className="shrink-0 px-2 pb-1">
            <div className="mx-auto flex w-full max-w-[700px] items-start gap-2 rounded-md border border-red-500/20 bg-red-500/8 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{localError}</span>
              <button
                type="button"
                className="mt-0.5 shrink-0 rounded p-0.5 hover:bg-red-500/10"
                onClick={() => {
                  setLocalError(null);
                  clearError();
                }}
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        ) : null}

        <div id={promptDomId} className="shrink-0 px-2 pb-2">
          <div className="mx-auto w-full max-w-[700px]">
            <Sparkles
              density={70}
              disabled={!isProcessing}
              height={30}
              sway={0}
              speed={2}
              palette={["#9bf2ff", "#6ac7ff", "#caf8ff", "#5ea3ff"]}
            >
              <div className="overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md">
                {/* ── Prompt Input ──────────────────────────────────────── */}
                <PromptInput
                  id={promptInputDomId}
                  className="w-full [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:backdrop-blur-none [&_[data-slot=input-group]]:ring-0 [&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-0"
                  onSubmit={handleSubmit}
                >
                  <PromptInputBody>
                    <PromptAttachments />
                    <PromptInputTextarea
                      className="min-h-0 border-none bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
                      onChange={(event) => setPromptText(event.target.value)}
                      onKeyDown={handlePromptKeyDown}
                      placeholder="Ask anything..."
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
                            promptText.trim() === "")
                        }
                        onStop={stop}
                        status={status}
                      />
                    </div>
                  </PromptInputFooter>
                </PromptInput>

                {/* ── Options Row ───────────────────────────────────────── */}
                <div className="flex items-center gap-1 border-t border-foreground/10 px-2 py-1.5">
                  {/* Model selector */}
                  <Select
                    onValueChange={(value) => {
                      if (typeof value !== "string") return;
                      const matchingOptions = allModelOptions.filter(
                        (option) => option.id === value,
                      );
                      const nextOption =
                        matchingOptions.find(
                          (option) => option.provider === chat.provider,
                        ) ?? matchingOptions[0];
                      if (!nextOption) return;

                      updateChat(chat.id, (current) => ({
                        ...current,
                        model: nextOption.id,
                        provider: nextOption.provider,
                        remoteConversationId: null,
                        remoteConversationModel: null,
                        remoteConversationProjectPath: null,
                      }));
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
                    </SelectContent>
                  </Select>

                  {/* Reasoning effort selector */}
                  {reasoningEffortOptions.length > 0 && (
                    <Select
                      onValueChange={(value) => {
                        updateChat(chat.id, (current) => ({
                          ...current,
                          reasoningEffort: value as ReasoningEffort,
                        }));
                      }}
                      value={selectedReasoningEffort}
                    >
                      <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                        <span className="truncate">
                          {selectedReasoningLabel}
                        </span>
                      </SelectTrigger>
                      <SelectContent className="text-xs" side="top">
                        {reasoningEffortOptions.map((option) => (
                          <SelectItem
                            className="text-xs"
                            key={option.value}
                            value={option.value}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {selectedProvider === "openai" ? (
                    <Select
                      onValueChange={(value) => {
                        setCodexPermissionMode(value as CodexPermissionMode);
                      }}
                      value={codexPermissionMode}
                    >
                      <SelectTrigger className="h-7 w-auto max-w-52 gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                        <Shield className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {getCodexPermissionModeLabel(codexPermissionMode)}
                        </span>
                      </SelectTrigger>
                      <SelectContent className="text-xs" side="top">
                        {CODEX_PERMISSION_MODE_OPTIONS.map((option) => (
                          <SelectItem
                            className="text-xs"
                            key={option.value}
                            value={option.value}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : selectedProvider === "anthropic" ? (
                    <Select
                      onValueChange={(value) => {
                        setClaudePermissionMode(value as ClaudePermissionMode);
                      }}
                      value={claudePermissionMode}
                    >
                      <SelectTrigger className="h-7 w-auto max-w-52 gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                        <Shield className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {getClaudePermissionModeLabel(claudePermissionMode)}
                        </span>
                      </SelectTrigger>
                      <SelectContent className="text-xs" side="top">
                        {CLAUDE_PERMISSION_MODE_OPTIONS.map((option) => (
                          <SelectItem
                            className="text-xs"
                            key={option.value}
                            value={option.value}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
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
              <BranchSwitcher
                projectId={project.id}
                projectPath={project.path}
              />
            </div>
          </div>
        </div>
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            closeRenameDialog();
          }
        }}
        open={renameTarget !== null}
      >
        <DialogContent className="sm:max-w-sm">
          <form className="space-y-4" onSubmit={handleRenameSubmit}>
            <DialogHeader>
              <DialogTitle>Rename chat</DialogTitle>
              <DialogDescription>
                Choose a new name for this chat.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder="Enter a name"
              value={renameValue}
            />
            <DialogFooter>
              <Button
                onClick={closeRenameDialog}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={renameValue.trim().length === 0} type="submit">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
