/**
 * The route client: the renderer's one way to call the main process's JSON
 * routes (electron/api/*-routes.js).
 *
 * One method per route. Its method and path are its row in the route table
 * (electron/shared/host-routes.js), which the host registers its handlers by.
 * Each request type is inferred from the zod schema the server validates
 * with, so the contract is written once, in the schema. The
 * response types are the renderer's own declarations (the server has no
 * response schemas); they sit here, beside the route they describe.
 *
 * Two transports sit behind the same interface:
 * - `httpTransport` sends JSON to the local API server. It owns the session
 *   header, the JSON encoding and turning an error response into an
 *   `ApiError` whose message is the server's plain-text reason.
 * - `createFakeApiClient` (api-client-fake.ts) answers from in-memory
 *   handlers, so store and panel tests exercise their own logic rather than
 *   the wire format.
 *
 * Callers that want a client other than the app's pass one in (store action
 * creators take `api`); everything else uses `apiClient`.
 */
import type { UIMessage } from "ai";
import type { z } from "zod";
import type { ProviderModelsResponse } from "@/components/ide/ide-types";
import type {
  AiProvider,
  ChatTitleResponse,
  CheckpointChangesResponse,
  CheckpointDiffResponse,
  CheckpointRestoreResponse,
  HostDescriptor,
  McpServerTransport,
  ProjectGitBranchDeletePreview,
  ProjectGitBranchDeleteResponse,
  ProjectGitBranchesResponse,
  ProjectGitCheckoutResponse,
  ProjectGitCommitMessageResponse,
  ProjectGitCommitResponse,
  ProjectGitCreatePrResponse,
  ProjectGitCreateWorktreeResponse,
  ProjectGitDiffResponse,
  ProjectGitLogResponse,
  ProjectGitPullRequestDetailsResponse,
  ProjectGitPullResponse,
  ProjectGitPushPreviewResponse,
  ProjectGitPushResponse,
  ProjectGitStatusResponse,
  ProjectGitWorktreeCleanupResponse,
  ProjectGitWorktreeCompareResponse,
  ProjectGitWorktreeMergeResponse,
  ProjectGitWorktreesResponse,
  ProviderSkillsResponse,
  TerminalOutputDiagnostics,
  TerminalShellOption,
} from "@/types/ide";
import type { browserToolCallRequestSchema } from "../../electron/api/browser-tool-call-routes.js";
import type {
  catalogChangesRequestSchema,
  catalogListRequestSchema,
  catalogSearchRequestSchema,
  catalogTranscriptPageSchema,
  catalogTranscriptRequestSchema,
  catalogTranscriptSaveRequestSchema,
} from "../../electron/api/catalog-routes.js";
import type {
  chatQueueControlSchema,
  chatQueueRequestSchema,
  chatSubmitRequestSchema,
  chatTitleRequestBodySchema,
} from "../../electron/api/chat/schema.js";
import type { chatFolderCreateRequestSchema } from "../../electron/api/chat-folder-routes.js";
import type { chatStopRequestSchema } from "../../electron/api/chat-routes.js";
import type {
  checkpointChangesRequestSchema,
  checkpointDeleteChatsRequestSchema,
  checkpointDiffRequestSchema,
  checkpointRestoreRequestSchema,
} from "../../electron/api/checkpoints/schemas.js";
import type { codePullRequestRequestSchema } from "../../electron/api/code-pull-request-schemas.js";
import type { hostDirectoriesRequestSchema } from "../../electron/api/host-directory-routes.js";
import type { hostSocketTicketRequestSchema } from "../../electron/api/host-socket-routes.js";
import type { mcpImportCandidatesRequestSchema } from "../../electron/api/mcp-servers/schemas.js";
import type {
  projectDirectoryRequestSchema,
  projectFileRequestSchema,
  projectFilesRequestSchema,
  projectFileWriteRequestSchema,
  projectGitBranchDeletePreviewRequestSchema,
  projectGitBranchDeleteRequestSchema,
  projectGitBranchesRequestSchema,
  projectGitCheckoutRequestSchema,
  projectGitCommitMessageRequestSchema,
  projectGitCommitRequestSchema,
  projectGitCreatePullRequestSchema,
  projectGitCreateWorktreeRequestSchema,
  projectGitDiffRequestSchema,
  projectGitFetchRequestSchema,
  projectGitLogRequestSchema,
  projectGitPullRequestDetailsRequestSchema,
  projectGitPullRequestSchema,
  projectGitPushPreviewRequestSchema,
  projectGitPushRequestSchema,
  projectGitRemoteUrlRequestSchema,
  projectGitRevertAllRequestSchema,
  projectGitRevertFileRequestSchema,
  projectGitStatusRequestSchema,
  projectGitWorktreeCleanupRequestSchema,
  projectGitWorktreeCompareDiffRequestSchema,
  projectGitWorktreeCompareRequestSchema,
  projectGitWorktreeMergeRequestSchema,
  projectGitWorktreesRequestSchema,
  projectIconRequestSchema,
  projectSearchRequestSchema,
} from "../../electron/api/project-git/schemas.js";
import type {
  cliUpdatesRequestSchema,
  cliUpgradeRequestSchema,
  providerModelsRequestSchema,
  providerUsageLimitsRequestSchema,
} from "../../electron/api/providers/schemas.js";
import type {
  remoteAccessEnableSchema,
  remotePairingCreateRequestSchema,
  remoteSessionRevokeRequestSchema,
} from "../../electron/api/remote-access-routes.js";
import type {
  createSkillRequestSchema,
  readSkillRequestSchema,
  setSkillEnabledRequestSchema,
  skillsRequestSchema,
} from "../../electron/api/skills/schemas.js";
import type {
  terminalEmptyRequestSchema,
  terminalStartRequestSchema,
  terminalStopRequestSchema,
} from "../../electron/api/terminals/schemas.js";
import type { toolApprovalResponseSchema } from "../../electron/api/tool-approvals.js";
import {
  HOST_ROUTES,
  type HostRouteName,
} from "../../electron/shared/host-routes.js";
import { hostFetch } from "./connections/host-endpoint";
import { resolveRequestHost } from "./host-routing";

