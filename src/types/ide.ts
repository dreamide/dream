import type { UIMessage } from "ai";

export type AiProvider = "openai" | "anthropic" | "gemini";
export type OpenAiAuthMode = "apiKey" | "codex";
export type AnthropicAuthMode = "apiKey" | "claudeCode";
export type GeminiAuthMode = "apiKey";
export type ProviderAuthMode =
  | OpenAiAuthMode
  | AnthropicAuthMode
  | GeminiAuthMode;
export type BaseColor = "neutral" | "gray" | "zinc" | "stone" | "slate";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ChatMode = "plan" | "build";
export type ThreadSortOrder =
  | "recent"
  | "createdDesc"
  | "createdAsc"
  | "titleAsc";

export interface ThreadConfig {
  id: string;
  projectId: string;
  title: string;
  provider: AiProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  chatMode: ChatMode;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  remoteConversationId: string | null;
}

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  runCommand: string;
  previewUrl: string;
  provider: AiProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface AppSettings {
  connectedProviders: AiProvider[];
  openAiAuthMode: OpenAiAuthMode;
  openAiApiKey: string;
  anthropicAuthMode: AnthropicAuthMode;
  anthropicApiKey: string;
  anthropicAccessToken: string;
  anthropicRefreshToken: string;
  anthropicAccessTokenExpiresAt: number | null;
  geminiApiKey: string;
  defaultModel: string;
  openAiSelectedModels: string[];
  anthropicSelectedModels: string[];
  geminiSelectedModels: string[];
  shellPath: string;
}

export interface PanelVisibility {
  left: boolean;
  middle: boolean;
  right: boolean;
}

export interface PersistedIdeState {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  panelVisibility: PanelVisibility;
  settings: AppSettings;
  threads: ThreadConfig[];
  activeThreadIdByProject: Record<string, string | null>;
  threadSort: ThreadSortOrder;
  chats: Record<string, UIMessage[]>;
}

export interface TerminalDataEvent {
  projectId: string;
  chunk: string;
}

export interface TerminalStatusEvent {
  projectId: string;
  status: "running" | "stopped";
  transport?: "pty" | "pipe";
  shell?: string;
  pid?: number;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewErrorEvent {
  code: number | string;
  description: string;
}

export interface PreviewStatusEvent {
  loading: boolean;
  projectId: string;
  tabId?: string;
}

export interface PreviewTabState {
  canGoBack: boolean;
  canGoForward: boolean;
  id: string;
  title: string;
  url: string;
}

export interface PreviewPageStateEvent {
  canGoBack: boolean;
  canGoForward: boolean;
  projectId: string;
  tabId: string;
  title: string;
  url: string;
}

export type ProjectGitChangeStatus =
  | "modified"
  | "added"
  | "renamed"
  | "copied"
  | "deleted"
  | "untracked";

export interface ProjectGitStatusEntry {
  path: string;
  previousPath: string | null;
  status: ProjectGitChangeStatus;
}

export interface ProjectGitStatusResponse {
  branch: string | null;
  changes: ProjectGitStatusEntry[];
  isRepo: boolean;
  repoRoot: string | null;
}

export interface ProjectGitDiffResponse {
  branch: string | null;
  diff: string;
  filePath: string;
  previousPath: string | null;
  status: ProjectGitChangeStatus;
}

export interface StartTerminalPayload {
  projectId: string;
  cwd: string;
  command?: string;
  shellPath?: string;
}

export interface TerminalInputPayload {
  projectId: string;
  data: string;
}

export interface PreviewUpdatePayload {
  bounds?: PreviewBounds;
  goBack?: boolean;
  goForward?: boolean;
  projectId?: string;
  tabId?: string;
  reload?: boolean;
  stop?: boolean;
  visible?: boolean;
  url?: string;
  destroyTab?: string;
}

export interface DreamDesktopApi {
  isElectron: true;

  openExternal: (url: string) => Promise<boolean>;

  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;

  pickProjectDirectory: () => Promise<string | null>;

  loadState: () => Promise<Partial<PersistedIdeState>>;
  saveState: (state: PersistedIdeState) => Promise<boolean>;

  startTerminal: (payload: StartTerminalPayload) => Promise<{
    status: string;
    pid?: number;
    transport?: "pty" | "pipe";
    shell?: string;
  }>;
  sendTerminalInput: (payload: TerminalInputPayload) => void;
  stopTerminal: (projectId: string) => Promise<boolean>;
  onTerminalData: (listener: (event: TerminalDataEvent) => void) => () => void;
  onTerminalStatus: (
    listener: (event: TerminalStatusEvent) => void,
  ) => () => void;

  updatePreview: (payload: PreviewUpdatePayload) => void;
  onPreviewError: (listener: (event: PreviewErrorEvent) => void) => () => void;
  onPreviewPageState: (
    listener: (event: PreviewPageStateEvent) => void,
  ) => () => void;
  onPreviewStatus: (
    listener: (event: PreviewStatusEvent) => void,
  ) => () => void;

  detectEditors: () => Promise<DetectedEditor[]>;
  openInEditor: (payload: {
    projectPath: string;
    editorId: string;
  }) => Promise<boolean>;
}

export interface DetectedEditor {
  id: string;
  name: string;
  executable: string;
  isFileExplorer: boolean;
  isTerminal: boolean;
}
