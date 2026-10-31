import type { UIMessage } from "ai";
import type { StoreApi } from "zustand";
import type { ApiClient, ApiRequestOf, ApiResponseOf } from "@/lib/api-client";
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
  PanelSizes,
  PendingChatSubmit,
  ProjectConfig,
  ProjectGitStatusEntry,
  ProjectGitWorktreeCleanupResponse,
  ProjectGitWorktreeInfo,
  ProjectGitWorktreeMergeResponse,
  ProjectWorktreeInfo,
  RightPanelView,
  SavedHostConnection,
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

/** A git write a project can have running (store/git-write-actions.ts). */
export type GitWrite =
  | "checkout"
  | "commit"
  | "commit-push"
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
  routeId?: HostStatusEvent["routeId"];
  routes?: HostStatusEvent["routes"];
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
  /** Which persistent host each connection id reaches, once verified. */
  hostConnections: SavedHostConnection[];
  settings: AppSettings;
  messagesByChatId: Record<string, UIMessage[]>;
  transcriptPageByChatId: Record<
    string,
    { before: string | null; total: number }
  >;
  pendingChatSubmitByChatId: Record<string, PendingChatSubmit>;

  // Runtime state
  streamingChatIds: Record<string, boolean>;
  /**
   * Chats with a turn running on their host, whoever started it. A session
   * for one resumes the turn's stream (chat-runtime.ts).
   */
  hostRunningChatIds: Record<string, true>;
  /**
   * Chats whose turn waits on a tool approval on their host, whether this
   * window follows the turn or not (host catalog `approval` events).
   */
  hostAwaitingApprovalChatIds: Record<string, true>;
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
    patch: Partial<Pick<SshHostConfig, "label" | "target">>,
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
  /** The Git panel tab each project last showed (absent: overview). */
  projectGitPanelTabByProject: Record<string, GitPanelTab>;
  outputPanelOpen: boolean;
  browserError: string | null;
  browserLoading: Record<string, boolean>;
  browserTabsByProject: Record<string, BrowserTabState[]>;
  activeBrowserTabIdByProject: Record<string, string | null>;
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
  /**
   * Opens the folder at `path` on a host as a project, the way a person
   * opens one: an SSH host is connected first (ssh's prompts appear in
   * their own dialog), so a project already there opens as itself. False
   * when the host could not be reached; nothing is added then.
   */
  openProject: (
    path: string,
    options?: { activate?: boolean; hostId?: string; signal?: AbortSignal },
  ) => Promise<boolean>;
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
  /**
   * Stops the project's terminal sessions and deletes their scrollback.
   * Settles once every stop has been answered; a stop that fails (its host
   * is gone) is logged, never thrown.
   */
  stopProjectTerminals: (projectId: string) => Promise<void>;
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
  /** Closes a side-by-side chat column; the chat stays. */
  closeChatColumn: (projectId: string, chatId: string) => void;
  reorderChatColumns: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  setChatColumnWidths: (
    projectId: string,
    widths: Record<string, number>,
  ) => void;
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
  loadRecentMessagesForChat: (chatId: string) => Promise<UIMessage[]>;
  loadEarlierMessagesForChat: (chatId: string) => Promise<void>;
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
  setPanelSizes: (
    updater: PanelSizes | ((prev: PanelSizes) => PanelSizes),
  ) => void;
  setProjectPanelSizes: (
    projectId: string,
    updater: PanelSizes | ((prev: PanelSizes) => PanelSizes),
  ) => void;
  setProjectChatHistoryPanelOpen: (projectId: string, open: boolean) => void;
  setProjectGitPanelTab: (projectId: string, tab: GitPanelTab) => void;
  /**
   * Shows `view` in the project's right panel, opening it. With `toggle`, a
   * view (and Git tab) already showing closes the panel instead. `gitTab`
   * picks the Git panel's tab. Leaving the terminal view discards terminals
   * nobody typed into; showing it starts one when there is none.
   */
  showRightPanelView: (
    projectId: string,
    view: RightPanelView,
    options?: { gitTab?: GitPanelTab; toggle?: boolean },
  ) => void;
  /** Closes the project's right panel (see `showRightPanelView`). */
  closeRightPanel: (projectId: string) => void;
  /** Opens the right panel on the view it last showed, or closes it. */
  toggleRightPanel: (projectId: string) => void;
  setAppView: (view: AppView) => void;
  /**
   * Shows a file in the project's Files panel, optionally at a position.
   * `filePath` may be absolute or relative, with either separator; false
   * when it is not a file of that open project.
   */
  openProjectFile: (
    projectId: string,
    filePath: string,
    position?: ProjectFilePosition,
  ) => boolean;
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
  restoreHostTerminal: (sessionId: string) => void;
  setTerminalTransport: (projectId: string, transport: "pty" | "pipe") => void;
  setTerminalShell: (projectId: string, shell: string) => void;
  setTerminalSessionName: (sessionId: string, name: string) => void;
  setChatStreaming: (chatId: string, streaming: boolean) => void;
  setChatAwaitingAnswer: (chatId: string, awaiting: boolean) => void;
  setChatTitleGenerating: (chatId: string, generating: boolean) => void;
  bumpProjectGitRefreshKey: (projectId: string) => void;

  // Actions - git writes (store/git-write-actions.ts). Each runs on the
  // project's host, refuses to start while another write of the project
  // runs, refreshes the project's git state once when done, and answers an
  // outcome rather than throwing.
  commitProject: (
    projectId: string,
    commit: { message: string; includeUnstaged: boolean; push: boolean },
  ) => Promise<GitWriteOutcome<unknown>>;
  pushProject: (
    projectId: string,
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitPush">>>;
  pullProject: (
    projectId: string,
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitPull">>>;
  fetchProject: (
    projectId: string,
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitFetch">>>;
  /** Reverts one changed file, or every change. */
  revertProjectChanges: (
    projectId: string,
    target: ProjectGitStatusEntry | "all",
  ) => Promise<GitWriteOutcome<unknown>>;
  checkoutProjectBranch: (
    projectId: string,
    branchName: string,
    options?: { create?: boolean },
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitCheckout">>>;
  createProjectPullRequest: (
    projectId: string,
    request: Omit<ApiRequestOf<"gitCreatePullRequest">, "projectPath">,
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitCreatePullRequest">>>;
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
  /** Stops the project's terminals nobody has typed into. */
  discardUntouchedTerminals: (projectId: string) => void;
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
  /** A host transcript changed; refreshes a cached or currently loading chat. */
  /**
   * The host saved a chat's transcript. `messageCount` is the host's count
   * after the save, absent when the save only merged messages.
   */
  applyCatalogTranscript: (
    chatId: string,
    notice?: { messageCount?: number },
  ) => Promise<void>;
  /** Re-reads a host's whole catalog (after its host socket says to). */
  refreshHostCatalog: (hostId?: string) => Promise<void>;
  /** Internal reload projection, called by the host catalog lifecycle. */
  reloadCatalog: (hostId?: string) => Promise<void>;
  /** Loads a just-connected host's catalog into the store. */
  loadHostCatalog: (hostId: string) => Promise<void>;
  /** Connects an SSH host from settings and loads its catalog. */
  connectHost: (hostId: string) => Promise<boolean>;
  /** Pairs with a code created on the host. */
  pairHost: (
    how: HostPairing,
    label: string,
    connectionId?: string,
    replaceRouteId?: string,
  ) => Promise<string>;
  addSshRoute: (
    connectionId: string,
    values: Pick<SshHostConfig, "label" | "target">,
  ) => Promise<void>;
  setHostRoutes: (
    hostId: string,
    routes: SavedHostConnection["routes"],
  ) => Promise<void>;
  /** Disconnects an SSH host; its work keeps running there. */
  disconnectHost: (hostId: string) => Promise<void>;
  /** Main reported a host's connection state. */
  setHostStatus: (event: HostStatusEvent) => void;
  /**
   * Forgets an SSH host: disconnects it, takes its projects out of this
   * window (the host keeps them) and removes it from settings.
   */
  removeSshHost: (hostId: string) => Promise<void>;
  /** A turn started or ended on the host. */
  setHostTurnRunning: (chatId: string, running: boolean) => void;
  /** A chat started or stopped waiting on a tool approval on its host. */
  setHostChatAwaitingApproval: (chatId: string, awaiting: boolean) => void;
  persist: () => void;
}

export type IdeStoreSet = StoreApi<IdeState>["setState"];
export type IdeStoreGet = StoreApi<IdeState>["getState"];
