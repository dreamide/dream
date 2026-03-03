"use client";

import { useChat } from "@ai-sdk/react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { UIMessage } from "ai";
import {
  DefaultChatTransport,
  type DynamicToolUIPart,
  type FileUIPart,
  type ReasoningUIPart,
  type SourceDocumentUIPart,
  type SourceUrlUIPart,
  type TextUIPart,
  type ToolUIPart,
} from "ai";
import {
  AlertCircle,
  ArrowLeft,
  FolderPlus,
  Logs,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Play,
  RefreshCcw,
  Settings,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { getDesktopApi } from "@/lib/electron";
import {
  createProjectConfig,
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_SETTINGS,
  getConnectedProviders,
  getDefaultModelForProvider,
  getModelsForProvider,
  getProviderAuthMode,
  getProviderCredential,
} from "@/lib/ide-defaults";
import { cn } from "@/lib/utils";
import type {
  AiProvider,
  AppSettings,
  PersistedIdeState,
  PreviewBounds,
  PreviewErrorEvent,
  ProjectConfig,
  RunnerDataEvent,
  RunnerStatusEvent,
  TerminalDataEvent,
  TerminalStatusEvent,
} from "@/types/ide";

const STATE_STORAGE_KEY = "dream:ide:state";

type SettingsSection = "providers" | "models" | "terminal";

type RunnerStatus = "running" | "stopped";

type TerminalStatus = "running" | "stopped";
type TerminalTransport = "pty" | "pipe";

const GLOBAL_TERMINAL_SESSION_ID = "__global_terminal__";
const TERMINAL_MIN_HEIGHT_PX = 160;

interface CodexLoginStatus {
  authMode: string;
  loading: boolean;
  loggedIn: boolean;
  message: string;
}

type ModelFetchSource = "api" | "unavailable";

interface ProviderModelFetchResult {
  models: string[];
  source: ModelFetchSource;
  error?: string;
}

interface ProviderModelsResponse {
  fetchedAt: string;
  openai: ProviderModelFetchResult;
  anthropic: ProviderModelFetchResult;
}

interface ProviderModelState {
  models: string[];
  source: ModelFetchSource;
  loading: boolean;
  error: string | null;
}

const dedupeModels = (models: string[]): string[] => {
  return Array.from(
    new Set(models.map((model) => model.trim()).filter(Boolean)),
  );
};

const ALL_PROVIDERS: AiProvider[] = ["openai", "anthropic"];

const getProviderLabel = (provider: AiProvider): string => {
  return provider === "openai" ? "OpenAI" : "Anthropic";
};

const getProviderDescription = (provider: AiProvider): string => {
  return provider === "openai"
    ? "Access GPT and Codex models for coding and general chat."
    : "Access Claude models for reasoning and long-context tasks.";
};

const inferConnectedProviders = (
  settings: AppSettings,
  hasExplicitConnectedProviders: boolean,
): AiProvider[] => {
  if (hasExplicitConnectedProviders) {
    return getConnectedProviders(settings);
  }

  const inferredProviders: AiProvider[] = [];
  const hasOpenAiConfig =
    settings.openAiApiKey.trim().length > 0 ||
    settings.openAiAuthMode === "codex" ||
    settings.openAiSelectedModels.length > 0;
  const hasAnthropicConfig =
    settings.anthropicApiKey.trim().length > 0 ||
    settings.anthropicSelectedModels.length > 0;

  if (hasOpenAiConfig) {
    inferredProviders.push("openai");
  }

  if (hasAnthropicConfig) {
    inferredProviders.push("anthropic");
  }

  return inferredProviders;
};

const emptyState: PersistedIdeState = {
  activeProjectId: null,
  chats: {},
  panelVisibility: DEFAULT_PANEL_VISIBILITY,
  projects: [],
  settings: DEFAULT_SETTINGS,
};

const mergePersistedState = (
  state: Partial<PersistedIdeState> | null | undefined,
): PersistedIdeState => {
  if (!state) {
    return emptyState;
  }

  const projects = Array.isArray(state.projects) ? state.projects : [];
  const rawSettings = (state.settings ?? {}) as Partial<AppSettings>;
  const hasExplicitConnectedProviders = Object.hasOwn(
    rawSettings,
    "connectedProviders",
  );
  const mergedSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...rawSettings,
  };

  if ((mergedSettings.openAiAuthMode as string) === "oauth") {
    mergedSettings.openAiAuthMode = "codex";
  }

  if (
    mergedSettings.openAiAuthMode !== "apiKey" &&
    mergedSettings.openAiAuthMode !== "codex"
  ) {
    mergedSettings.openAiAuthMode = "apiKey";
  }

  const openAiSelectedModels = dedupeModels(
    Array.isArray(mergedSettings.openAiSelectedModels)
      ? mergedSettings.openAiSelectedModels
      : [],
  );
  mergedSettings.openAiSelectedModels = openAiSelectedModels;

  if (
    !mergedSettings.openAiSelectedModels.includes(
      mergedSettings.defaultOpenAiModel,
    )
  ) {
    mergedSettings.defaultOpenAiModel =
      mergedSettings.openAiSelectedModels[0] ?? "";
  }

  const anthropicSelectedModels = dedupeModels(
    Array.isArray(mergedSettings.anthropicSelectedModels)
      ? mergedSettings.anthropicSelectedModels
      : [],
  );
  mergedSettings.anthropicSelectedModels = anthropicSelectedModels;

  if (
    !mergedSettings.anthropicSelectedModels.includes(
      mergedSettings.defaultAnthropicModel,
    )
  ) {
    mergedSettings.defaultAnthropicModel =
      mergedSettings.anthropicSelectedModels[0] ?? "";
  }

  mergedSettings.connectedProviders = inferConnectedProviders(
    mergedSettings,
    hasExplicitConnectedProviders,
  );

  return {
    activeProjectId:
      typeof state.activeProjectId === "string" ? state.activeProjectId : null,
    chats: state.chats ?? {},
    panelVisibility: {
      ...DEFAULT_PANEL_VISIBILITY,
      ...(state.panelVisibility ?? {}),
    },
    projects,
    settings: mergedSettings,
  };
};

const ensureActiveProject = (
  projects: ProjectConfig[],
  activeProjectId: string | null,
): string | null => {
  if (projects.length === 0) {
    return null;
  }

  if (
    activeProjectId &&
    projects.some((project) => project.id === activeProjectId)
  ) {
    return activeProjectId;
  }

  return projects[0]?.id ?? null;
};

const renderUserMessageText = (message: UIMessage): string => {
  return message.parts
    .flatMap((part) => {
      if (part.type !== "text") {
        return [];
      }

      return [part.text];
    })
    .join("\n")
    .trim();
};

const stringifyPart = (
  part:
    | unknown
    | DynamicToolUIPart
    | FileUIPart
    | ReasoningUIPart
    | SourceDocumentUIPart
    | SourceUrlUIPart
    | TextUIPart
    | ToolUIPart,
): string => {
  try {
    return JSON.stringify(part, null, 2);
  } catch {
    return "[unserializable part]";
  }
};

interface ChatPanelProps {
  chats: Record<string, UIMessage[]>;
  onMessagesChange: (projectId: string, messages: UIMessage[]) => void;
  onProjectChange: (
    projectId: string,
    updater: (project: ProjectConfig) => ProjectConfig,
  ) => void;
  project: ProjectConfig;
  settings: PersistedIdeState["settings"];
}

