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
  FolderPlus,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getDesktopApi } from "@/lib/electron";
import {
  createProjectConfig,
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_SETTINGS,
  getDefaultModelForProvider,
  getModelsForProvider,
  getOpenAiModelsForAuthMode,
  getProviderAuthMode,
  getProviderCredential,
} from "@/lib/ide-defaults";
import { cn } from "@/lib/utils";
import type {
  AiProvider,
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

type MiddleTab = "chat" | "terminal";
type RightTab = "preview" | "output";
type SettingsSection = "providers" | "terminal";

type RunnerStatus = "running" | "stopped";

type TerminalStatus = "running" | "stopped";
type TerminalTransport = "pty" | "pipe";

const GLOBAL_TERMINAL_SESSION_ID = "__global_terminal__";

interface CodexLoginStatus {
  authMode: string;
  loading: boolean;
  loggedIn: boolean;
  message: string;
}

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
  const mergedSettings = {
    ...DEFAULT_SETTINGS,
    ...(state.settings ?? {}),
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

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      setLocalError(null);

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
            model: project.model,
            projectPath: project.path,
            provider: project.provider,
          },
        },
      );
    },
    [
      credentialLabel,
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

  const models = getModelsForProvider(project.provider, settings);
  const selectedModel = models.includes(project.model)
    ? project.model
    : models[0];

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
          className="w-full rounded-2xl border bg-background px-2 pt-2 pb-1"
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
                value={project.provider}
              >
                <PromptInputSelectTrigger className="h-8 min-w-[110px] px-2 text-xs">
                  <PromptInputSelectValue placeholder="Provider" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  <PromptInputSelectItem value="openai">
                    OpenAI
                  </PromptInputSelectItem>
                  <PromptInputSelectItem value="anthropic">
                    Anthropic
                  </PromptInputSelectItem>
                </PromptInputSelectContent>
              </PromptInputSelect>

              <PromptInputSelect
                onValueChange={(value) => {
                  onProjectChange(project.id, (current) => ({
                    ...current,
                    model: value,
                  }));
                }}
                value={selectedModel}
              >
                <PromptInputSelectTrigger className="h-8 min-w-[180px] max-w-[260px] px-2 text-xs">
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
              disabled={!providerCredential && !usesCodexLogin}
              onStop={stop}
              status={status}
            />
          </PromptInputFooter>
        </PromptInput>

        <div className="mt-2 flex items-center gap-2">
          {!providerCredential && !usesCodexLogin ? (
            <Badge variant="destructive">Missing {credentialLabel}</Badge>
          ) : usesCodexLogin ? (
            <Badge variant="secondary">Using Codex Login</Badge>
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
  const [terminalTransport, setTerminalTransport] = useState<
    Record<string, TerminalTransport>
  >({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("providers");
  const [codexLoginStatus, setCodexLoginStatus] = useState<CodexLoginStatus>({
    authMode: "unknown",
    loading: false,
    loggedIn: false,
    message: "",
  });
  const [middleTab, setMiddleTab] = useState<MiddleTab>("chat");
  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [stateHydrated, setStateHydrated] = useState(false);

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
        setTerminalTransport((previous) => ({
          ...previous,
          [event.projectId]: transport,
        }));
      }

      setTerminalStatus((previous) => ({
        ...previous,
        [event.projectId]: event.status,
      }));
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
      rightTab !== "preview" ||
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
  }, [activeProject, panelVisibility.right, rightTab, runnerStatus]);

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
    if (!panelVisibility.middle || middleTab !== "terminal") {
      return;
    }

    terminalFitRef.current?.fit();
    terminalRef.current?.focus();
  }, [middleTab, panelVisibility.middle]);

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

  useEffect(() => {
    if (
      !settingsOpen ||
      settingsSection !== "providers" ||
      settings.openAiAuthMode !== "codex"
    ) {
      return;
    }

    void refreshCodexLoginStatus();
  }, [
    refreshCodexLoginStatus,
    settings.openAiAuthMode,
    settingsOpen,
    settingsSection,
  ]);

  useEffect(() => {
    const openAiModels = getOpenAiModelsForAuthMode(settings.openAiAuthMode);
    const fallbackModel = openAiModels[0];

    if (!openAiModels.includes(settings.defaultOpenAiModel)) {
      setSettings((previous) => ({
        ...previous,
        defaultOpenAiModel: fallbackModel,
      }));
    }

    setProjects((previous) => {
      let changed = false;
      const next = previous.map((project) => {
        if (
          project.provider !== "openai" ||
          openAiModels.includes(project.model)
        ) {
          return project;
        }

        changed = true;
        return {
          ...project,
          model: fallbackModel,
        };
      });

      return changed ? next : previous;
    });
  }, [settings.defaultOpenAiModel, settings.openAiAuthMode]);

  const runLog = activeProject ? (runLogs[activeProject.id] ?? "") : "";
  const activeRunnerStatus = activeProject
    ? (runnerStatus[activeProject.id] ?? "stopped")
    : "stopped";
  const activeTerminalStatus =
    terminalStatus[GLOBAL_TERMINAL_SESSION_ID] ?? "stopped";
  const activeTerminalTransport =
    terminalTransport[GLOBAL_TERMINAL_SESSION_ID] ?? "pty";
  const openAiModels = getOpenAiModelsForAuthMode(settings.openAiAuthMode);
  const selectedDefaultOpenAiModel = openAiModels.includes(
    settings.defaultOpenAiModel,
  )
    ? settings.defaultOpenAiModel
    : openAiModels[0];

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
                  <Tabs
                    className="flex h-full flex-col gap-0 border-r"
                    onValueChange={(value) => setMiddleTab(value as MiddleTab)}
                    value={middleTab}
                  >
                    <div className="border-b px-3 py-2">
                      <TabsList>
                        <TabsTrigger value="chat">Chat</TabsTrigger>
                        <TabsTrigger value="terminal">Terminal</TabsTrigger>
                      </TabsList>
                    </div>

                    <TabsContent
                      className={cn(
                        "mt-0 min-h-0 flex-1",
                        middleTab !== "chat" ? "hidden" : "",
                      )}
                      forceMount
                      value="chat"
                    >
                      {activeProject ? (
                        <ChatPanel
                          chats={chats}
                          onMessagesChange={setMessagesForProject}
                          onProjectChange={updateProject}
                          project={activeProject}
                          settings={settings}
                        />
                      ) : (
                        <AppShellPlaceholder message="Select or add a project to start chatting with the AI assistant." />
                      )}
                    </TabsContent>

                    <TabsContent
                      className={cn(
                        "mt-0 min-h-0 flex-1",
                        middleTab !== "terminal" ? "hidden" : "",
                      )}
                      forceMount
                      value="terminal"
                    >
                      <div className="flex h-full flex-col">
                        <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
                          <div className="flex items-center gap-2">
                            <TerminalSquare className="size-4" />
                            <span>Workspace terminal</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              className="h-7 gap-1 px-2 text-xs"
                              disabled={!activeProject}
                              onClick={() => void startActiveTerminal()}
                              size="sm"
                              variant="outline"
                            >
                              <Play className="size-3.5" />
                              New
                            </Button>
                            <Button
                              className="h-7 gap-1 px-2 text-xs"
                              disabled={activeTerminalStatus !== "running"}
                              onClick={() => void stopActiveTerminal()}
                              size="sm"
                              variant="outline"
                            >
                              <Square className="size-3.5" />
                              Stop
                            </Button>
                            <Badge variant="outline">
                              {activeTerminalStatus}
                            </Badge>
                            {activeTerminalTransport === "pipe" ? (
                              <Badge variant="secondary">pipe fallback</Badge>
                            ) : null}
                          </div>
                        </div>
                        <div className="min-h-0 flex-1 bg-background p-2">
                          <div
                            className="h-full w-full"
                            ref={setTerminalHost}
                          />
                        </div>
                      </div>
                    </TabsContent>
                  </Tabs>
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
                  <Tabs
                    className="flex h-full flex-col gap-0"
                    onValueChange={(value) => setRightTab(value as RightTab)}
                    value={rightTab}
                  >
                    <div className="border-b px-3 py-2">
                      <div className="mb-2">
                        <TabsList>
                          <TabsTrigger value="preview">Preview</TabsTrigger>
                          <TabsTrigger value="output">Output</TabsTrigger>
                        </TabsList>
                      </div>
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

                    <TabsContent
                      className={cn(
                        "mt-0 min-h-0 flex-1",
                        rightTab !== "preview" ? "hidden" : "",
                      )}
                      forceMount
                      value="preview"
                    >
                      <div className="relative h-full bg-muted/20">
                        <div
                          className="absolute inset-0"
                          ref={previewHostRef}
                        />
                        {!activeProject || activeRunnerStatus !== "running" ? (
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
                    </TabsContent>

                    <TabsContent
                      className={cn(
                        "mt-0 min-h-0 flex-1",
                        rightTab !== "output" ? "hidden" : "",
                      )}
                      forceMount
                      value="output"
                    >
                      <ScrollArea className="h-full px-3 py-2">
                        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5">
                          {activeProject
                            ? runLog ||
                              "Run output will stream here after you start the project."
                            : "Select a project to view its run output."}
                        </pre>
                      </ScrollArea>
                    </TabsContent>
                  </Tabs>
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
                  Provider Accounts
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
                  <>
                    <div className="space-y-3 rounded-lg border p-3">
                      <p className="font-medium text-sm">OpenAI</p>
                      <div className="space-y-1.5">
                        <Label htmlFor="openai-auth-mode">Auth Method</Label>
                        <Select
                          onValueChange={(value) =>
                            setSettings((previous) => ({
                              ...previous,
                              openAiAuthMode: value as "apiKey" | "codex",
                            }))
                          }
                          value={settings.openAiAuthMode}
                        >
                          <SelectTrigger id="openai-auth-mode">
                            <SelectValue placeholder="Select method" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="apiKey">API Key</SelectItem>
                            <SelectItem value="codex">Codex Login</SelectItem>
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
                          value={selectedDefaultOpenAiModel}
                        >
                          <SelectTrigger id="openai-model">
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

                    <div className="space-y-3 rounded-lg border p-3">
                      <p className="font-medium text-sm">Anthropic</p>
                      <div className="space-y-1.5">
                        <Label htmlFor="anthropic-key">Anthropic API Key</Label>
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

                      <div className="space-y-1.5">
                        <Label htmlFor="anthropic-model">
                          Default Anthropic Model
                        </Label>
                        <Input
                          id="anthropic-model"
                          onChange={(event) =>
                            setSettings((previous) => ({
                              ...previous,
                              defaultAnthropicModel: event.currentTarget.value,
                            }))
                          }
                          placeholder="claude-3-7-sonnet-latest"
                          value={settings.defaultAnthropicModel}
                        />
                      </div>
                    </div>
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
