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
  HostConnectionState,
  HostStatusEvent,
  PanelSizes,
  PanelVisibility,
  PendingChatSubmit,
  ProjectConfig,
  ProjectGitWorktreeCleanupResponse,
  ProjectGitWorktreeInfo,
  ProjectGitWorktreeMergeResponse,
  ProjectWorktreeInfo,
  RightPanelView,
  SavedPrompt,
  SshHostConfig,
  StashItem,
} from "@/types/ide";
import type {
  CliUpgradeResult,
  ProviderModelState,
  SettingsSection,
} from "../ide-types";

/** Where to put the cursor in a file being opened: a 1-based line, and a
 *  0-based column and length to select on it. */
export interface ProjectFilePosition {
  line: number;
  column: number;
  length: number;
}

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

export interface HostRuntimeState {
  state: HostConnectionState;
  error: string | null;
  /** Its catalog is in the store. */
  loaded: boolean;
}

export interface IdeState {
  // Persisted state
  projects: ProjectConfig[];
  closedProjects: ProjectConfig[];
  activeProjectId: string | null;
  appView: AppView;
  savedPrompts: SavedPrompt[];
  chats: ChatConfig[];
  chatSort: ChatSortOrder;
  settings: AppSettings;
  messagesByChatId: Record<string, UIMessage[]>;
  pendingChatSubmitByChatId: Record<string, PendingChatSubmit>;

  // Runtime state
  streamingChatIds: Record<string, boolean>;
  /**
   * Chats with a turn running on their host, whoever started it. A session
   * for one resumes the turn's stream (chat-runtime.ts).
   */
  hostRunningChatIds: Record<string, true>;
  /** SSH hosts' connection state (the local host is always there). */
  hosts: Record<string, HostRuntimeState>;
  /**
   * After hydration: picks up the SSH hosts main is already connected to
   * (it keeps them across a reload of the window) and reconnects those in
   * `openHostIds` (hosts with projects open last time).
   */
  resumeHosts: (openHostIds: string[]) => Promise<void>;
  /**
   * Projects a host refused because it already has a project at that path:
   * each is replaced by the host's project, in the same place, with its
   * chats moved over.
   */
  adoptHostProjects: (
    hostId: string,
    conflicts: { id: string; existingId: string }[],
  ) => Promise<void>;
  /**
   * Changes how an SSH host is named or reached, keeping its id (and so its
   * projects); a live connection reconnects when the target or host
   * command changed.
   */
  updateSshHost: (
    hostId: string,
    patch: Partial<Pick<SshHostConfig, "label" | "target" | "hostCommand">>,
  ) => Promise<void>;
  awaitingAnswerChatIds: Record<string, boolean>;
  completedChatIds: Record<string, boolean>;
  titleGeneratingChatIds: Record<string, boolean>;
  draftChatIdByProject: Record<string, string | null>;
  terminalStatus: Record<string, "running" | "stopped">;
  terminalTransport: Record<string, "pty" | "pipe">;
  terminalShell: Record<string, string>;
  terminalSessionNames: Record<string, string>;
  nextTerminalOrdinalByProject: Record<string, number>;
  projectTerminalSessionIds: Record<string, string[]>;
  activeTerminalSessionIdByProject: Record<string, string | null>;
  projectTerminalPanelOpenByProject: Record<string, boolean>;
  projectGitLogPanelOpenByProject: Record<string, boolean>;
  outputPanelOpen: boolean;
  browserError: string | null;
  browserLoading: Record<string, boolean>;
  browserTabsByProject: Record<string, BrowserTabState[]>;
  activeBrowserTabIdByProject: Record<string, string | null>;
  projectGitRefreshKeys: Record<string, number>;
  projectFilesRefreshKeys: Record<string, number>;
  projectFileOpenRequests: Record<
    string,
    { filePath: string; position?: ProjectFilePosition; requestId: number }
  >;
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
  providerModels: {
    openai: ProviderModelState;
    anthropic: ProviderModelState;
    opencode: ProviderModelState;
    cursor: ProviderModelState;
    grok: ProviderModelState;
    fetchedAt: string | null;
  };
  /** Newest published release of each installed agent CLI. */
  cliLatestVersions: Partial<Record<AiProvider, string | null>>;
  /** Agent CLIs whose updater is currently running. */
  cliUpgrades: Partial<Record<AiProvider, boolean>>;

