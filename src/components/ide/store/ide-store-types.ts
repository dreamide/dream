import type { UIMessage } from "ai";
import type { StoreApi } from "zustand";
import type { ApiClient } from "@/lib/api-client";
import type {
  AiProvider,
  AppSettings,
  AppView,
  BrowserTabState,
  ChatConfig,
  ChatSortOrder,
  GitPanelTab,
  HostConnectionState,
  HostStatusEvent,
  ProjectConfig,
  SavedHostConnection,
  SavedPrompt,
} from "@/types/ide";
import type { ProviderModelState, SettingsSection } from "../ide-types";
import type { BrowserActions, BrowserTabStatus } from "./browser-actions";
import type { CatalogActions } from "./catalog-actions";
import type { ChatActions } from "./chat-actions";
import type { GitWriteActions } from "./git-write-actions";
import type { HostActions } from "./host-actions";
import type { PanelActions } from "./panel-actions";
import type { ProjectLifecycleActions } from "./project-lifecycle-actions";
import type { RuntimeActions } from "./runtime-actions";
import type { SavedPromptActions } from "./saved-prompt-actions";
import type { SettingsActions } from "./settings-actions";
import type { StandaloneChatActions } from "./standalone-chat-actions";
import type { StashActions } from "./stash-actions";
import type { TerminalActions } from "./terminal-actions";
import type { TranscriptActions } from "./transcript-cache";
import type { WorktreeActions } from "./worktree-actions";

/** Where to put the cursor in a file being opened: a 1-based line, and a
 *  0-based column and length to select on it. */
export interface ProjectFilePosition {
  line: number;
  column: number;
  length: number;
}

/** A git write a project can have running (store/git-write-actions.ts). */
export type GitWrite =
  | "checkout"
  | "commit"
  | "commit-push"
  | "delete-branch"
  | "fetch"
  | "pull"
  | "pull-request"
  | "push"
  | "revert";

/** How a git write went: its answer, or why it did not happen. */
export type GitWriteOutcome<Result> =
  | { ok: true; result: Result }
  | { ok: false; error: unknown };

export interface StoreActionDependencies {
  /** The route client; tests pass a fake (`createFakeApiClient`). */
  api?: ApiClient;
}

export interface WorktreeInitialChatSeed {
  messageId: string;
  messages: UIMessage[];
  sourceChat: ChatConfig;
}

export interface WorktreeProjectCreationResult {
  chatId: string | null;
  projectId: string;
}

export interface AddProjectTerminalOptions {
  command?: string;
  cwd?: string;
  name?: string;
  strictCwd?: boolean;
  /** Close the session when the terminal panel closes if nothing was typed. */
  closeIfUntouched?: boolean;
}

export interface CloseProjectTerminalOptions {
  /** Keep the right panel open even when the last session is closed. */
  keepRightPanelOpen?: boolean;
}

/**
 * How a desktop pairs with a host: a pairing link pasted whole, or a short
 * code typed with the host's address, which waits for the host to confirm.
 * `attemptId` names a code attempt so it can be cancelled.
 */
/** A pairing code created on the host, entered with the host's address. */
export type HostPairing = { address: string; code: string; attemptId: string };

export interface HostRuntimeState {
  state: HostConnectionState;
  error: string | null;
  /** Its catalog is in the store. */
  loaded: boolean;
  /** Why it failed for good, while `failed`: what its connection state maps. */
  refusal?: HostStatusEvent["refusal"];
  routeId?: HostStatusEvent["routeId"];
  routes?: HostStatusEvent["routes"];
}

/** The store's state: what is saved, and what this window keeps while it runs. */
export interface IdeStateFields {
  // Persisted state
  projects: ProjectConfig[];
  closedProjects: ProjectConfig[];
  activeProjectId: string | null;
  appView: AppView;
  savedPrompts: SavedPrompt[];
  chats: ChatConfig[];
  chatSort: ChatSortOrder;
  /** Which persistent host each connection id reaches, once verified. */
  hostConnections: SavedHostConnection[];
  settings: AppSettings;
  messagesByChatId: Record<string, UIMessage[]>;
  transcriptPageByChatId: Record<
    string,
    { before: string | null; total: number }
  >;