// ── Responses the renderer declares ─────────────────────────────────────

/**
 * The problems remote access reports (host/remote-access/). A client shows
 * its own words for a code it knows, and the host's English `message` for
 * any other.
 */
export type RemoteAccessProblemCode =
  // Tailscale (tailscale.js)
  | "not-installed"
  | "not-running"
  | "needs-login"
  | "needs-approval"
  | "https-disabled"
  | "port-taken"
  | "permission"
  // Cloudflare (remote-access.js; the user runs cloudflared)
  | "needs-origin"
  | "quick-tunnel"
  // Either route (remote-access.js)
  | "port-in-use"
  | "unreachable"
  | "failed";

export interface RemoteAccessProblem {
  code: RemoteAccessProblemCode | (string & {});
  message: string;
  url: string | null;
  /** Values the client's words for this code need (a port, an address). */
  params?: { detail?: string; origin?: string; port?: number };
  /**
   * An enable request that was refused and saved nothing. Older hosts never
   * send `params` or `refused`.
   */
  refused?: boolean;
}

/** Whether and how paired devices reach a host (host/remote-access/). */
export interface RemoteAccessStatus {
  enabled: boolean;
  /**
   * `proxy`: set when the host started (`--remote-port` and its variables),
   * for the user's own reverse proxy; Settings cannot change it.
   */
  mode: "tailscale" | "cloudflare" | "proxy";
  /** With `proxy`: the flag or variable that set each part. */
  override?: { sources: Record<string, string> };
  cloudflare?: {
    /** The loopback port used when none is saved and it is free. */
    defaultPort: number;
    /**
     * The saved address, kept while another mode is active. Absent from a
     * host older than this field, and when the host's start options set it.
     */
    origin?: string | null;
  };
  /** The listener's loopback port. */
  port: number | null;
  httpsPort: number;
  listening: boolean;
  /** The public origin, only once a request through it reached this host. */
  origin: string | null;
  ready: boolean;
  /** The public address entered for a Cloudflare route. */
  requestedOrigin: string | null;
  /**
   * Whether the saved settings can be turned on as they are. Absent from a
   * host older than 2026-10-28 (a service the desktop attached to).
   */
  configured?: boolean;
  problem: RemoteAccessProblem | null;
  checkedAt: string | null;
  /**
   * Where it is: `notReady` is on and not reachable. This, `address` and
   * `lockedBy` are absent from a host older than 2026-11-17; read all
   * three with `readRemoteAccess` (electron/shared/remote-access-view.js).
   */
  phase?: "off" | "checking" | "ready" | "notReady";
  /** The address to show: verified when ready, else the one set up or saved. */
  address?: string | null;
  /** The start-up options that set it; null when Settings may change it. */
  lockedBy?: string[] | null;
}