  // Derived
  getActiveProject: () => ProjectConfig | null;
  getChatsForProject: (projectId: string) => ChatConfig[];
  getActiveChat: () => ChatConfig | null;
  getBrowserTabs: (projectId: string | null | undefined) => BrowserTabState[];
  getActiveBrowserTab: (projectId?: string | null) => BrowserTabState | null;

  // Actions - projects
  setProjects: (projects: ProjectConfig[]) => void;
  setActiveProjectId: (id: string | null) => void;
  addProject: (
    path: string,
    options?: {
      activate?: boolean;
      /** The host the folder is on; the local host when absent. */
      hostId?: string;
      /**
       * Marks the project as a Git worktree. Only fills in projects that do
       * not already carry worktree info, so details recorded at creation
       * (base branch, creation time) are kept.
       */
      worktree?: ProjectWorktreeInfo;
    },
  ) => void;
  createWorktreeProject: (
    parentProjectId: string,
    options: {
      activate?: boolean;
      baseRef?: string | null;
      branchName: string;
      initialChatSeed?: WorktreeInitialChatSeed;
    },
  ) => Promise<WorktreeProjectCreationResult | null>;
  /**
   * Opens a worktree git lists as a worktree project of its main checkout
   * (a detached one opens as a plain folder).
   */
  attachWorktreeProject: (
    worktree: ProjectGitWorktreeInfo,
    repo: {
      /** The host of the project it was listed from; local when absent. */
      hostId?: string;
      mainWorktreePath: string;
      repoRoot: string;
    },
  ) => void;
  /**
   * Merges the worktree's branch into its base in the main checkout, and
   * refreshes the parent's git status when it moved.
   */
  completeWorktreeProject: (
    projectId: string,
    options?: { acknowledgeUncommitted?: boolean },
  ) => Promise<ProjectGitWorktreeMergeResponse>;
  /**
   * Has the main process remove the worktree (and delete its branch when
   * asked and merged). A worktree git had already forgotten is answered as
   * removed. The app's own record stays until `purgeWorktreeProject`.
   */
  forgetWorktree: (options: {
    /** The branch as listed; resolved from the project record when omitted. */
    branch?: string | null;
    deleteBranch?: boolean;
    force?: boolean;
    /** The host the worktree is on; the local host when absent. */
    hostId?: string;
    mainWorktreePath: string;
    worktreePath: string;
  }) => Promise<ProjectGitWorktreeCleanupResponse>;
  /**
   * Drops every record of the worktree (open or closed project, chats,
   * per-project state) and activates `activateProjectId`, by default the
   * worktree's parent.
   */
  purgeWorktreeProject: (
    worktreePath: string,
    options?: {
      activateProjectId?: string | null;
      /** The host the worktree is on; the local host when absent. */
      hostId?: string;
    },
  ) => void;
  closeProject: (projectId: string) => void;
  /**
   * Removes a closed project for good, with its chats: from this window and
   * from its host's catalog. Its folder is not touched.
   */
  forgetClosedProject: (projectId: string) => void;
  stopProjectTerminals: (projectId: string) => void;
  updateProject: (
    projectId: string,
    updater: (project: ProjectConfig) => ProjectConfig,
  ) => void;
  addChat: (
    projectId: string,
    title?: string,
    options?: { forceNew?: boolean },
  ) => string | null;
  addChatBeside: (projectId: string) => string | null;
  branchChatInWorkspace: (options: {
    chatId: string;
    messageId: string;
  }) => string;
  branchChatInNewWorktree: (options: {
    baseRef?: string | null;
    branchName: string;
    chatId: string;
    messageId: string;
  }) => Promise<{ chatId: string; projectId: string }>;
  toggleProjectMultiChatMode: (projectId: string) => void;
  setActiveChatId: (projectId: string, chatId: string | null) => void;
  updateChat: (
    chatId: string,
    updater: (chat: ChatConfig) => ChatConfig,
  ) => void;
  archiveInactiveChats: () => number;
  toggleChatPinned: (chatId: string) => void;
  deleteChat: (chatId: string) => void;
  permanentlyDeleteChats: (chatIds: string[]) => void;
  restoreChats: (chatIds: string[]) => void;
  setMessagesForChat: (chatId: string, messages: UIMessage[]) => void;
  retainChatTranscript: (chatId: string) => () => void;
  loadMessagesForChat: (chatId: string) => Promise<UIMessage[]>;
  persistMessagesForChat: (
    chatId: string,
    messages?: UIMessage[],
  ) => Promise<void>;
  setChatSort: (sortOrder: ChatSortOrder) => void;
  addStashItem: (
    projectId: string,
    item: Omit<StashItem, "createdAt" | "id" | "updatedAt">,
  ) => string | null;
  updateStashItem: (
    projectId: string,
    itemId: string,
    updater: (item: StashItem) => StashItem,
  ) => void;
  deleteStashItem: (projectId: string, itemId: string) => void;
  executeStashItem: (projectId: string, itemId: string) => string | null;
  queueChatSubmit: (chatId: string, submission: PendingChatSubmit) => boolean;
  takePendingChatSubmit: (chatId: string) => PendingChatSubmit | null;

