import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { UIMessage } from "ai";

export type AiProvider = "openai" | "anthropic";
export type BaseColor = "neutral" | "gray" | "zinc" | "stone" | "slate";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ChatSortOrder =
  | "recent"
  | "createdDesc"
  | "createdAsc"
  | "titleAsc";

export interface ChatConfig {
  id: string;
  projectId: string;
  title: string;
  provider: AiProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  remoteConversationId: string | null;
  remoteConversationModel: string | null;
  remoteConversationProjectPath: string | null;
}

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  runCommand: string;
  browserUrl: string;
  provider: AiProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface AppSettings {
  defaultModel: string;
  expandEditToolParts: boolean;
  expandShellToolParts: boolean;
  openAiSelectedModels: string[];
  anthropicSelectedModels: string[];
  showReasoningSummaries: boolean;
  shellPath: string;
}

export interface PanelVisibility {
  left: boolean;
  middle: boolean;
  right: boolean;
}

export interface PanelSizes {
  leftSidebarWidth: number;
  rightPanelWidth: number;
  terminalHeight: number;
}

export interface PersistedIdeState {
  projects: ProjectConfig[];
  closedProjects: ProjectConfig[];
  activeProjectId: string | null;
  projectRightPanelOpenByProject: Record<string, boolean>;
  projectPanelSizesByProject: Record<string, PanelSizes>;
  panelVisibility: PanelVisibility;
  panelSizes: PanelSizes;
  settings: AppSettings;
  chats: ChatConfig[];
  activeChatIdByProject: Record<string, string | null>;
  chatSort: ChatSortOrder;
  messagesByChatId: Record<string, UIMessage[]>;
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

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserErrorEvent {
  code: number | string;
  description: string;
}

export interface BrowserStatusEvent {
  loading: boolean;
  projectId: string;
  tabId?: string;
}

export interface BrowserTabState {
  canGoBack: boolean;
  canGoForward: boolean;
  id: string;
  title: string;
  url: string;
}

export interface BrowserPageStateEvent {
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
  addedLines: number;
  path: string;
  previousPath: string | null;
  removedLines: number;
  status: ProjectGitChangeStatus;
}

export interface ProjectGitStatusResponse {
  branch: string | null;
  changes: ProjectGitStatusEntry[];
  isRepo: boolean;
  repoRoot: string | null;
}

export interface ProjectGitBranchEntry {
  current: boolean;
  name: string;
}

export interface ProjectGitBranchesResponse {
  branches: ProjectGitBranchEntry[];
  currentBranch: string | null;
  isRepo: boolean;
  repoRoot: string | null;
}

export interface ProjectGitCheckoutResponse extends ProjectGitBranchesResponse {
  created: boolean;
}

export interface ProjectGitDiffResponse {
  branch: string | null;
  diff: string;
  filePath: string;
  parsedDiff: FileDiffMetadata | null;
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

export interface TerminalResizePayload {
  projectId: string;
  cols: number;
  rows: number;
}

export interface BrowserUpdatePayload {
  bounds?: BrowserBounds;
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
  writeClipboardText: (text: string) => Promise<boolean>;
  saveTextFile: (payload: {
    contents: string;
    defaultPath?: string;
    title?: string;
  }) => Promise<boolean>;

  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;

  pickProjectDirectory: () => Promise<string | null>;

  loadState: () => Promise<Partial<PersistedIdeState>>;
  saveState: (state: PersistedIdeState) => Promise<boolean>;

  getDefaultTerminalShell: () => Promise<string>;
  startTerminal: (payload: StartTerminalPayload) => Promise<{
    status: string;
    pid?: number;
    transport?: "pty" | "pipe";
    shell?: string;
  }>;
  sendTerminalInput: (payload: TerminalInputPayload) => void;
  resizeTerminal: (payload: TerminalResizePayload) => void;
  stopTerminal: (projectId: string) => Promise<boolean>;
  onTerminalData: (listener: (event: TerminalDataEvent) => void) => () => void;
  onTerminalStatus: (
    listener: (event: TerminalStatusEvent) => void,
  ) => () => void;

  updateBrowser: (payload: BrowserUpdatePayload) => void;
  onBrowserError: (listener: (event: BrowserErrorEvent) => void) => () => void;
  onBrowserPageState: (
    listener: (event: BrowserPageStateEvent) => void,
  ) => () => void;
  onBrowserStatus: (
    listener: (event: BrowserStatusEvent) => void,
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
