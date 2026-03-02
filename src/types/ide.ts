import type { UIMessage } from "ai";

export type AiProvider = "openai" | "anthropic";
export type ProviderAuthMode = "apiKey" | "codex";

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  runCommand: string;
  previewUrl: string;
  provider: AiProvider;
  model: string;
}

export interface AppSettings {
  openAiAuthMode: ProviderAuthMode;
  openAiApiKey: string;
  anthropicApiKey: string;
  defaultOpenAiModel: string;
  defaultAnthropicModel: string;
  shellPath: string;
}

export interface PanelVisibility {
  left: boolean;
  middle: boolean;
  right: boolean;
  bottom: boolean;
}

export interface PersistedIdeState {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  panelVisibility: PanelVisibility;
  settings: AppSettings;
  chats: Record<string, UIMessage[]>;
}

export interface RunnerDataEvent {
  projectId: string;
  chunk: string;
  stream: "stdout" | "stderr";
}

export interface RunnerStatusEvent {
  projectId: string;
  status: "running" | "stopped";
  pid?: number;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface TerminalDataEvent {
  projectId: string;
  chunk: string;
}

export interface TerminalStatusEvent {
  projectId: string;
  status: "running" | "stopped";
  transport?: "pty" | "pipe";
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

export interface StartRunnerPayload {
  projectId: string;
  projectName: string;
  cwd: string;
  command: string;
}

export interface StartTerminalPayload {
  projectId: string;
  cwd: string;
  shellPath?: string;
}

export interface TerminalInputPayload {
  projectId: string;
  data: string;
}

export interface PreviewUpdatePayload {
  bounds?: PreviewBounds;
  visible?: boolean;
  url?: string;
}

export interface DreamDesktopApi {
  isElectron: true;

  openExternal: (url: string) => Promise<boolean>;

  pickProjectDirectory: () => Promise<string | null>;

  loadState: () => Promise<Partial<PersistedIdeState>>;
  saveState: (state: PersistedIdeState) => Promise<boolean>;

  startRunner: (
    payload: StartRunnerPayload,
  ) => Promise<{ status: string; pid?: number }>;
  stopRunner: (projectId: string) => Promise<boolean>;
  onRunnerData: (listener: (event: RunnerDataEvent) => void) => () => void;
  onRunnerStatus: (listener: (event: RunnerStatusEvent) => void) => () => void;

  startTerminal: (
    payload: StartTerminalPayload,
  ) => Promise<{ status: string; pid?: number; transport?: "pty" | "pipe" }>;
  sendTerminalInput: (payload: TerminalInputPayload) => void;
  stopTerminal: (projectId: string) => Promise<boolean>;
  onTerminalData: (listener: (event: TerminalDataEvent) => void) => () => void;
  onTerminalStatus: (
    listener: (event: TerminalStatusEvent) => void,
  ) => () => void;

  updatePreview: (payload: PreviewUpdatePayload) => void;
  onPreviewError: (listener: (event: PreviewErrorEvent) => void) => () => void;
}