  // Actions - saved prompts
  /** Saves a new saved prompt at the end of the list. Returns its id. */
  addSavedPrompt: (savedPrompt: {
    name: string;
    prompt: string;
  }) => string | null;
  updateSavedPrompt: (
    promptId: string,
    updates: { name?: string; prompt?: string },
  ) => void;
  deleteSavedPrompt: (promptId: string) => void;
  moveSavedPrompt: (promptId: string, index: number) => void;
  /**
   * Sends a saved prompt's text, as written, to `chatId` in
   * `projectId`. Returns whether it was sent (it is not when the chat is
   * busy).
   */
  runSavedPrompt: (
    projectId: string,
    promptId: string,
    chatId: string,
  ) => boolean;

  // Actions - panels
  togglePanel: (panel: keyof PanelVisibility) => void;
  setPanelSizes: (
    updater: PanelSizes | ((prev: PanelSizes) => PanelSizes),
  ) => void;
  setProjectPanelSizes: (
    projectId: string,
    updater: PanelSizes | ((prev: PanelSizes) => PanelSizes),
  ) => void;
  setProjectChatHistoryPanelOpen: (projectId: string, open: boolean) => void;
  setProjectGitLogPanelOpen: (projectId: string, open: boolean) => void;
  setProjectRightPanelOpen: (projectId: string, open: boolean) => void;
  setProjectRightPanelView: (projectId: string, view: RightPanelView) => void;
  setAppView: (view: AppView) => void;
  openProjectFile: (
    projectId: string,
    filePath: string,
    position?: ProjectFilePosition,
  ) => void;
  /** Opens the Files panel on find in files and focuses its query. */
  openProjectFileSearch: (projectId: string) => void;
  setOutputPanelOpen: (open: boolean) => void;

  // Actions - settings
  setSettings: (
    updater: AppSettings | ((prev: AppSettings) => AppSettings),
  ) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setModelSearchQuery: (query: string) => void;

  // Actions - provider management
  toggleProviderModel: (
    provider: AiProvider,
    model: string,
    enabled?: boolean,
  ) => void;
  refreshProviderModels: (options?: {
    force?: boolean;
    provider?: AiProvider;
  }) => Promise<void>;
  setProviderModels: (
    updater:
      | IdeState["providerModels"]
      | ((prev: IdeState["providerModels"]) => IdeState["providerModels"]),
  ) => void;
  checkCliUpdates: (options?: {
    force?: boolean;
    provider?: AiProvider;
  }) => Promise<void>;
  upgradeCli: (provider: AiProvider) => Promise<CliUpgradeResult>;