  // Runtime state
  streamingChatIds: Record<string, boolean>;
  /**
   * Chats a message is being sent to from this window, until their host has
   * it (chat/chat-submission.ts is the only writer).
   */
  sendingChatIds: Record<string, true>;
  /**
   * Chats with a turn running on their host, whoever started it. A session
   * for one resumes the turn's stream (chat-runtime.ts).
   */
  hostRunningChatIds: Record<string, string>;
  /**
   * Chats whose turn waits on a tool approval on their host, whether this
   * window follows the turn or not (host catalog `approval` events).
   */
  hostAwaitingApprovalChatIds: Record<string, string>;
  /** SSH hosts' connection state (the local host is always there). */
  hosts: Record<string, HostRuntimeState>;
  awaitingAnswerChatIds: Record<string, boolean>;
  titleGeneratingChatIds: Record<string, boolean>;
  draftChatIdByProject: Record<string, string | null>;
  terminalStatus: Record<string, "running" | "stopped">;
  terminalTransport: Record<string, "pty" | "pipe">;
  terminalShell: Record<string, string>;
  terminalSessionNames: Record<string, string>;
  nextTerminalOrdinalByProject: Record<string, number>;
  projectTerminalSessionIds: Record<string, string[]>;
  activeTerminalSessionIdByProject: Record<string, string | null>;
  /** The Git panel tab each project last showed (absent: overview). */
  projectGitPanelTabByProject: Record<string, GitPanelTab>;
  outputPanelOpen: boolean;
  browserStatusByTab: Record<string, BrowserTabStatus>;
  browserTabsByProject: Record<string, BrowserTabState[]>;
  activeBrowserTabIdByProject: Record<string, string | null>;
  /**
   * Browser tabs an agent has driven, per project. Their webviews stay
   * mounted (hidden when not shown) so agent tools can work in them without
   * bringing them to the front. A tab leaves the list when it is closed.
   */
  agentBrowserTabIdsByProject: Record<string, string[]>;
  projectGitRefreshKeys: Record<string, number>;
  /** The git write running for each project, if any (git-write-actions.ts). */
  gitWriteByProject: Record<string, GitWrite>;
  projectFilesRefreshKeys: Record<string, number>;
  /** Bumped to show the Files panel's find in files, per project. */
  projectFileSearchRequests: Record<string, number>;
  stateHydrated: boolean;
  /**
   * The workspace could not be loaded: what is shown is empty defaults, and
   * nothing is saved (it would overwrite the user's data).
   */
  persistenceBlocked: boolean;
  isMacOs: boolean;
  isElectron: boolean;
  appReady: boolean;

  // Settings dialog state
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  modelSearchQuery: string;
  /** What each provider's CLI lists, and when it was last fetched. */
  providerModels: Record<AiProvider, ProviderModelState> & {
    fetchedAt: string | null;
  };
  /** Newest published release of each installed agent CLI. */
  cliLatestVersions: Partial<Record<AiProvider, string | null>>;
  /** Agent CLIs whose updater is currently running. */
  cliUpgrades: Partial<Record<AiProvider, boolean>>;
}

/**
 * Answers read from the state, and hydration, written where the store is
 * composed (ide-store.ts).
 */
export interface IdeStoreActions {
  getActiveProject: () => ProjectConfig | null;
  getChatsForProject: (projectId: string) => ChatConfig[];
  getActiveChat: () => ChatConfig | null;
  getBrowserTabs: (projectId: string | null | undefined) => BrowserTabState[];
  getActiveBrowserTab: (projectId?: string | null) => BrowserTabState | null;
  hydrate: () => Promise<void>;
}

/**
 * The store: its state and every slice's actions, each declared beside its
 * slice. What one store module calls in another is not here; ide-store.ts
 * passes it between them.
 */
export interface IdeState
  extends IdeStateFields,
    IdeStoreActions,
    ProjectLifecycleActions,
    WorktreeActions,
    StandaloneChatActions,
    GitWriteActions,
    ChatActions,
    StashActions,
    SavedPromptActions,
    PanelActions,
    SettingsActions,
    RuntimeActions,
    BrowserActions,
    TerminalActions,
    TranscriptActions,
    CatalogActions,
    HostActions {}

export type IdeStoreSet = StoreApi<IdeState>["setState"];
export type IdeStoreGet = StoreApi<IdeState>["getState"];