const ChatPanel = ({
  chats,
  onMessagesChange,
  onProjectChange,
  project,
  settings,
}: ChatPanelProps) => {
  const connectedProviders = getConnectedProviders(settings);
  const isProviderConnected = connectedProviders.includes(project.provider);
  const providerAuthMode = getProviderAuthMode(project.provider, settings);
  const providerCredential = getProviderCredential(project.provider, settings);
  const usesCodexLogin =
    project.provider === "openai" && providerAuthMode === "codex";
  const credentialLabel = usesCodexLogin ? "Codex Login" : "API key";
  const [localError, setLocalError] = useState<string | null>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );

  const { messages, sendMessage, status, stop } = useChat({
    id: `project:${project.id}`,
    messages: chats[project.id] ?? [],
    onError: (error) => {
      setLocalError(error.message);
    },
    transport,
  });

  useEffect(() => {
    onMessagesChange(project.id, messages);
  }, [project.id, messages, onMessagesChange]);

  const models = getModelsForProvider(project.provider, settings);
  const selectedModel = models.includes(project.model)
    ? project.model
    : (models[0] ?? "");

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      setLocalError(null);

      const activeModel = models.includes(project.model)
        ? project.model
        : (models[0] ?? "");

      if (!isProviderConnected) {
        setLocalError(
          "Connect a provider in Settings before sending a prompt.",
        );
        return;
      }

      if (!activeModel) {
        setLocalError("Enable at least one model in Settings first.");
        return;
      }

      if (!providerCredential && !usesCodexLogin) {
        setLocalError(
          `Add a ${project.provider === "anthropic" ? "Anthropic" : "OpenAI"} ${credentialLabel} in Settings first.`,
        );
        return;
      }

      if (!prompt.text.trim() && prompt.files.length === 0) {
        return;
      }

      await sendMessage(
        {
          files: prompt.files,
          text: prompt.text,
        },
        {
          body: {
            authMode: providerAuthMode,
            credential: providerCredential,
            model: activeModel,
            projectPath: project.path,
            provider: project.provider,
          },
        },
      );
    },
    [
      credentialLabel,
      models,
      isProviderConnected,
      project,
      providerAuthMode,
      providerCredential,
      sendMessage,
      usesCodexLogin,
    ],
  );

  const messageContent = useMemo(() => {
    return messages.map((message) => {
      if (message.role === "user") {
        return (
          <Message from="user" key={message.id}>
            <MessageContent>
              <MessageResponse>
                {renderUserMessageText(message)}
              </MessageResponse>
            </MessageContent>
          </Message>
        );
      }

      return (
        <Message from={message.role} key={message.id}>
          <MessageContent>
            {message.parts.map((part, index) => {
              if (part.type === "text") {
                return (
                  <MessageResponse key={`${message.id}-text-${index}`}>
                    {part.text}
                  </MessageResponse>
                );
              }

              if (part.type === "reasoning") {
                return (
                  <pre
                    className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs"
                    key={`${message.id}-reasoning-${index}`}
                  >
                    {part.text}
                  </pre>
                );
              }

              if (part.type === "file") {
                const label = part.filename ?? part.url ?? "Attached file";

                return (
                  <Badge
                    key={`${message.id}-file-${index}`}
                    variant="secondary"
                  >
                    File: {label}
                  </Badge>
                );
              }

              if (part.type === "source-url") {
                return (
                  <a
                    className="block text-xs text-primary underline underline-offset-4"
                    href={part.url}
                    key={`${message.id}-source-url-${index}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Source: {part.url}
                  </a>
                );
              }

              if (part.type === "source-document") {
                return (
                  <Badge
                    key={`${message.id}-source-document-${index}`}
                    variant="outline"
                  >
                    Source: {part.title ?? part.filename ?? "Document"}
                  </Badge>
                );
              }

              if (
                typeof part.type === "string" &&
                (part.type.startsWith("tool-") || part.type === "dynamic-tool")
              ) {
                return (
                  <pre
                    className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs"
                    key={`${message.id}-tool-${index}`}
                  >
                    {stringifyPart(part)}
                  </pre>
                );
              }

              if (part.type === "step-start") {
                return null;
              }

              return (
                <pre
                  className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs"
                  key={`${message.id}-part-${index}`}
                >
                  {stringifyPart(part)}
                </pre>
              );
            })}
          </MessageContent>
        </Message>
      );
    });
  }, [messages]);

  return (
    <div className="flex h-full flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-4 p-3">
          {messages.length === 0 ? (
            <ConversationEmptyState
              description="Ask the assistant to inspect, edit, or create files in the active project."
              title="No chat messages yet"
            />
          ) : (
            messageContent
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t p-3">
        <PromptInput
          className="w-full rounded-2xl bg-background px-2 pt-2 pb-1"
          onSubmit={handleSubmit}
        >
          <PromptInputBody>
            <PromptInputTextarea
              className="min-h-[104px] border-none bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
              placeholder={`Ask AI to update ${project.name}...`}
            />
          </PromptInputBody>
          <PromptInputFooter className="items-center">
            <PromptInputTools className="gap-1.5 overflow-x-auto">
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger tooltip="Attach file" />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>

              <PromptInputSelect
                onValueChange={(value) => {
                  onProjectChange(project.id, (current) => ({
                    ...current,
                    model: getDefaultModelForProvider(
                      value as AiProvider,
                      settings,
                    ),
                    provider: value as AiProvider,
                  }));
                }}
                value={isProviderConnected ? project.provider : undefined}
              >
                <PromptInputSelectTrigger
                  className="h-8 min-w-[110px] px-2 text-xs"
                  disabled={connectedProviders.length === 0}
                >
                  <PromptInputSelectValue placeholder="Provider" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {connectedProviders.map((provider) => (
                    <PromptInputSelectItem key={provider} value={provider}>
                      {getProviderLabel(provider)}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>

              <PromptInputSelect
                onValueChange={(value) => {
                  onProjectChange(project.id, (current) => ({
                    ...current,
                    model: value,
                  }));
                }}
                value={selectedModel || undefined}
              >
                <PromptInputSelectTrigger
                  className="h-8 min-w-[180px] max-w-[260px] px-2 text-xs"
                  disabled={models.length === 0}
                >
                  <PromptInputSelectValue placeholder="Model" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {models.map((model) => (
                    <PromptInputSelectItem key={model} value={model}>
                      {model}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            </PromptInputTools>
            <PromptInputSubmit
              className="size-8 rounded-full"
              disabled={
                !isProviderConnected ||
                (!providerCredential && !usesCodexLogin) ||
                selectedModel === ""
              }
              onStop={stop}
              status={status}
            />
          </PromptInputFooter>
        </PromptInput>

        <div className="mt-2 flex items-center gap-2">
          {!isProviderConnected ? (
            <Badge variant="destructive">No provider connected</Badge>
          ) : !providerCredential && !usesCodexLogin ? (
            <Badge variant="destructive">Missing {credentialLabel}</Badge>
          ) : selectedModel === "" ? (
            <Badge variant="outline">No model enabled</Badge>
          ) : null}
        </div>

        {localError ? (
          <p className="mt-2 text-destructive text-xs">{localError}</p>
        ) : null}
      </div>
    </div>
  );
};

const ResizeHandle = ({ className }: { className?: string }) => (
  <Separator
    className={cn(
      "relative bg-border/70 after:absolute after:inset-0 after:bg-primary/0 after:transition-colors hover:after:bg-primary/20",
      className,
    )}
  />
);

const ToggleButton = ({
  active,
  children,
  onClick,
  title,
}: PropsWithChildren<{
  active: boolean;
  onClick: () => void;
  title: string;
}>) => (
  <Button
    aria-label={title}
    className="size-8 [-webkit-app-region:no-drag]"
    onClick={onClick}
    size="icon"
    title={title}
    variant={active ? "secondary" : "ghost"}
  >
    {children}
  </Button>
);

const AppShellPlaceholder = ({ message }: { message: string }) => (
  <div className="flex h-full items-center justify-center rounded-md border border-dashed bg-muted/30 p-4 text-center text-muted-foreground text-sm">
    {message}
  </div>
);

const echoPipeFallbackInput = (terminal: Terminal, data: string) => {
  let echoed = "";

  for (const char of data) {
    const code = char.charCodeAt(0);

    if (char === "\r" || char === "\n") {
      echoed += "\r\n";
      continue;
    }

    if (char === "\u007f") {
      echoed += "\b \b";
      continue;
    }

    if (code === 0x03) {
      echoed += "^C\r\n";
      continue;
    }

    if (char === "\u001b" || code < 0x20) {
      continue;
    }

    echoed += char;
  }

  if (echoed) {
    terminal.write(echoed);
  }
};

export const IdeShell = () => {
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [panelVisibility, setPanelVisibility] = useState(
    DEFAULT_PANEL_VISIBILITY,
  );
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [chats, setChats] = useState<Record<string, UIMessage[]>>({});
  const [runLogs, setRunLogs] = useState<Record<string, string>>({});
  const [runnerStatus, setRunnerStatus] = useState<
    Record<string, RunnerStatus>
  >({});
  const [terminalStatus, setTerminalStatus] = useState<
    Record<string, TerminalStatus>
  >({});
  const [terminalShell, setTerminalShell] = useState<Record<string, string>>(
    {},
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("providers");
  const [providerSetupTarget, setProviderSetupTarget] =
    useState<AiProvider | null>(null);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [codexLoginStatus, setCodexLoginStatus] = useState<CodexLoginStatus>({
    authMode: "unknown",
    loading: false,
    loggedIn: false,
    message: "",
  });
  const [providerModels, setProviderModels] = useState<{
    openai: ProviderModelState;
    anthropic: ProviderModelState;
    fetchedAt: string | null;
  }>({
    anthropic: {
      error: null,
      loading: false,
      models: [],
      source: "unavailable",
    },
    fetchedAt: null,
    openai: {
      error: null,
      loading: false,
      models: [],
      source: "unavailable",
    },
  });
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(false);
  const [outputPanelOpen, setOutputPanelOpen] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [stateHydrated, setStateHydrated] = useState(false);
  const providerCredentialsRef = useRef<{
    anthropicApiKey: string;
    openAiApiKey: string;
    openAiAuthMode: "apiKey" | "codex";
  }>({
    anthropicApiKey: DEFAULT_SETTINGS.anthropicApiKey,
    openAiApiKey: DEFAULT_SETTINGS.openAiApiKey,
    openAiAuthMode: DEFAULT_SETTINGS.openAiAuthMode,
  });

  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const [terminalHost, setTerminalHost] = useState<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalFitRef = useRef<FitAddon | null>(null);
  const terminalTransportRef = useRef<TerminalTransport>("pty");

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  const [isMacOs, setIsMacOs] = useState(false);

  useEffect(() => {
    setIsMacOs(/mac/i.test(window.navigator.userAgent));
  }, []);

  const persistState = useCallback(async (nextState: PersistedIdeState) => {
    const desktopApi = getDesktopApi();

    if (desktopApi) {
      await desktopApi.saveState(nextState);
      return;
    }

    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(nextState));
  }, []);

  const readPersistedState =
    useCallback(async (): Promise<PersistedIdeState> => {
      const desktopApi = getDesktopApi();

      if (desktopApi) {
        const rawState = await desktopApi.loadState();
        return mergePersistedState(rawState);
      }

      const rawState = localStorage.getItem(STATE_STORAGE_KEY);
      if (!rawState) {
        return emptyState;
      }

      try {
        return mergePersistedState(JSON.parse(rawState) as PersistedIdeState);
      } catch {
        return emptyState;
      }
    }, []);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      const loadedState = await readPersistedState();
      if (cancelled) {
        return;
      }

      setProjects(loadedState.projects);
      setActiveProjectId(
        ensureActiveProject(loadedState.projects, loadedState.activeProjectId),
      );
      setPanelVisibility(loadedState.panelVisibility);
      setSettings(loadedState.settings);
      setChats(loadedState.chats);
      setStateHydrated(true);
    };

    void hydrate();

    return () => {
      cancelled = true;
    };
  }, [readPersistedState]);

  useEffect(() => {
    if (!stateHydrated) {
      return;
    }

    const nextState: PersistedIdeState = {
      activeProjectId: ensureActiveProject(projects, activeProjectId),
      chats,
      panelVisibility,
      projects,
      settings,
    };

    void persistState(nextState);
  }, [
    activeProjectId,
    chats,
    panelVisibility,
    persistState,
    projects,
    settings,
    stateHydrated,
  ]);

  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      return;
    }

    const appendLog = (event: RunnerDataEvent) => {
      setRunLogs((previous) => {
        const current = previous[event.projectId] ?? "";
        const next = `${current}${event.chunk}`;

        return {
          ...previous,
          [event.projectId]: next.slice(-150_000),
        };
      });
    };

    const onRunnerStatus = (event: RunnerStatusEvent) => {
      setRunnerStatus((previous) => ({
        ...previous,
        [event.projectId]: event.status,
      }));
    };

    const onTerminalData = (event: TerminalDataEvent) => {
      if (event.projectId !== GLOBAL_TERMINAL_SESSION_ID) {
        return;
      }
      terminalRef.current?.write(event.chunk);
    };

    const onTerminalStatus = (event: TerminalStatusEvent) => {
      if (event.projectId !== GLOBAL_TERMINAL_SESSION_ID) {
        return;
      }

      const transport = event.transport;
      if (transport) {
        terminalTransportRef.current = transport;
      }

      setTerminalStatus((previous) => ({
        ...previous,
        [event.projectId]: event.status,
      }));

      const shell = typeof event.shell === "string" ? event.shell.trim() : "";
      if (shell) {
        setTerminalShell((previous) => ({
          ...previous,
          [event.projectId]: shell,
        }));
      }
    };

    const onPreviewError = (event: PreviewErrorEvent) => {
      setPreviewError(
        `${String(event.code)}${event.description ? `: ${event.description}` : ""}`,
      );
    };

    const removeRunnerData = desktopApi.onRunnerData(appendLog);
    const removeRunnerStatus = desktopApi.onRunnerStatus(onRunnerStatus);
    const removeTerminalData = desktopApi.onTerminalData(onTerminalData);
    const removeTerminalStatus = desktopApi.onTerminalStatus(onTerminalStatus);
    const removePreviewError = desktopApi.onPreviewError(onPreviewError);

    return () => {
      removeRunnerData();
      removeRunnerStatus();
      removeTerminalData();
      removeTerminalStatus();
      removePreviewError();
    };
  }, []);

  useEffect(() => {
    const host = terminalHost;
    if (!host) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      theme: {
        background: "#ffffff",
        cursor: "#111827",
        foreground: "#1f2937",
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(host);

    terminalRef.current = terminal;
    terminalFitRef.current = fitAddon;

    const fit = () => {
      fitAddon.fit();
    };

    fit();
    terminal.focus();

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);

    const inputSubscription = terminal.onData((data) => {
      const desktopApi = getDesktopApi();
      if (!desktopApi) {
        return;
      }

      if (terminalTransportRef.current === "pipe") {
        echoPipeFallbackInput(terminal, data);
      }

      desktopApi.sendTerminalInput({
        data,
        projectId: GLOBAL_TERMINAL_SESSION_ID,
      });
    });

    window.addEventListener("resize", fit);

    return () => {
      inputSubscription.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", fit);
      terminal.dispose();
      terminalRef.current = null;
      terminalFitRef.current = null;
    };
  }, [terminalHost]);

  const syncPreviewBounds = useCallback(() => {
    const desktopApi = getDesktopApi();
    const activeProjectRunnerStatus = activeProject
      ? (runnerStatus[activeProject.id] ?? "stopped")
      : "stopped";

    if (!desktopApi) {
      return;
    }

    if (
      !activeProject ||
      !panelVisibility.right ||
      activeProjectRunnerStatus !== "running"
    ) {
      desktopApi.updatePreview({ visible: false });
      return;
    }

    const host = previewHostRef.current;
    if (!host) {
      return;
    }

    const rect = host.getBoundingClientRect();

    if (rect.width <= 0 || rect.height <= 0) {
      desktopApi.updatePreview({ visible: false });
      return;
    }

    const bounds: PreviewBounds = {
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };

    desktopApi.updatePreview({
      bounds,
      url: activeProject.previewUrl,
      visible: true,
    });
  }, [activeProject, panelVisibility.right, runnerStatus]);

  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      return;
    }

    const update = () => {
      syncPreviewBounds();
    };

    const observer = new ResizeObserver(update);
    if (previewHostRef.current) {
      observer.observe(previewHostRef.current);
    }

    window.addEventListener("resize", update);

    const frame = window.requestAnimationFrame(update);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [syncPreviewBounds]);

  useEffect(() => {
    if (!panelVisibility.middle || !terminalPanelOpen) {
      return;
    }

    terminalFitRef.current?.fit();
    terminalRef.current?.focus();
  }, [panelVisibility.middle, terminalPanelOpen]);

  useEffect(() => {
    return () => {
      const desktopApi = getDesktopApi();
      if (!desktopApi) {
        return;
      }

      desktopApi.updatePreview({ visible: false });
    };
  }, []);

  const setMessagesForProject = useCallback(
    (projectId: string, messages: UIMessage[]) => {
      setChats((previous) => ({
        ...previous,
        [projectId]: messages,
      }));
    },
    [],
  );

  const updateProject = useCallback(
    (projectId: string, updater: (project: ProjectConfig) => ProjectConfig) => {
      setProjects((previous) =>
        previous.map((project) =>
          project.id === projectId ? updater(project) : project,
        ),
      );
    },
    [],
  );

  const handleAddProject = useCallback(async () => {
    const desktopApi = getDesktopApi();

    if (!desktopApi) {
      window.alert("Open this app inside Electron to add project folders.");
      return;
    }

    const selectedPath = await desktopApi.pickProjectDirectory();
    if (!selectedPath) {
      return;
    }

    setProjects((previous) => {
      const existingProject = previous.find(
        (project) => project.path === selectedPath,
      );

      if (existingProject) {
        setActiveProjectId(existingProject.id);
        return previous;
      }

      const nextProject = createProjectConfig(selectedPath, settings);
      setActiveProjectId(nextProject.id);

      return [...previous, nextProject];
    });
  }, [settings]);

  const handleCloseProject = useCallback((projectId: string) => {
    const desktopApi = getDesktopApi();
    if (desktopApi) {
      void desktopApi.stopRunner(projectId);
    }

    setProjects((previous) => {
      const nextProjects = previous.filter(
        (project) => project.id !== projectId,
      );

      setActiveProjectId((current) =>
        ensureActiveProject(nextProjects, current),
      );

      return nextProjects;
    });

    setChats((previous) => {
      const next = { ...previous };
      delete next[projectId];
      return next;
    });

    setRunLogs((previous) => {
      const next = { ...previous };
      delete next[projectId];
      return next;
    });

    setRunnerStatus((previous) => {
      const next = { ...previous };
      delete next[projectId];
      return next;
    });

    setTerminalStatus((previous) => {
      const next = { ...previous };
      delete next[projectId];
      return next;
    });
  }, []);

  const togglePanel = useCallback((panel: keyof typeof panelVisibility) => {
    setPanelVisibility((previous) => ({
      ...previous,
      [panel]: !previous[panel],
    }));
  }, []);

  const startRunner = useCallback(async () => {
    if (!activeProject) {
      return;
    }

    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      return;
    }

    setRunLogs((previous) => ({
      ...previous,
      [activeProject.id]:
        (previous[activeProject.id] ?? "") +
        `\n$ ${activeProject.runCommand}\n\n`,
    }));

    setPreviewError(null);

    await desktopApi.startRunner({
      command: activeProject.runCommand,
      cwd: activeProject.path,
      projectId: activeProject.id,
      projectName: activeProject.name,
    });
  }, [activeProject]);

  const stopRunner = useCallback(async () => {
    if (!activeProject) {
      return;
    }

    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      return;
    }

    await desktopApi.stopRunner(activeProject.id);
  }, [activeProject]);

  const startActiveTerminal = useCallback(async () => {
    if (!activeProject) {
      return;
    }

    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      return;
    }

    terminalRef.current?.clear();
    terminalRef.current?.focus();

    setTerminalStatus((previous) => ({
      ...previous,
      [GLOBAL_TERMINAL_SESSION_ID]: "running",
    }));

    await desktopApi.startTerminal({
      cwd: activeProject.path,
      projectId: GLOBAL_TERMINAL_SESSION_ID,
      shellPath: settings.shellPath || undefined,
    });
  }, [activeProject, settings.shellPath]);

  const stopActiveTerminal = useCallback(async () => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      return;
    }

    setTerminalStatus((previous) => ({
      ...previous,
      [GLOBAL_TERMINAL_SESSION_ID]: "stopped",
    }));

    await desktopApi.stopTerminal(GLOBAL_TERMINAL_SESSION_ID);
  }, []);

  const closeTerminalPanel = useCallback(async () => {
    setTerminalPanelOpen(false);
    await stopActiveTerminal();
  }, [stopActiveTerminal]);

  const openExternalUrl = useCallback((url: string) => {
    const desktopApi = getDesktopApi();

    if (desktopApi) {
      void desktopApi.openExternal(url);
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const refreshCodexLoginStatus = useCallback(async () => {
    setCodexLoginStatus((previous) => ({ ...previous, loading: true }));

    try {
      const response = await fetch("/api/codex-auth");
      if (!response.ok) {
        throw new Error(`Status check failed (${response.status})`);
      }

      const payload = (await response.json()) as {
        authMode: string;
        loggedIn: boolean;
        message: string;
      };

      setCodexLoginStatus({
        authMode: payload.authMode ?? "unknown",
        loading: false,
        loggedIn: Boolean(payload.loggedIn),
        message: payload.message ?? "",
      });
    } catch {
      setCodexLoginStatus({
        authMode: "unknown",
        loading: false,
        loggedIn: false,
        message: "Unable to read Codex login status.",
      });
    }
  }, []);

  const refreshProviderModels = useCallback(
    async ({
      anthropicApiKey,
      openAiApiKey,
      openAiAuthMode,
    }: {
      anthropicApiKey: string;
      openAiApiKey: string;
      openAiAuthMode: "apiKey" | "codex";
    }) => {
      setProviderModels((previous) => ({
        ...previous,
        anthropic: { ...previous.anthropic, error: null, loading: true },
        openai: { ...previous.openai, error: null, loading: true },
      }));

      try {
        const response = await fetch("/api/provider-models", {
          body: JSON.stringify({
            anthropicApiKey,
            openAiApiKey,
            openAiAuthMode,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        });

        if (!response.ok) {
          throw new Error(`Model fetch failed (${response.status}).`);
        }

        const payload = (await response.json()) as ProviderModelsResponse;
        const openAiAvailableModels = dedupeModels(payload.openai.models);
        const anthropicAvailableModels = dedupeModels(payload.anthropic.models);
        const nextOpenAiModels = openAiAvailableModels;
        const nextAnthropicModels = anthropicAvailableModels;

        setProviderModels({
          anthropic: {
            error: payload.anthropic.error ?? null,
            loading: false,
            models: nextAnthropicModels,
            source: payload.anthropic.source,
          },
          fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
          openai: {
            error: payload.openai.error ?? null,
            loading: false,
            models: nextOpenAiModels,
            source: payload.openai.source,
          },
        });

        setSettings((previous) => {
          const currentOpenAiSelected = dedupeModels(
            previous.openAiSelectedModels,
          ).filter((model) => nextOpenAiModels.includes(model));
          const currentAnthropicSelected = dedupeModels(
            previous.anthropicSelectedModels,
          ).filter((model) => nextAnthropicModels.includes(model));

          const openAiSelectedModels =
            currentOpenAiSelected.length > 0 ? currentOpenAiSelected : [];
          const anthropicSelectedModels =
            currentAnthropicSelected.length > 0 ? currentAnthropicSelected : [];

          const defaultOpenAiModel = openAiSelectedModels.includes(
            previous.defaultOpenAiModel,
          )
            ? previous.defaultOpenAiModel
            : (openAiSelectedModels[0] ?? "");
          const defaultAnthropicModel = anthropicSelectedModels.includes(
            previous.defaultAnthropicModel,
          )
            ? previous.defaultAnthropicModel
            : (anthropicSelectedModels[0] ?? "");

          if (
            defaultOpenAiModel === previous.defaultOpenAiModel &&
            defaultAnthropicModel === previous.defaultAnthropicModel &&
            openAiSelectedModels.length ===
              previous.openAiSelectedModels.length &&
            anthropicSelectedModels.length ===
              previous.anthropicSelectedModels.length &&
            openAiSelectedModels.every(
              (model, index) => previous.openAiSelectedModels[index] === model,
            ) &&
            anthropicSelectedModels.every(
              (model, index) =>
                previous.anthropicSelectedModels[index] === model,
            )
          ) {
            return previous;
          }

          return {
            ...previous,
            anthropicSelectedModels,
            defaultAnthropicModel,
            defaultOpenAiModel,
            openAiSelectedModels,
          };
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to fetch models.";

        setProviderModels((previous) => ({
          anthropic: {
            error: message,
            loading: false,
            models: previous.anthropic.models,
            source: previous.anthropic.source,
          },
          fetchedAt: previous.fetchedAt,
          openai: {
            error: message,
            loading: false,
            models: previous.openai.models,
            source: previous.openai.source,
          },
        }));
      }
    },
    [],
  );

  useEffect(() => {
    providerCredentialsRef.current = {
      anthropicApiKey: settings.anthropicApiKey,
      openAiApiKey: settings.openAiApiKey,
      openAiAuthMode: settings.openAiAuthMode,
    };
  }, [
    settings.anthropicApiKey,
    settings.openAiApiKey,
    settings.openAiAuthMode,
  ]);

  const connectedProviders = useMemo(() => {
    return getConnectedProviders(settings);
  }, [settings]);
  const openAiModels = useMemo(() => {
    return getModelsForProvider("openai", settings);
  }, [settings]);
  const anthropicModels = useMemo(() => {
    return getModelsForProvider("anthropic", settings);
  }, [settings]);

  useEffect(() => {
    if (
      !settingsOpen ||
      (settingsSection !== "providers" && settingsSection !== "models")
    ) {
      return;
    }

    const providerCredentials = providerCredentialsRef.current;
    void refreshProviderModels(providerCredentials);

    if (providerCredentials.openAiAuthMode === "codex") {
      void refreshCodexLoginStatus();
    }
  }, [
    refreshCodexLoginStatus,
    refreshProviderModels,
    settingsOpen,
    settingsSection,
  ]);

  useEffect(() => {
    if (!settingsOpen || settingsSection !== "providers") {
      setProviderSetupTarget(null);
    }
  }, [settingsOpen, settingsSection]);

  useEffect(() => {
    setSettings((previous) => {
      const safeConnectedProviders = getConnectedProviders(previous);
      const openAiSelectedModels = dedupeModels(previous.openAiSelectedModels);
      const anthropicSelectedModels = dedupeModels(
        previous.anthropicSelectedModels,
      );
      const safeOpenAiSelectedModels = openAiSelectedModels;
      const safeAnthropicSelectedModels = anthropicSelectedModels;
      const defaultOpenAiModel = safeOpenAiSelectedModels.includes(
        previous.defaultOpenAiModel,
      )
        ? previous.defaultOpenAiModel
        : (safeOpenAiSelectedModels[0] ?? "");
      const defaultAnthropicModel = safeAnthropicSelectedModels.includes(
        previous.defaultAnthropicModel,
      )
        ? previous.defaultAnthropicModel
        : (safeAnthropicSelectedModels[0] ?? "");

      if (
        safeConnectedProviders.length === previous.connectedProviders.length &&
        safeConnectedProviders.every(
          (provider, index) => previous.connectedProviders[index] === provider,
        ) &&
        defaultOpenAiModel === previous.defaultOpenAiModel &&
        defaultAnthropicModel === previous.defaultAnthropicModel &&
        safeOpenAiSelectedModels.length ===
          previous.openAiSelectedModels.length &&
        safeAnthropicSelectedModels.length ===
          previous.anthropicSelectedModels.length &&
        safeOpenAiSelectedModels.every(
          (model, index) => previous.openAiSelectedModels[index] === model,
        ) &&
        safeAnthropicSelectedModels.every(
          (model, index) => previous.anthropicSelectedModels[index] === model,
        )
      ) {
        return previous;
      }

      return {
        ...previous,
        anthropicSelectedModels: safeAnthropicSelectedModels,
        connectedProviders: safeConnectedProviders,
        defaultAnthropicModel,
        defaultOpenAiModel,
        openAiSelectedModels: safeOpenAiSelectedModels,
      };
    });

    setProjects((previous) => {
      let changed = false;
      const fallbackProvider = connectedProviders[0] ?? null;
      const next = previous.map((project) => {
        let nextProject = project;

        if (
          !connectedProviders.includes(nextProject.provider) &&
          fallbackProvider
        ) {
          nextProject = {
            ...nextProject,
            model: getDefaultModelForProvider(fallbackProvider, settings),
            provider: fallbackProvider,
          };
          changed = true;
        }

        const providerModelsForProject = getModelsForProvider(
          nextProject.provider,
          settings,
        );
        const fallbackModel = getDefaultModelForProvider(
          nextProject.provider,
          settings,
        );

        if (
          !providerModelsForProject.includes(nextProject.model) &&
          nextProject.model !== fallbackModel
        ) {
          nextProject = {
            ...nextProject,
            model: fallbackModel,
          };
          changed = true;
        }

        return nextProject;
      });

      return changed ? next : previous;
    });
  }, [connectedProviders, settings]);

  const toggleProviderModel = useCallback(
    (provider: AiProvider, model: string) => {
      setSettings((previous) => {
        if (provider === "openai") {
          const current = dedupeModels(previous.openAiSelectedModels);
          const next = current.includes(model)
            ? current.filter((value) => value !== model)
            : [...current, model];

          return {
            ...previous,
            defaultOpenAiModel: next.includes(previous.defaultOpenAiModel)
              ? previous.defaultOpenAiModel
              : (next[0] ?? ""),
            openAiSelectedModels: next,
          };
        }

        const current = dedupeModels(previous.anthropicSelectedModels);
        const next = current.includes(model)
          ? current.filter((value) => value !== model)
          : [...current, model];

        return {
          ...previous,
          anthropicSelectedModels: next,
          defaultAnthropicModel: next.includes(previous.defaultAnthropicModel)
            ? previous.defaultAnthropicModel
            : (next[0] ?? ""),
        };
      });
    },
    [],
  );

  const connectProvider = useCallback((provider: AiProvider) => {
    setSettings((previous) => {
      const currentProviders = getConnectedProviders(previous);
      if (currentProviders.includes(provider)) {
        return previous;
      }

      return {
        ...previous,
        connectedProviders: [...currentProviders, provider],
      };
    });
  }, []);

  const disconnectProvider = useCallback((provider: AiProvider) => {
    setSettings((previous) => {
      const currentProviders = getConnectedProviders(previous);
      if (!currentProviders.includes(provider)) {
        return previous;
      }

      if (provider === "openai") {
        return {
          ...previous,
          connectedProviders: currentProviders.filter(
            (item) => item !== provider,
          ),
          defaultOpenAiModel: "",
          openAiSelectedModels: [],
        };
      }

      return {
        ...previous,
        anthropicSelectedModels: [],
        connectedProviders: currentProviders.filter(
          (item) => item !== provider,
        ),
        defaultAnthropicModel: "",
      };
    });
  }, []);

  const openProviderSetup = useCallback(
    (provider: AiProvider) => {
      setProviderSetupTarget(provider);

      if (provider === "openai" && settings.openAiAuthMode === "codex") {
        void refreshCodexLoginStatus();
      }
    },
    [refreshCodexLoginStatus, settings.openAiAuthMode],
  );

  const submitProviderSetup = useCallback(
    (provider: AiProvider) => {
      connectProvider(provider);
      void refreshProviderModels({
        anthropicApiKey: settings.anthropicApiKey,
        openAiApiKey: settings.openAiApiKey,
        openAiAuthMode: settings.openAiAuthMode,
      });
      setProviderSetupTarget(null);
    },
    [
      connectProvider,
      refreshProviderModels,
      settings.anthropicApiKey,
      settings.openAiApiKey,
      settings.openAiAuthMode,
    ],
  );

  const runLog = activeProject ? (runLogs[activeProject.id] ?? "") : "";
  const activeRunnerStatus = activeProject
    ? (runnerStatus[activeProject.id] ?? "stopped")
    : "stopped";
  const activeTerminalStatus =
    terminalStatus[GLOBAL_TERMINAL_SESSION_ID] ?? "stopped";
  const activeTerminalShell =
    terminalShell[GLOBAL_TERMINAL_SESSION_ID] ||
    settings.shellPath.trim() ||
    "system shell";
  const selectedDefaultOpenAiModel = openAiModels.includes(
    settings.defaultOpenAiModel,
  )
    ? settings.defaultOpenAiModel
    : (openAiModels[0] ?? "");
  const selectedDefaultAnthropicModel = anthropicModels.includes(
    settings.defaultAnthropicModel,
  )
    ? settings.defaultAnthropicModel
    : (anthropicModels[0] ?? "");
  const isOpenAiConnected = connectedProviders.includes("openai");
  const isAnthropicConnected = connectedProviders.includes("anthropic");
  const canConnectOpenAi =
    settings.openAiAuthMode === "codex"
      ? codexLoginStatus.loggedIn
      : settings.openAiApiKey.trim().length > 0;
  const canConnectAnthropic = settings.anthropicApiKey.trim().length > 0;
  const availableOpenAiModels = providerModels.openai.models;
  const availableAnthropicModels = providerModels.anthropic.models;
  const normalizedModelSearchQuery = modelSearchQuery.trim().toLowerCase();
  const filteredOpenAiModels = availableOpenAiModels.filter((model) => {
    return (
      normalizedModelSearchQuery.length === 0 ||
      model.toLowerCase().includes(normalizedModelSearchQuery)
    );
  });
  const filteredAnthropicModels = availableAnthropicModels.filter((model) => {
    return (
      normalizedModelSearchQuery.length === 0 ||
      model.toLowerCase().includes(normalizedModelSearchQuery)
    );
  });
  const isRefreshingProviderModels =
    providerModels.openai.loading || providerModels.anthropic.loading;
  const openTerminalPanel = useCallback(async () => {
    setTerminalPanelOpen(true);

    if (activeTerminalStatus === "running") {
      terminalFitRef.current?.fit();
      terminalRef.current?.focus();
      return;
    }

    await startActiveTerminal();
  }, [activeTerminalStatus, startActiveTerminal]);

  const mainWorkspaceVisible = panelVisibility.middle || panelVisibility.right;

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <header className="relative flex h-11 items-center border-b bg-background px-3 text-foreground [-webkit-app-region:drag]">
        <div className={cn("h-8 shrink-0", isMacOs ? "w-24" : "w-2")} />

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-muted-foreground text-xs tracking-wide">
            DREAM
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1 [-webkit-app-region:no-drag]">
          <ToggleButton
            active={panelVisibility.left}
            onClick={() => togglePanel("left")}
            title="Toggle projects panel"
          >
            <PanelLeft className="size-4" />
          </ToggleButton>
          <ToggleButton
            active={panelVisibility.middle}
            onClick={() => togglePanel("middle")}
            title="Toggle chat panel"
          >
            <MessageSquare className="size-4" />
          </ToggleButton>
          <ToggleButton
            active={panelVisibility.right}
            onClick={() => togglePanel("right")}
            title="Toggle preview panel"
          >
            <PanelRight className="size-4" />
          </ToggleButton>
        </div>
      </header>

      <div className="h-[calc(100vh-44px)] overflow-hidden">
        <Group className="h-full" orientation="horizontal">
          {panelVisibility.left ? (
            <>
              <Panel className="min-w-[230px]" defaultSize={18} minSize={14}>
                <div className="flex h-full flex-col border-r bg-muted/25 p-2">
                  <Button
                    className="w-full justify-start"
                    onClick={handleAddProject}
                  >
                    <FolderPlus className="mr-2 size-4" />
                    Add Project
                  </Button>

                  <ScrollArea className="mt-2 min-h-0 flex-1">
                    <div className="space-y-1 pr-2">
                      {projects.length === 0 ? (
                        <p className="rounded-md border border-dashed p-3 text-muted-foreground text-xs">
                          Add a folder to start working on multiple projects in
                          one workspace.
                        </p>
                      ) : (
                        projects.map((project) => {
                          const isActive = project.id === activeProjectId;

                          return (
                            <div
                              className={cn(
                                "group relative rounded-md border transition-colors",
                                isActive
                                  ? "border-primary/40 bg-primary/10"
                                  : "border-transparent hover:border-border hover:bg-muted",
                              )}
                              key={project.id}
                            >
                              <button
                                className="w-full rounded-[inherit] px-2 py-2 text-left"
                                onClick={() => setActiveProjectId(project.id)}
                                type="button"
                              >
                                <div className="min-w-0 pr-6 text-left">
                                  <p className="truncate font-medium text-sm">
                                    {project.name}
                                  </p>
                                  <p className="truncate text-muted-foreground text-xs">
                                    {project.path}
                                  </p>
                                </div>
                                <div className="mt-1 flex items-center gap-1">
                                  <Badge variant="outline">
                                    {project.provider}
                                  </Badge>
                                  <Badge variant="secondary">
                                    {project.model}
                                  </Badge>
                                </div>
                              </button>
                              <div className="absolute top-2 right-2">
                                <button
                                  aria-label={`Close ${project.name}`}
                                  className="rounded p-0.5 opacity-30 transition-opacity hover:bg-muted hover:opacity-100"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleCloseProject(project.id);
                                  }}
                                  type="button"
                                >
                                  <X className="size-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </ScrollArea>

                  <Button
                    className="mt-2 justify-start"
                    onClick={() => {
                      setSettingsSection("providers");
                      setSettingsOpen(true);
                    }}
                    variant="outline"
                  >
                    <Settings className="mr-2 size-4" />
                    Settings
                  </Button>
                </div>
              </Panel>
              <ResizeHandle className="w-1" />
            </>
          ) : null}

          <Panel defaultSize={panelVisibility.left ? 82 : 100} minSize={20}>
            <Group orientation="horizontal">
              {panelVisibility.middle ? (
                <Panel
                  defaultSize={panelVisibility.right ? 54 : 100}
                  minSize={30}
                >
                  <div className="flex h-full flex-col border-r">
                    <Group className="h-full" orientation="vertical">
                      <Panel
                        defaultSize={terminalPanelOpen ? 74 : 100}
                        minSize={30}
                      >
                        <div className="flex h-full min-h-0 flex-col">
                          <div className="min-h-0 flex-1">
                            {activeProject ? (
                              <ChatPanel
                                chats={chats}
                                onMessagesChange={setMessagesForProject}
                                onProjectChange={updateProject}
                                project={activeProject}
                                settings={settings}
                              />
                            ) : (
                              <div className="h-full p-3">
                                <AppShellPlaceholder message="Select or add a project to start chatting with the AI assistant." />
                              </div>
                            )}
                          </div>

                          {!terminalPanelOpen ? (
                            <div className="flex items-center justify-end border-t px-2 py-1.5">
                              <Button
                                aria-label="Open terminal"
                                className="h-8 w-8"
                                disabled={!activeProject}
                                onClick={() => void openTerminalPanel()}
                                size="icon"
                                title="Open terminal"
                                variant="ghost"
                              >
                                <TerminalSquare className="size-4" />
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      </Panel>

                      {terminalPanelOpen ? (
                        <>
                          <ResizeHandle className="h-1" />
                          <Panel
                            defaultSize={26}
                            minSize={`${TERMINAL_MIN_HEIGHT_PX}px`}
                          >
                            <div
                              className="flex h-full min-h-0 flex-col"
                              style={{ minHeight: TERMINAL_MIN_HEIGHT_PX }}
                            >
                              <div className="flex items-center justify-between px-3 py-2 text-xs">
                                <div className="flex items-center gap-2">
                                  <TerminalSquare className="size-4" />
                                  <span>Terminal</span>
                                  <span className="text-muted-foreground">
                                    {activeTerminalShell}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    aria-label="Close terminal panel"
                                    className="h-7 w-7 p-0"
                                    onClick={() => void closeTerminalPanel()}
                                    size="sm"
                                    variant="ghost"
                                  >
                                    <X className="size-4" />
                                  </Button>
                                </div>
                              </div>
                              <div className="min-h-0 flex-1 bg-background p-2">
                                <div
                                  className="h-full w-full"
                                  ref={setTerminalHost}
                                />
                              </div>
                            </div>
                          </Panel>
                        </>
                      ) : null}
                    </Group>
                  </div>
                </Panel>
              ) : null}

              {panelVisibility.middle && panelVisibility.right ? (
                <ResizeHandle className="w-1" />
              ) : null}

              {panelVisibility.right ? (
                <Panel
                  defaultSize={panelVisibility.middle ? 46 : 100}
                  minSize={26}
                >
                  <div className="flex h-full flex-col">
                    <div className="border-b px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          className="h-8"
                          disabled={!activeProject}
                          onClick={
                            activeRunnerStatus === "running"
                              ? stopRunner
                              : startRunner
                          }
                          size="sm"
                          variant={
                            activeRunnerStatus === "running"
                              ? "secondary"
                              : "default"
                          }
                        >
                          {activeRunnerStatus === "running" ? (
                            <>
                              <Square className="mr-1.5 size-3.5" />
                              Stop
                            </>
                          ) : (
                            <>
                              <Play className="mr-1.5 size-3.5" />
                              Run
                            </>
                          )}
                        </Button>
                        <Button
                          aria-label="Show output"
                          className="h-8 w-8"
                          disabled={outputPanelOpen}
                          onClick={() => setOutputPanelOpen(true)}
                          size="icon"
                          title="Show output"
                          variant="ghost"
                        >
                          <Logs className="size-4" />
                        </Button>

                        {activeProject ? (
                          <>
                            <Input
                              className="h-8 min-w-52 flex-1 text-xs"
                              onChange={(event) => {
                                const value = event.currentTarget.value;
                                updateProject(activeProject.id, (project) => ({
                                  ...project,
                                  runCommand: value,
                                }));
                              }}
                              value={activeProject.runCommand}
                            />
                            <Input
                              className="h-8 min-w-52 flex-1 text-xs"
                              onChange={(event) => {
                                const value = event.currentTarget.value;
                                updateProject(activeProject.id, (project) => ({
                                  ...project,
                                  previewUrl: value,
                                }));
                              }}
                              value={activeProject.previewUrl}
                            />
                            <Button
                              className="h-8"
                              onClick={() => {
                                setPreviewError(null);
                                syncPreviewBounds();
                              }}
                              size="icon"
                              variant="outline"
                            >
                              <RefreshCcw className="size-4" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <Group className="min-h-0 flex-1" orientation="vertical">
                      <Panel
                        defaultSize={outputPanelOpen ? 74 : 100}
                        minSize={30}
                      >
                        <div className="relative h-full bg-muted/20">
                          <div
                            className="absolute inset-0"
                            ref={previewHostRef}
                          />
                          {!activeProject ||
                          activeRunnerStatus !== "running" ? (
                            <div className="absolute inset-0 p-3">
                              <AppShellPlaceholder
                                message={
                                  !activeProject
                                    ? "Add a project and click Run to start a live preview."
                                    : "Preview will appear here after you click Run."
                                }
                              />
                            </div>
                          ) : null}
                          {previewError ? (
                            <div className="absolute right-3 bottom-3 left-3 rounded-md border border-destructive/40 bg-background/95 p-2 text-destructive text-xs">
                              <div className="mb-1 flex items-center gap-1.5">
                                <AlertCircle className="size-3.5" />
                                Preview error
                              </div>
                              <p className="break-all">{previewError}</p>
                            </div>
                          ) : null}
                        </div>
                      </Panel>

                      {outputPanelOpen ? (
                        <>
                          <ResizeHandle className="h-1" />
                          <Panel
                            defaultSize={26}
                            minSize={`${TERMINAL_MIN_HEIGHT_PX}px`}
                          >
                            <div
                              className="flex h-full min-h-0 flex-col"
                              style={{ minHeight: TERMINAL_MIN_HEIGHT_PX }}
                            >
                              <div className="flex items-center justify-between px-3 py-2 text-xs">
                                <div className="flex items-center gap-2">
                                  <Logs className="size-4" />
                                  <span>Run output</span>
                                </div>
                                <Button
                                  aria-label="Close output panel"
                                  className="h-7 w-7 p-0"
                                  onClick={() => setOutputPanelOpen(false)}
                                  size="sm"
                                  variant="ghost"
                                >
                                  <X className="size-4" />
                                </Button>
                              </div>
                              <ScrollArea className="min-h-0 flex-1 px-3 py-2">
                                <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5">
                                  {activeProject
                                    ? runLog ||
                                      "Run output will stream here after you start the project."
                                    : "Select a project to view its run output."}
                                </pre>
                              </ScrollArea>
                            </div>
                          </Panel>
                        </>
                      ) : null}
                    </Group>
                  </div>
                </Panel>
              ) : null}

              {!mainWorkspaceVisible ? (
                <Panel defaultSize={100} minSize={20}>
                  <AppShellPlaceholder message="Enable the chat or preview panel from the top-right controls." />
                </Panel>
              ) : null}
            </Group>
          </Panel>
        </Group>
      </div>

      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent className="!flex h-[min(86vh,780px)] w-[95vw] max-w-[1320px] !flex-col gap-0 overflow-hidden p-0 sm:max-w-[1320px]">
          <DialogHeader className="border-b px-6 py-3 text-left">
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>

          <div className="flex min-h-0 flex-1">
            <nav className="w-64 shrink-0 border-r bg-muted/25 p-3">
              <div className="space-y-1">
                <button
                  className={cn(
                    "w-full rounded-md px-3 py-2 text-left font-medium text-sm transition-colors",
                    settingsSection === "providers"
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                  onClick={() => setSettingsSection("providers")}
                  type="button"
                >
                  Providers
                </button>
                <button
                  className={cn(
                    "w-full rounded-md px-3 py-2 text-left font-medium text-sm transition-colors",
                    settingsSection === "models"
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                  onClick={() => setSettingsSection("models")}
                  type="button"
                >
                  Models
                </button>
                <button
                  className={cn(
                    "w-full rounded-md px-3 py-2 text-left font-medium text-sm transition-colors",
                    settingsSection === "terminal"
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                  onClick={() => setSettingsSection("terminal")}
                  type="button"
                >
                  Terminal
                </button>
              </div>
            </nav>

            <ScrollArea className="min-w-0 flex-1">
              <div className="space-y-4 p-5">
                {settingsSection === "providers" ? (
                  providerSetupTarget ? (
                    <div className="rounded-xl border bg-background p-5 sm:p-6">
                      <div className="mb-6 flex items-center justify-between">
                        <Button
                          className="h-9 w-9"
                          onClick={() => setProviderSetupTarget(null)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <ArrowLeft className="size-4" />
                        </Button>
                        <Button
                          className="h-9 w-9"
                          onClick={() => setSettingsOpen(false)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <X className="size-4" />
                        </Button>
                      </div>

                      {providerSetupTarget === "openai" ? (
                        <div className="mx-auto max-w-3xl space-y-5">
                          <div className="space-y-2">
                            <h3 className="font-semibold text-2xl">
                              Connect OpenAI
                            </h3>
                            <p className="text-muted-foreground">
                              OpenAI gives you access to GPT and Codex model
                              families for coding and general chat.
                            </p>
                          </div>

                          <div className="space-y-1.5">
                            <Label htmlFor="openai-auth-mode">
                              Authentication Method
                            </Label>
                            <Select
                              onValueChange={(value) => {
                                const nextMode = value as "apiKey" | "codex";

                                setSettings((previous) => ({
                                  ...previous,
                                  defaultOpenAiModel: "",
                                  openAiAuthMode: nextMode,
                                  openAiSelectedModels: [],
                                }));

                                setProviderModels((previous) => ({
                                  ...previous,
                                  openai: {
                                    ...previous.openai,
                                    error: null,
                                    models: [],
                                    source: "unavailable",
                                  },
                                }));

                                void refreshProviderModels({
                                  anthropicApiKey: settings.anthropicApiKey,
                                  openAiApiKey: settings.openAiApiKey,
                                  openAiAuthMode: nextMode,
                                });

                                if (nextMode === "codex") {
                                  void refreshCodexLoginStatus();
                                }
                              }}
                              value={settings.openAiAuthMode}
                            >
                              <SelectTrigger id="openai-auth-mode">
                                <SelectValue placeholder="Select method" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="apiKey">API Key</SelectItem>
                                <SelectItem value="codex">
                                  Codex Login
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          {settings.openAiAuthMode === "apiKey" ? (
                            <div className="space-y-1.5">
                              <Label htmlFor="openai-key">OpenAI API Key</Label>
                              <Input
                                id="openai-key"
                                onChange={(event) =>
                                  setSettings((previous) => ({
                                    ...previous,
                                    openAiApiKey: event.currentTarget.value,
                                  }))
                                }
                                placeholder="sk-..."
                                type="password"
                                value={settings.openAiApiKey}
                              />
                            </div>
                          ) : (
                            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                              <p className="font-medium text-sm">Codex Login</p>
                              <p className="text-muted-foreground text-xs">
                                Uses your local Codex session from{" "}
                                <code>~/.codex/auth.json</code>.
                              </p>
                              <p
                                className={cn(
                                  "text-xs",
                                  codexLoginStatus.loggedIn
                                    ? "text-emerald-700"
                                    : "text-amber-700",
                                )}
                              >
                                {codexLoginStatus.loading
                                  ? "Checking status..."
                                  : codexLoginStatus.message}
                              </p>
                              <div className="flex items-center gap-2">
                                <Button
                                  className="h-8"
                                  onClick={() => void refreshCodexLoginStatus()}
                                  size="sm"
                                  type="button"
                                  variant="outline"
                                >
                                  Refresh Status
                                </Button>
                                <Button
                                  className="h-8 px-0 text-xs"
                                  onClick={() =>
                                    openExternalUrl("https://chatgpt.com")
                                  }
                                  size="sm"
                                  type="button"
                                  variant="link"
                                >
                                  Open ChatGPT
                                </Button>
                              </div>
                              <Button
                                className="h-7 px-0 text-xs"
                                onClick={() =>
                                  openExternalUrl(
                                    "https://platform.openai.com/docs/codex/overview",
                                  )
                                }
                                type="button"
                                variant="link"
                              >
                                Run `codex login` in terminal if needed
                              </Button>
                            </div>
                          )}

                          {providerModels.openai.error ? (
                            <p className="text-amber-700 text-xs">
                              {providerModels.openai.error}
                            </p>
                          ) : null}

                          {!canConnectOpenAi ? (
                            <p className="text-muted-foreground text-xs">
                              {settings.openAiAuthMode === "codex"
                                ? "Run `codex login` and refresh status before connecting."
                                : "Add an OpenAI API key before connecting."}
                            </p>
                          ) : null}

                          <div className="flex items-center gap-2 pt-1">
                            <Button
                              disabled={!canConnectOpenAi}
                              onClick={() => submitProviderSetup("openai")}
                              type="button"
                            >
                              {isOpenAiConnected ? "Save" : "Connect"}
                            </Button>
                            {isOpenAiConnected ? (
                              <Button
                                onClick={() => {
                                  disconnectProvider("openai");
                                  setProviderSetupTarget(null);
                                }}
                                type="button"
                                variant="outline"
                              >
                                Disconnect
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {providerSetupTarget === "anthropic" ? (
                        <div className="mx-auto max-w-3xl space-y-5">
                          <div className="space-y-2">
                            <h3 className="font-semibold text-2xl">
                              Connect Anthropic
                            </h3>
                            <p className="text-muted-foreground">
                              Anthropic gives you access to Claude models for
                              coding, analysis, and long-context reasoning.
                            </p>
                          </div>

                          <div className="space-y-1.5">
                            <Label htmlFor="anthropic-key">
                              Anthropic API Key
                            </Label>
                            <Input
                              id="anthropic-key"
                              onChange={(event) =>
                                setSettings((previous) => ({
                                  ...previous,
                                  anthropicApiKey: event.currentTarget.value,
                                }))
                              }
                              placeholder="sk-ant-..."
                              type="password"
                              value={settings.anthropicApiKey}
                            />
                          </div>

                          {providerModels.anthropic.error ? (
                            <p className="text-amber-700 text-xs">
                              {providerModels.anthropic.error}
                            </p>
                          ) : null}

                          {!canConnectAnthropic ? (
                            <p className="text-muted-foreground text-xs">
                              Add an Anthropic API key before connecting.
                            </p>
                          ) : null}

                          <div className="flex items-center gap-2 pt-1">
                            <Button
                              disabled={!canConnectAnthropic}
                              onClick={() => submitProviderSetup("anthropic")}
                              type="button"
                            >
                              {isAnthropicConnected ? "Save" : "Connect"}
                            </Button>
                            {isAnthropicConnected ? (
                              <Button
                                onClick={() => {
                                  disconnectProvider("anthropic");
                                  setProviderSetupTarget(null);
                                }}
                                type="button"
                                variant="outline"
                              >
                                Disconnect
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2">
                        <p className="text-muted-foreground text-xs">
                          {providerModels.fetchedAt
                            ? `Last refreshed ${new Date(providerModels.fetchedAt).toLocaleString()}`
                            : "Model lists will refresh when this panel opens."}
                        </p>
                        <Button
                          className="h-7 px-2 text-xs"
                          disabled={isRefreshingProviderModels}
                          onClick={() =>
                            void refreshProviderModels({
                              anthropicApiKey: settings.anthropicApiKey,
                              openAiApiKey: settings.openAiApiKey,
                              openAiAuthMode: settings.openAiAuthMode,
                            })
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {isRefreshingProviderModels
                            ? "Refreshing..."
                            : "Refresh Models"}
                        </Button>
                      </div>

                      <div className="space-y-2 rounded-lg border p-3">
                        <div className="flex items-center justify-between">
                          <p className="font-medium text-sm">
                            Connected providers
                          </p>
                          <Badge variant="outline">
                            {connectedProviders.length}
                          </Badge>
                        </div>
                        {connectedProviders.length === 0 ? (
                          <p className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs">
                            Connect at least one provider before enabling
                            models.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {ALL_PROVIDERS.filter((provider) =>
                              connectedProviders.includes(provider),
                            ).map((provider) => (
                              <div
                                className="flex items-center justify-between rounded-md border px-3 py-2"
                                key={provider}
                              >
                                <div>
                                  <p className="font-medium text-sm">
                                    {getProviderLabel(provider)}
                                  </p>
                                  <p className="text-muted-foreground text-xs">
                                    {provider === "openai"
                                      ? `${openAiModels.length} models enabled`
                                      : `${anthropicModels.length} models enabled`}
                                  </p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    className="h-7 px-2 text-xs"
                                    onClick={() => openProviderSetup(provider)}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    Manage
                                  </Button>
                                  <Button
                                    className="h-7 px-2 text-xs"
                                    onClick={() => disconnectProvider(provider)}
                                    size="sm"
                                    type="button"
                                    variant="ghost"
                                  >
                                    Disconnect
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="space-y-2 rounded-lg border p-3">
                        <p className="font-medium text-sm">Popular providers</p>
                        <div className="space-y-2">
                          {ALL_PROVIDERS.map((provider) => {
                            const isConnected =
                              connectedProviders.includes(provider);

                            return (
                              <div
                                className="flex items-center justify-between rounded-md border px-3 py-2"
                                key={provider}
                              >
                                <div className="pr-3">
                                  <p className="font-medium text-sm">
                                    {getProviderLabel(provider)}
                                  </p>
                                  <p className="text-muted-foreground text-xs">
                                    {getProviderDescription(provider)}
                                  </p>
                                </div>
                                <Button
                                  className="h-7 px-2 text-xs"
                                  onClick={() => openProviderSetup(provider)}
                                  size="sm"
                                  type="button"
                                  variant={isConnected ? "outline" : "default"}
                                >
                                  {isConnected ? "Manage" : "Connect"}
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )
                ) : null}

                {settingsSection === "models" ? (
                  <>
                    <div className="space-y-2 rounded-lg border bg-muted/20 px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-muted-foreground text-xs">
                          {providerModels.fetchedAt
                            ? `Last refreshed ${new Date(providerModels.fetchedAt).toLocaleString()}`
                            : "Model lists will refresh when this panel opens."}
                        </p>
                        <Button
                          className="h-7 px-2 text-xs"
                          disabled={isRefreshingProviderModels}
                          onClick={() =>
                            void refreshProviderModels({
                              anthropicApiKey: settings.anthropicApiKey,
                              openAiApiKey: settings.openAiApiKey,
                              openAiAuthMode: settings.openAiAuthMode,
                            })
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {isRefreshingProviderModels
                            ? "Refreshing..."
                            : "Refresh Models"}
                        </Button>
                      </div>
                      <Input
                        onChange={(event) =>
                          setModelSearchQuery(event.currentTarget.value)
                        }
                        placeholder="Search models"
                        value={modelSearchQuery}
                      />
                    </div>

                    {connectedProviders.length === 0 ? (
                      <p className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs">
                        Connect a provider first in the Providers section.
                      </p>
                    ) : null}

                    {connectedProviders.length > 0 && isOpenAiConnected ? (
                      <div className="space-y-3 rounded-lg border p-3">
                        <div className="flex items-center justify-between">
                          <p className="font-medium text-sm">OpenAI</p>
                          <Badge variant="outline">
                            {providerModels.openai.source === "api"
                              ? "Live list"
                              : "Unavailable"}
                          </Badge>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Enabled OpenAI Models</Label>
                          <p className="text-muted-foreground text-xs">
                            Only enabled models appear in project chat.
                          </p>
                          <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-1.5">
                            {availableOpenAiModels.length === 0 ? (
                              <p className="px-2 py-1.5 text-muted-foreground text-xs">
                                No live models available yet. Refresh after
                                connecting.
                              </p>
                            ) : filteredOpenAiModels.length === 0 ? (
                              <p className="px-2 py-1.5 text-muted-foreground text-xs">
                                No models match this search.
                              </p>
                            ) : (
                              filteredOpenAiModels.map((model) => {
                                const isSelected = openAiModels.includes(model);

                                return (
                                  <div
                                    className={cn(
                                      "flex items-center justify-between rounded-md border px-2 py-1.5",
                                      isSelected ? "border-primary/40" : "",
                                    )}
                                    key={model}
                                  >
                                    <Label className="truncate text-xs">
                                      {model}
                                    </Label>
                                    <Switch
                                      checked={isSelected}
                                      onCheckedChange={(checked) => {
                                        if (checked === isSelected) {
                                          return;
                                        }
                                        toggleProviderModel("openai", model);
                                      }}
                                    />
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="openai-model">
                            Default OpenAI Model
                          </Label>
                          <Select
                            onValueChange={(value) =>
                              setSettings((previous) => ({
                                ...previous,
                                defaultOpenAiModel: value,
                              }))
                            }
                            value={selectedDefaultOpenAiModel || undefined}
                          >
                            <SelectTrigger
                              disabled={openAiModels.length === 0}
                              id="openai-model"
                            >
                              <SelectValue placeholder="Select model" />
                            </SelectTrigger>
                            <SelectContent>
                              {openAiModels.map((model) => (
                                <SelectItem key={model} value={model}>
                                  {model}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    ) : null}

                    {connectedProviders.length > 0 && isAnthropicConnected ? (
                      <div className="space-y-3 rounded-lg border p-3">
                        <div className="flex items-center justify-between">
                          <p className="font-medium text-sm">Anthropic</p>
                          <Badge variant="outline">
                            {providerModels.anthropic.source === "api"
                              ? "Live list"
                              : "Unavailable"}
                          </Badge>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Enabled Anthropic Models</Label>
                          <p className="text-muted-foreground text-xs">
                            Only enabled models appear in project chat.
                          </p>
                          <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-1.5">
                            {availableAnthropicModels.length === 0 ? (
                              <p className="px-2 py-1.5 text-muted-foreground text-xs">
                                No live models available yet. Refresh after
                                connecting.
                              </p>
                            ) : filteredAnthropicModels.length === 0 ? (
                              <p className="px-2 py-1.5 text-muted-foreground text-xs">
                                No models match this search.
                              </p>
                            ) : (
                              filteredAnthropicModels.map((model) => {
                                const isSelected =
                                  anthropicModels.includes(model);

                                return (
                                  <div
                                    className={cn(
                                      "flex items-center justify-between rounded-md border px-2 py-1.5",
                                      isSelected ? "border-primary/40" : "",
                                    )}
                                    key={model}
                                  >
                                    <Label className="truncate text-xs">
                                      {model}
                                    </Label>
                                    <Switch
                                      checked={isSelected}
                                      onCheckedChange={(checked) => {
                                        if (checked === isSelected) {
                                          return;
                                        }
                                        toggleProviderModel("anthropic", model);
                                      }}
                                    />
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="anthropic-model">
                            Default Anthropic Model
                          </Label>
                          <Select
                            onValueChange={(value) =>
                              setSettings((previous) => ({
                                ...previous,
                                defaultAnthropicModel: value,
                              }))
                            }
                            value={selectedDefaultAnthropicModel || undefined}
                          >
                            <SelectTrigger
                              disabled={anthropicModels.length === 0}
                              id="anthropic-model"
                            >
                              <SelectValue placeholder="Select model" />
                            </SelectTrigger>
                            <SelectContent>
                              {anthropicModels.map((model) => (
                                <SelectItem key={model} value={model}>
                                  {model}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}

                {settingsSection === "terminal" ? (
                  <div className="space-y-1.5 rounded-lg border p-3">
                    <Label htmlFor="shell-path">Terminal Shell Path</Label>
                    <Input
                      id="shell-path"
                      onChange={(event) =>
                        setSettings((previous) => ({
                          ...previous,
                          shellPath: event.currentTarget.value,
                        }))
                      }
                      placeholder="/bin/zsh"
                      value={settings.shellPath}
                    />
                    <p className="text-muted-foreground text-xs">
                      Leave empty to use the system default shell.
                    </p>
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