/** A pairing just minted: a short code that works once. */
export interface RemotePairing {
  pairingId: string;
  code: string;
  expiresAt: string;
  scopes: string[];
}

/** A paired device's session (never its secret). */
export interface RemoteDeviceSession {
  id: string;
  deviceName: string;
  clientKind: "web" | "native";
  scopes: string[];
  grantedBy: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export type ProjectDirectoryEntryKind = "directory" | "file" | "symlink";

export interface ProjectDirectoryEntry {
  kind: ProjectDirectoryEntryKind;
  path: string;
}

export interface ProjectDirectoryResponse {
  directory: string;
  entries: ProjectDirectoryEntry[];
}

/** One folder in a host's folder listing. */
export interface HostDirectoryEntry {
  name: string;
  path: string;
  /** Its name starts with a dot. */
  hidden: boolean;
}

/** A new standalone chat's folder on its host (`/api/chat-folders`). */
export interface ChatFolderResponse {
  /** Absolute on the host; created and empty. */
  path: string;
}

/** The folders in one folder of a host (`/api/host-directories`). */
export interface HostDirectoriesResponse {
  /** The folder listed, absolute on the host. */
  path: string;
  /** Its parent, or null at the root. */
  parent: string | null;
  /** The home folder of the user the host runs as. */
  home: string;
  /** The host's path separator. */
  separator: string;
  directories: HostDirectoryEntry[];
  /** More folders than were listed. */
  truncated: boolean;
}

export interface ProjectFilesResponse {
  count: number;
  files: string[];
}

export type ProjectFileLineEnding = "crlf" | "lf";

export interface ProjectFileReadResponse {
  content: string;
  /** Set when a line range was asked for. */
  endLine?: number;
  filePath: string;
  lineEnding: ProjectFileLineEnding;
  readOnlyReason: string | null;
  startLine?: number;
  writable: boolean;
}

export interface ProjectFileWriteResponse {
  content: string;
  filePath: string;
  lineEnding: ProjectFileLineEnding;
}

export interface ProjectIconResponse {
  /** Normalized by the caller (`normalizeProjectIconResponse`). */
  icon: unknown;
}

export interface ProjectGitRevertFileResponse {
  filePath: string;
  reverted: true;
}

export interface ProjectGitRevertAllResponse {
  reverted: true;
}

export interface CheckpointDeleteChatsResponse {
  deletedRefs: number;
}

export interface CliUpdatesResponse {
  checkedAt: string;
  latest: Partial<Record<AiProvider, string | null>>;
}

export type CliUpgradeResponse =
  | { ok: true; output: string }
  | { ok: false; error: string };

export interface UsageLimitWindow {
  label: string;
  resetAfterSeconds?: number | null;
  resetAt?: string | null;
  usedPercent: number;
}

export interface UsageLimitsResponse {
  error?: string | null;
  fetchedAt?: string;
  limits?: UsageLimitWindow[];
  note?: string | null;
  provider?: AiProvider;
  source?: string;
  status?: "ok" | "unavailable";
}

export type McpImportSourceKind =
  | "claudeUser"
  | "claudeProject"
  | "codexUser"
  | "cursorUser"
  | "cursorProject";

export interface McpImportCandidate {
  args: string[];
  command: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  name: string;
  sources: { kind: McpImportSourceKind; path: string }[];
  transport: McpServerTransport;
  url: string;
  warnings: string[];
}

export interface McpImportCandidatesResponse {
  candidates: McpImportCandidate[];
}

export interface SkillFileContents {
  attributes: Record<string, unknown>;
  body: string;
  path: string;
  text: string;
}

export interface CreateSkillResponse {
  paths: string[];
}

export interface TerminalStartResponse {
  status: string;
  pid?: number;
  transport?: "pty" | "pipe";
  shell?: string;
}

/** The host catalog, raw: decode it (merged with the workspace) to use it. */
export interface CatalogResponse {
  projects: Record<string, unknown>[];
  chats: Record<string, unknown>[];
  /** Whose catalog this is; absent from hosts older than identities. */
  host?: HostDescriptor;
  /** Chats with a turn running on the host now. */
  runningChatIds?: string[];
  /** Chats whose turn waits on a tool approval now. */
  awaitingApprovalChatIds?: string[];
}

export interface ChatRunSummary {
  id: string;
  chatId: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "completed"
    | "interrupted"
    | "failed"
    | "cancelled";
  text: string;
  provider: string;
  model: string;
  error: string | null;
}
export interface ChatQueueResponse {
  paused: boolean;
  runs: ChatRunSummary[];
}
export interface TranscriptPage {
  messages: UIMessage[];
  total: number;
  startIndex: number;
  before: string | null;
}

export interface CatalogChangesResponse {
  projectIds: string[];
  chatIds: string[];
  removedProjectIds: string[];
  removedChatIds: string[];
  /** Projects refused because another project already has that path. */
  conflicts: { id: string; existingId: string; path: string }[];
}

/** One line of a file that matched a project search. */
export interface ProjectSearchLine {
  /** 1-based line number. */
  line: number;
  /** The first match on the line: its 0-based column and length. */
  column: number;
  length: number;
  /** Retained matches on the line; the result limit can cut this short. */
  matchCount: number;
  /** The line as shown: indentation dropped, long lines cut with "…". */
  preview: string;
  /** Each match as [start, end) offsets into `preview`. */
  ranges: [number, number][];
}

export interface ProjectSearchFile {
  /** Project-relative POSIX path. */
  path: string;
  lines: ProjectSearchLine[];
}

export interface ProjectSearchResponse {
  files: ProjectSearchFile[];
  matchCount: number;
  /** An additional match was found beyond the retained result limit. */
  truncated: boolean;
}

/** One chat whose transcript matched a search, with its latest match. */
export interface CatalogSearchResult {
  chatId: string;
  /** How many of the chat's messages match. */
  matchCount: number;
  messageId: string | null;
  role: string;
  snippet: { before: string; match: string; after: string };
}

export interface CatalogSearchResponse {
  results: CatalogSearchResult[];
  /** The search stopped early; older matches may be missing. */
  truncated: boolean;
}

export interface ToolApprovalResolution {
  handled: boolean;
  provider?: AiProvider;
  status: string;
}

// ── Routes ──────────────────────────────────────────────────────────────

type Input<Schema extends z.ZodType> = z.input<Schema>;

/** A route: its method and path, and (types only) its request and response. */
export interface ApiRoute<Request, Response> {
  method: "POST" | "PUT";
  path: string;
  /** Never set; carries the types. */
  readonly types?: { request: Request; response: Response };
}

/** The route table's rows a JSON body is sent to. */
type JsonRouteName = {
  [Name in HostRouteName]: (typeof HOST_ROUTES)[Name]["method"] extends
    | "POST"
    | "PUT"
    ? Name
    : never;
}[HostRouteName];

/** The route table's row `name`, with its request and response types. */
const route = <Request, Response>(
  name: JsonRouteName,
): ApiRoute<Request, Response> => {
  const { method, path } = HOST_ROUTES[name];
  return { method, path };
};

/**
 * Every JSON route the renderer calls: each key is the client's method name
 * and the route table's row (electron/shared/host-routes.js) it calls, which
 * gives its method and path.
 */
export const API_ROUTES = {
  // Project files
  projectDirectory: route<
    Input<typeof projectDirectoryRequestSchema>,
    ProjectDirectoryResponse
  >("projectDirectory"),
  projectFiles: route<
    Input<typeof projectFilesRequestSchema>,
    ProjectFilesResponse
  >("projectFiles"),
  readProjectFile: route<
    Input<typeof projectFileRequestSchema>,
    ProjectFileReadResponse
  >("readProjectFile"),
  writeProjectFile: route<
    Input<typeof projectFileWriteRequestSchema>,
    ProjectFileWriteResponse
  >("writeProjectFile"),
  searchProjectFiles: route<
    Input<typeof projectSearchRequestSchema>,
    ProjectSearchResponse
  >("searchProjectFiles"),
  projectIcon: route<
    Input<typeof projectIconRequestSchema>,
    ProjectIconResponse
  >("projectIcon"),

  // Git
  gitStatus: route<
    Input<typeof projectGitStatusRequestSchema>,
    ProjectGitStatusResponse
  >("gitStatus"),
  gitBranches: route<
    Input<typeof projectGitBranchesRequestSchema>,
    ProjectGitBranchesResponse
  >("gitBranches"),
  gitCheckout: route<
    Input<typeof projectGitCheckoutRequestSchema>,
    ProjectGitCheckoutResponse
  >("gitCheckout"),
  gitBranchDeletePreview: route<
    Input<typeof projectGitBranchDeletePreviewRequestSchema>,
    ProjectGitBranchDeletePreview
  >("gitBranchDeletePreview"),
  gitBranchDelete: route<
    Input<typeof projectGitBranchDeleteRequestSchema>,
    ProjectGitBranchDeleteResponse
  >("gitBranchDelete"),
  gitDiff: route<
    Input<typeof projectGitDiffRequestSchema>,
    ProjectGitDiffResponse
  >("gitDiff"),
  gitRevertFile: route<
    Input<typeof projectGitRevertFileRequestSchema>,
    ProjectGitRevertFileResponse
  >("gitRevertFile"),
  gitRevertAll: route<
    Input<typeof projectGitRevertAllRequestSchema>,
    ProjectGitRevertAllResponse
  >("gitRevertAll"),
  gitCommit: route<
    Input<typeof projectGitCommitRequestSchema>,
    ProjectGitCommitResponse
  >("gitCommit"),
  gitCommitMessage: route<
    Input<typeof projectGitCommitMessageRequestSchema>,
    ProjectGitCommitMessageResponse
  >("gitCommitMessage"),
  gitPush: route<
    Input<typeof projectGitPushRequestSchema>,
    ProjectGitPushResponse
  >("gitPush"),
  gitPushPreview: route<
    Input<typeof projectGitPushPreviewRequestSchema>,
    ProjectGitPushPreviewResponse
  >("gitPushPreview"),
  gitFetch: route<
    Input<typeof projectGitFetchRequestSchema>,
    { remote: string }
  >("gitFetch"),
  gitPull: route<
    Input<typeof projectGitPullRequestSchema>,
    ProjectGitPullResponse
  >("gitPull"),
  gitRemoteUrl: route<
    Input<typeof projectGitRemoteUrlRequestSchema>,
    { url: string }
  >("gitRemoteUrl"),
  gitLog: route<
    Input<typeof projectGitLogRequestSchema>,
    ProjectGitLogResponse
  >("gitLog"),
  gitCreatePullRequest: route<
    Input<typeof projectGitCreatePullRequestSchema>,
    ProjectGitCreatePrResponse
  >("gitCreatePullRequest"),
  gitPullRequestDetails: route<
    Input<typeof projectGitPullRequestDetailsRequestSchema>,
    ProjectGitPullRequestDetailsResponse
  >("gitPullRequestDetails"),

  // Worktrees
  gitWorktrees: route<
    Input<typeof projectGitWorktreesRequestSchema>,
    ProjectGitWorktreesResponse
  >("gitWorktrees"),
  gitWorktreeCreate: route<
    Input<typeof projectGitCreateWorktreeRequestSchema>,
    ProjectGitCreateWorktreeResponse
  >("gitWorktreeCreate"),
  gitWorktreeCompare: route<
    Input<typeof projectGitWorktreeCompareRequestSchema>,
    ProjectGitWorktreeCompareResponse
  >("gitWorktreeCompare"),
  gitWorktreeCompareDiff: route<
    Input<typeof projectGitWorktreeCompareDiffRequestSchema>,
    ProjectGitDiffResponse
  >("gitWorktreeCompareDiff"),
  gitWorktreeMerge: route<
    Input<typeof projectGitWorktreeMergeRequestSchema>,
    ProjectGitWorktreeMergeResponse
  >("gitWorktreeMerge"),
  gitWorktreeCleanup: route<
    Input<typeof projectGitWorktreeCleanupRequestSchema>,
    ProjectGitWorktreeCleanupResponse
  >("gitWorktreeCleanup"),

  // Checkpoints
  checkpointChanges: route<
    Input<typeof checkpointChangesRequestSchema>,
    CheckpointChangesResponse
  >("checkpointChanges"),
  checkpointDiff: route<
    Input<typeof checkpointDiffRequestSchema>,
    CheckpointDiffResponse
  >("checkpointDiff"),
  checkpointRestore: route<
    Input<typeof checkpointRestoreRequestSchema>,
    CheckpointRestoreResponse
  >("checkpointRestore"),
  checkpointDeleteChats: route<
    Input<typeof checkpointDeleteChatsRequestSchema>,
    CheckpointDeleteChatsResponse
  >("checkpointDeleteChats"),

  // Providers
  providerModels: route<
    NonNullable<Input<typeof providerModelsRequestSchema>>,
    ProviderModelsResponse
  >("providerModels"),
  providerUsageLimits: route<
    Input<typeof providerUsageLimitsRequestSchema>,
    UsageLimitsResponse
  >("providerUsageLimits"),
  cliUpdates: route<Input<typeof cliUpdatesRequestSchema>, CliUpdatesResponse>(
    "cliUpdates",
  ),
  cliUpgrade: route<Input<typeof cliUpgradeRequestSchema>, CliUpgradeResponse>(
    "cliUpgrade",
  ),

  // Skills
  skills: route<Input<typeof skillsRequestSchema>, ProviderSkillsResponse>(
    "skills",
  ),
  readSkill: route<Input<typeof readSkillRequestSchema>, SkillFileContents>(
    "readSkill",
  ),
  createSkill: route<
    Input<typeof createSkillRequestSchema>,
    CreateSkillResponse
  >("createSkill"),
  setSkillEnabled: route<
    Input<typeof setSkillEnabledRequestSchema>,
    { ok: true }
  >("setSkillEnabled"),

  // Chat
  chatTitle: route<Input<typeof chatTitleRequestBodySchema>, ChatTitleResponse>(
    "chatTitle",
  ),
  /** Stops the chat's running turn (dropping the request does not). */
  stopChatTurn: route<
    Input<typeof chatStopRequestSchema>,
    { stopped: boolean }
  >("stopChatTurn"),
  toolApprovalResponse: route<
    Input<typeof toolApprovalResponseSchema>,
    ToolApprovalResolution
  >("toolApprovalResponse"),

  // The host catalog (projects, chats, transcripts)
  submitChat: route<
    Input<typeof chatSubmitRequestSchema>,
    { id: string; duplicate: boolean }
  >("submitChat"),
  chatQueue: route<Input<typeof chatQueueRequestSchema>, ChatQueueResponse>(
    "chatQueue",
  ),
  controlChatQueue: route<
    Input<typeof chatQueueControlSchema>,
    ChatQueueResponse
  >("controlChatQueue"),
  catalog: route<Input<typeof catalogListRequestSchema>, CatalogResponse>(
    "catalog",
  ),
  catalogChanges: route<
    Input<typeof catalogChangesRequestSchema>,
    CatalogChangesResponse
  >("catalogChanges"),
  catalogTranscript: route<
    Input<typeof catalogTranscriptRequestSchema>,
    UIMessage[]
  >("catalogTranscript"),
  catalogTranscriptPage: route<
    Input<typeof catalogTranscriptPageSchema>,
    TranscriptPage
  >("catalogTranscriptPage"),
  catalogSearch: route<
    Input<typeof catalogSearchRequestSchema>,
    CatalogSearchResponse
  >("catalogSearch"),
  saveCatalogTranscript: route<
    Input<typeof catalogTranscriptSaveRequestSchema>,
    { saved: boolean }
  >("saveCatalogTranscript"),

  // A browser tool call from an SSH host's agent, run on this window's
  // browser (the local host's API; the result is the tool's MCP content)
  callBrowserTool: route<Input<typeof browserToolCallRequestSchema>, unknown>(
    "callBrowserTool",
  ),

  // A host's folders, for picking a project folder on it
  hostDirectories: route<
    Input<typeof hostDirectoriesRequestSchema>,
    HostDirectoriesResponse
  >("hostDirectories"),

  // The folder of a new standalone chat, created on its host
  createChatFolder: route<
    Input<typeof chatFolderCreateRequestSchema>,
    ChatFolderResponse
  >("createChatFolder"),

  // Remote access and paired devices (this machine's operator only)
  remoteAccess: route<Record<string, never>, RemoteAccessStatus>(
    "remoteAccess",
  ),
  remoteAccessEnable: route<
    Input<typeof remoteAccessEnableSchema>,
    RemoteAccessStatus
  >("remoteAccessEnable"),
  remoteAccessDisable: route<Record<string, never>, RemoteAccessStatus>(
    "remoteAccessDisable",
  ),
  remoteAccessCheck: route<Record<string, never>, RemoteAccessStatus>(
    "remoteAccessCheck",
  ),
  remotePairingCreate: route<
    Input<typeof remotePairingCreateRequestSchema>,
    RemotePairing
  >("remotePairingCreate"),
  remoteSessions: route<
    Record<string, never>,
    { sessions: RemoteDeviceSession[] }
  >("remoteSessions"),
  remoteSessionRevoke: route<
    Input<typeof remoteSessionRevokeRequestSchema>,
    { session: RemoteDeviceSession }
  >("remoteSessionRevoke"),

  // The host socket (live traffic: terminals, catalog events)
  hostSocketTicket: route<
    Input<typeof hostSocketTicketRequestSchema>,
    { ticket: string }
  >("hostSocketTicket"),

  // Terminals (output and input travel on the host socket)
  terminalShells: route<
    Input<typeof terminalEmptyRequestSchema>,
    TerminalShellOption[]
  >("terminalShells"),
  terminalStart: route<
    Input<typeof terminalStartRequestSchema>,
    TerminalStartResponse
  >("terminalStart"),
  terminalStop: route<Input<typeof terminalStopRequestSchema>, boolean>(
    "terminalStop",
  ),
  terminalStopAll: route<Input<typeof terminalEmptyRequestSchema>, boolean>(
    "terminalStopAll",
  ),
  terminalDiagnostics: route<
    Input<typeof terminalEmptyRequestSchema>,
    TerminalOutputDiagnostics[]
  >("terminalDiagnostics"),

  // Other
  mcpImportCandidates: route<
    Input<typeof mcpImportCandidatesRequestSchema>,
    McpImportCandidatesResponse
  >("mcpImportCandidates"),
  /**
   * One route for every GitHub pull request action; the response depends on
   * the action, so the caller names it (`pull-requests/api.ts`).
   */
  codePullRequests: route<Input<typeof codePullRequestRequestSchema>, unknown>(
    "codePullRequests",
  ),
} as const;

export type ApiRouteName = keyof typeof API_ROUTES;

export type ApiRequestOf<Name extends ApiRouteName> =
  (typeof API_ROUTES)[Name] extends ApiRoute<infer Request, unknown>
    ? Request
    : never;

export type ApiResponseOf<Name extends ApiRouteName> =
  (typeof API_ROUTES)[Name] extends ApiRoute<unknown, infer Response>
    ? Response
    : never;

export interface ApiCallOptions {
  signal?: AbortSignal;
  /** Let the request outlive the page (for calls made while unloading). */
  keepalive?: boolean;
  /**
   * The host to send it to. When absent, the host of the project the body
   * names (host-routing.ts), or the local host.
   */
  hostId?: string;
}

export type ApiClient = {
  [Name in ApiRouteName]: (
    request: ApiRequestOf<Name>,
    options?: ApiCallOptions,
  ) => Promise<ApiResponseOf<Name>>;
};

// ── Errors ──────────────────────────────────────────────────────────────

/**
 * A route answered with an error status. `message` is the server's reason
 * (routes answer errors as plain text), or a generic line when it sent none.
 */
export class ApiError extends Error {
  readonly path: string;
  readonly status: number;
  /** The server's own reason, trimmed; empty when it sent none. */
  readonly reason: string;