  // Actions - runtime
  setTerminalStatus: (projectId: string, status: "running" | "stopped") => void;
  setTerminalTransport: (projectId: string, transport: "pty" | "pipe") => void;
  setTerminalShell: (projectId: string, shell: string) => void;
  setTerminalSessionName: (sessionId: string, name: string) => void;
  setChatStreaming: (chatId: string, streaming: boolean) => void;
  setChatAwaitingAnswer: (chatId: string, awaiting: boolean) => void;
  setChatTitleGenerating: (chatId: string, generating: boolean) => void;
  bumpProjectGitRefreshKey: (projectId: string) => void;
  bumpProjectFilesRefreshKey: (projectId: string) => void;
  setBrowserError: (error: string | null) => void;
  setBrowserLoading: (id: string, loading: boolean) => void;
  ensureBrowserTabs: (projectId: string, initialUrl?: string) => void;
  createBrowserTab: (projectId: string, initialUrl?: string) => string | null;
  updateBrowserTab: (
    projectId: string,
    tabId: string,
    updater: (tab: BrowserTabState) => BrowserTabState,
  ) => void;
  closeBrowserTab: (projectId: string, tabId: string) => string | null;
  reorderBrowserTabs: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  setActiveBrowserTab: (projectId: string, tabId: string | null) => void;
  setIsMacOs: (value: boolean) => void;
  setIsElectron: (value: boolean) => void;
  setAppReady: (value: boolean) => void;
  openExternalUrl: (url: string) => void;
  openExternalPath: (path: string) => void;

  // Actions - runner
  startRunner: () => Promise<void>;
  stopRunner: () => Promise<void>;

  // Actions - terminal
  openProjectTerminal: (projectId: string) => Promise<void>;
  setProjectTerminalPanelOpen: (projectId: string, open: boolean) => void;
  addProjectTerminal: (
    projectId: string,
    options?: AddProjectTerminalOptions,
  ) => Promise<void>;
  setActiveProjectTerminalId: (
    projectId: string,
    sessionId: string | null,
  ) => void;
  reorderProjectTerminals: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  closeProjectTerminal: (
    projectId: string,
    sessionId: string,
    options?: CloseProjectTerminalOptions,
  ) => Promise<void>;

  // Actions - hydration & persistence
  hydrate: () => Promise<void>;
  /**
   * Applies host catalog changes made elsewhere (another client, the host
   * itself): upserted and removed projects and chats. Raw values; they are
   * repaired with the codec.
   */
  applyCatalogChanges: (
    changes: {
      projects?: unknown[];
      removedProjectIds?: string[];
      chats?: unknown[];
      removedChatIds?: string[];
    },
    hostId?: string,
  ) => void;
  /** A transcript changed on the host; reloads it if this window has it. */
  applyCatalogTranscript: (chatId: string) => Promise<void>;
  /** Re-reads a host's whole catalog (after its host socket says to). */
  reloadCatalog: (hostId?: string) => Promise<void>;
  /** Loads a just-connected host's catalog into the store. */
  loadHostCatalog: (hostId: string) => Promise<void>;
  /** Connects an SSH host from settings and loads its catalog. */
  connectHost: (hostId: string) => Promise<boolean>;
  /** Disconnects an SSH host; its work keeps running there. */
  disconnectHost: (hostId: string) => Promise<void>;
  /** Main reported a host's connection state. */
  setHostStatus: (event: HostStatusEvent) => void;
  /**
   * Forgets an SSH host: disconnects it, takes its projects out of this
   * window (the host keeps them) and removes it from settings.
   */
  removeSshHost: (hostId: string) => Promise<void>;
  /** Opens the folder at `path` on an SSH host as a project. */
  openProjectOnHost: (hostId: string, path: string) => Promise<boolean>;
  /** A turn started or ended on the host. */
  setHostTurnRunning: (chatId: string, running: boolean) => void;
  persist: () => void;
}

export type IdeStoreSet = StoreApi<IdeState>["setState"];
export type IdeStoreGet = StoreApi<IdeState>["getState"];