  constructor(path: string, status: number, reason: string) {
    super(reason || `Request failed (${status}).`);
    this.name = "ApiError";
    this.path = path;
    this.reason = reason;
    this.status = status;
  }
}

/**
 * The message to show for a failed call, most specific first: the server's
 * reason; `statusMessage` for an error status with no reason; any other
 * error's own message (a network failure); `fallback`.
 */
export const getApiErrorMessage = (
  error: unknown,
  fallback: string,
  statusMessage?: (status: number) => string,
) => {
  if (error instanceof ApiError) {
    if (error.reason) {
      return error.reason;
    }
    return statusMessage ? statusMessage(error.status) : fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
};

export const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

// ── Transports ──────────────────────────────────────────────────────────

export interface ApiTransportRequest {
  body: unknown;
  method: ApiRoute<unknown, unknown>["method"];
  name: ApiRouteName;
  path: string;
  signal?: AbortSignal;
  keepalive?: boolean;
  hostId?: string;
}

/** Sends one request; resolves with the JSON body or throws `ApiError`. */
export type ApiTransport = (request: ApiTransportRequest) => Promise<unknown>;

/**
 * Sends each request to its host (named, or resolved from the body) with
 * that host's endpoint and credential (connections/host-endpoint.ts).
 * `fetchImpl` replaces the network, for tests.
 */
export const createHttpTransport =
  (fetchImpl?: typeof fetch): ApiTransport =>
  async ({ body, hostId, keepalive, method, path, signal }) => {
    const response = await hostFetch(
      hostId ?? resolveRequestHost(body),
      path,
      {
        body: JSON.stringify(body ?? {}),
        headers: { "Content-Type": "application/json" },
        keepalive,
        method,
        signal,
      },
      fetchImpl,
    );
    if (!response.ok) {
      const reason = await response.text().catch(() => "");
      throw new ApiError(path, response.status, reason.trim());
    }
    return response.json();
  };

export const createApiClient = (transport: ApiTransport): ApiClient => {
  const client = {} as Record<
    ApiRouteName,
    (request: unknown, options?: ApiCallOptions) => Promise<unknown>
  >;
  for (const name of Object.keys(API_ROUTES) as ApiRouteName[]) {
    const { method, path } = API_ROUTES[name];
    client[name] = (request, options) =>
      transport({
        body: request,
        hostId: options?.hostId,
        keepalive: options?.keepalive,
        method,
        name,
        path,
        signal: options?.signal,
      });
  }
  return client as ApiClient;
};

/** The app's client, over HTTP to each host (connections/host-endpoint.ts). */
export const apiClient = createApiClient(createHttpTransport());

// ── Raw file loads ──────────────────────────────────────────────────────

/** A raw route on a host: what fetchApiBlob loads. */
export interface RawHostRequest {
  hostId: string;
  /** The route and its query, an `/api/...` path. */
  path: string;
}

/**
 * A raw route for the project at `projectPath`, on `hostId` when given,
 * otherwise on the host guessed from the path (for callers with only a path).
 */
const rawRoute = (
  route: string,
  projectPath: string,
  filePath: string,
  hostId?: string,
): RawHostRequest => ({
  hostId: hostId ?? resolveRequestHost({ projectPath }),
  path: `${route}?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(filePath)}`,
});

/** A project file's bytes. */
export const getProjectFileRawUrl = (
  projectPath: string,
  filePath: string,
  hostId?: string,
) => rawRoute(HOST_ROUTES.projectFileRaw.path, projectPath, filePath, hostId);

/** A file's bytes as committed at HEAD. */
export const getProjectGitFileAtHeadRawUrl = (
  projectPath: string,
  filePath: string,
  hostId?: string,
) => rawRoute(HOST_ROUTES.gitFileAtHeadRaw.path, projectPath, filePath, hostId);

/**
 * Loads one of the raw routes above as a blob, with its host's credential,
 * failing with `ApiError` the way the JSON routes do.
 */
export const fetchApiBlob = async (
  { hostId, path }: RawHostRequest,
  { signal }: ApiCallOptions = {},
): Promise<Blob> => {
  const response = await hostFetch(hostId, path, { signal });
  if (!response.ok) {
    const reason = await response.text().catch(() => "");
    throw new ApiError(path, response.status, reason.trim());
  }
  return response.blob();
};
