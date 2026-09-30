/**
 * The route client: the renderer's one way to call the main process's JSON
 * routes (electron/api/*-routes.js).
 *
 * One method per route. Each request type is inferred from the zod schema the
 * server validates with, so the contract is written once, in the schema. The
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
import type { z } from "zod";
import type { ProviderModelsResponse } from "@/components/ide/ide-types";
import type {
  AiProvider,
  ChatTitleResponse,
  CheckpointChangesResponse,
  CheckpointDiffResponse,
  CheckpointRestoreResponse,
  McpServerTransport,
  ProjectGitBranchesResponse,
  ProjectGitCheckoutResponse,
  ProjectGitCommitMessageResponse,
  ProjectGitCommitResponse,
  ProjectGitCreatePrResponse,
  ProjectGitCreateWorktreeResponse,
  ProjectGitDiffResponse,
  ProjectGitLogResponse,
  ProjectGitPullRequestDetailsResponse,
  ProjectGitPushPreviewResponse,
  ProjectGitPushResponse,
  ProjectGitStatusResponse,
  ProjectGitWorktreeCleanupResponse,
  ProjectGitWorktreeCompareResponse,
  ProjectGitWorktreeMergeResponse,
  ProjectGitWorktreesResponse,
  ProviderSkillsResponse,
} from "@/types/ide";
import type { chatTitleRequestBodySchema } from "../../electron/api/chat/schema.js";
import type {
  checkpointChangesRequestSchema,
  checkpointDeleteChatsRequestSchema,
  checkpointDeleteProjectRequestSchema,
  checkpointDiffRequestSchema,
  checkpointRestoreRequestSchema,
} from "../../electron/api/checkpoints/schemas.js";
import type { codePullRequestRequestSchema } from "../../electron/api/code-pull-request-schemas.js";
import type { mcpImportCandidatesRequestSchema } from "../../electron/api/mcp-servers/schemas.js";
import type {
  projectDirectoryRequestSchema,
  projectFileRequestSchema,
  projectFilesRequestSchema,
  projectFileWriteRequestSchema,
  projectGitBranchesRequestSchema,
  projectGitCheckoutRequestSchema,
  projectGitCommitMessageRequestSchema,
  projectGitCommitRequestSchema,
  projectGitCreatePullRequestSchema,
  projectGitCreateWorktreeRequestSchema,
  projectGitDiffRequestSchema,
  projectGitLogRequestSchema,
  projectGitPullRequestDetailsRequestSchema,
  projectGitPushPreviewRequestSchema,
  projectGitPushRequestSchema,
  projectGitRevertAllRequestSchema,
  projectGitRevertFileRequestSchema,
  projectGitStatusRequestSchema,
  projectGitWorktreeCleanupRequestSchema,
  projectGitWorktreeCompareDiffRequestSchema,
  projectGitWorktreeCompareRequestSchema,
  projectGitWorktreeMergeRequestSchema,
  projectGitWorktreesRequestSchema,
  projectIconRequestSchema,
} from "../../electron/api/project-git/schemas.js";
import type {
  cliUpdatesRequestSchema,
  cliUpgradeRequestSchema,
  providerModelsRequestSchema,
  providerUsageLimitsRequestSchema,
} from "../../electron/api/providers/schemas.js";
import type {
  createSkillRequestSchema,
  readSkillRequestSchema,
  setSkillEnabledRequestSchema,
  skillsRequestSchema,
} from "../../electron/api/skills/schemas.js";
import type { toolApprovalResponseSchema } from "../../electron/api/tool-approvals.js";
import { API_SESSION_TOKEN_HEADER, getApiSessionToken } from "./api-session";

// ── Responses the renderer declares ─────────────────────────────────────

export type ProjectDirectoryEntryKind = "directory" | "file" | "symlink";

export interface ProjectDirectoryEntry {
  kind: ProjectDirectoryEntryKind;
  path: string;
}

export interface ProjectDirectoryResponse {
  directory: string;
  entries: ProjectDirectoryEntry[];
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

export interface CheckpointDeleteProjectResponse {
  deleted: true;
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

const post = <Request, Response>(
  path: string,
): ApiRoute<Request, Response> => ({
  method: "POST",
  path,
});

const put = <Request, Response>(path: string): ApiRoute<Request, Response> => ({
  method: "PUT",
  path,
});

/**
 * Every JSON route the renderer calls. The keys are the client's method
 * names; `api-client.contract.test.ts` checks each path is served.
 */
export const API_ROUTES = {
  // Project files
  projectDirectory: post<
    Input<typeof projectDirectoryRequestSchema>,
    ProjectDirectoryResponse
  >("/api/project-directory"),
  projectFiles: post<
    Input<typeof projectFilesRequestSchema>,
    ProjectFilesResponse
  >("/api/project-files"),
  readProjectFile: post<
    Input<typeof projectFileRequestSchema>,
    ProjectFileReadResponse
  >("/api/project-file"),
  writeProjectFile: put<
    Input<typeof projectFileWriteRequestSchema>,
    ProjectFileWriteResponse
  >("/api/project-file"),
  projectIcon: post<
    Input<typeof projectIconRequestSchema>,
    ProjectIconResponse
  >("/api/project-icon"),

  // Git
  gitStatus: post<
    Input<typeof projectGitStatusRequestSchema>,
    ProjectGitStatusResponse
  >("/api/project-git-status"),
  gitBranches: post<
    Input<typeof projectGitBranchesRequestSchema>,
    ProjectGitBranchesResponse
  >("/api/project-git-branches"),
  gitCheckout: post<
    Input<typeof projectGitCheckoutRequestSchema>,
    ProjectGitCheckoutResponse
  >("/api/project-git-checkout"),
  gitDiff: post<
    Input<typeof projectGitDiffRequestSchema>,
    ProjectGitDiffResponse
  >("/api/project-git-diff"),
  gitRevertFile: post<
    Input<typeof projectGitRevertFileRequestSchema>,
    ProjectGitRevertFileResponse
  >("/api/project-git-revert-file"),
  gitRevertAll: post<
    Input<typeof projectGitRevertAllRequestSchema>,
    ProjectGitRevertAllResponse
  >("/api/project-git-revert-all"),
  gitCommit: post<
    Input<typeof projectGitCommitRequestSchema>,
    ProjectGitCommitResponse
  >("/api/project-git-commit"),
  gitCommitMessage: post<
    Input<typeof projectGitCommitMessageRequestSchema>,
    ProjectGitCommitMessageResponse
  >("/api/project-git-commit-message"),
  gitPush: post<
    Input<typeof projectGitPushRequestSchema>,
    ProjectGitPushResponse
  >("/api/project-git-push"),
  gitPushPreview: post<
    Input<typeof projectGitPushPreviewRequestSchema>,
    ProjectGitPushPreviewResponse
  >("/api/project-git-push-preview"),
  gitLog: post<Input<typeof projectGitLogRequestSchema>, ProjectGitLogResponse>(
    "/api/project-git-log",
  ),
  gitCreatePullRequest: post<
    Input<typeof projectGitCreatePullRequestSchema>,
    ProjectGitCreatePrResponse
  >("/api/project-git-create-pr"),
  gitPullRequestDetails: post<
    Input<typeof projectGitPullRequestDetailsRequestSchema>,
    ProjectGitPullRequestDetailsResponse
  >("/api/project-git-pull-request-details"),

  // Worktrees
  gitWorktrees: post<
    Input<typeof projectGitWorktreesRequestSchema>,
    ProjectGitWorktreesResponse
  >("/api/project-git-worktrees"),
  gitWorktreeCreate: post<
    Input<typeof projectGitCreateWorktreeRequestSchema>,
    ProjectGitCreateWorktreeResponse
  >("/api/project-git-worktree-create"),
  gitWorktreeCompare: post<
    Input<typeof projectGitWorktreeCompareRequestSchema>,
    ProjectGitWorktreeCompareResponse
  >("/api/project-git-worktree-compare"),
  gitWorktreeCompareDiff: post<
    Input<typeof projectGitWorktreeCompareDiffRequestSchema>,
    ProjectGitDiffResponse
  >("/api/project-git-worktree-compare-diff"),
  gitWorktreeMerge: post<
    Input<typeof projectGitWorktreeMergeRequestSchema>,
    ProjectGitWorktreeMergeResponse
  >("/api/project-git-worktree-merge"),
  gitWorktreeCleanup: post<
    Input<typeof projectGitWorktreeCleanupRequestSchema>,
    ProjectGitWorktreeCleanupResponse
  >("/api/project-git-worktree-cleanup"),

  // Checkpoints
  checkpointChanges: post<
    Input<typeof checkpointChangesRequestSchema>,
    CheckpointChangesResponse
  >("/api/checkpoint-changes"),
  checkpointDiff: post<
    Input<typeof checkpointDiffRequestSchema>,
    CheckpointDiffResponse
  >("/api/checkpoint-diff"),
  checkpointRestore: post<
    Input<typeof checkpointRestoreRequestSchema>,
    CheckpointRestoreResponse
  >("/api/checkpoint-restore"),
  checkpointDeleteChats: post<
    Input<typeof checkpointDeleteChatsRequestSchema>,
    CheckpointDeleteChatsResponse
  >("/api/checkpoint-delete-chats"),
  checkpointDeleteProject: post<
    Input<typeof checkpointDeleteProjectRequestSchema>,
    CheckpointDeleteProjectResponse
  >("/api/checkpoint-delete-project"),

  // Providers
  providerModels: post<
    NonNullable<Input<typeof providerModelsRequestSchema>>,
    ProviderModelsResponse
  >("/api/provider-models"),
  providerUsageLimits: post<
    Input<typeof providerUsageLimitsRequestSchema>,
    UsageLimitsResponse
  >("/api/provider-usage-limits"),
  cliUpdates: post<Input<typeof cliUpdatesRequestSchema>, CliUpdatesResponse>(
    "/api/cli-updates",
  ),
  cliUpgrade: post<Input<typeof cliUpgradeRequestSchema>, CliUpgradeResponse>(
    "/api/cli-upgrade",
  ),

  // Skills
  skills: post<Input<typeof skillsRequestSchema>, ProviderSkillsResponse>(
    "/api/skills",
  ),
  readSkill: post<Input<typeof readSkillRequestSchema>, SkillFileContents>(
    "/api/skills/read",
  ),
  createSkill: post<
    Input<typeof createSkillRequestSchema>,
    CreateSkillResponse
  >("/api/skills/create"),
  setSkillEnabled: post<
    Input<typeof setSkillEnabledRequestSchema>,
    { ok: true }
  >("/api/skills/set-enabled"),

  // Chat
  chatTitle: post<Input<typeof chatTitleRequestBodySchema>, ChatTitleResponse>(
    "/api/chat-title",
  ),
  toolApprovalResponse: post<
    Input<typeof toolApprovalResponseSchema>,
    ToolApprovalResolution
  >("/api/tool-approval-response"),

  // Other
  mcpImportCandidates: post<
    Input<typeof mcpImportCandidatesRequestSchema>,
    McpImportCandidatesResponse
  >("/api/mcp-servers/import-candidates"),
  /**
   * One route for every GitHub pull request action; the response depends on
   * the action, so the caller names it (`pull-requests/api.ts`).
   */
  codePullRequests: post<Input<typeof codePullRequestRequestSchema>, unknown>(
    "/api/code-pull-requests",
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
}

/** Sends one request; resolves with the JSON body or throws `ApiError`. */
export type ApiTransport = (request: ApiTransportRequest) => Promise<unknown>;

export const createHttpTransport =
  (fetchImpl: typeof fetch = (...args) => fetch(...args)): ApiTransport =>
  async ({ body, method, path, signal }) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = getApiSessionToken();
    if (token) {
      headers[API_SESSION_TOKEN_HEADER] = token;
    }

    const response = await fetchImpl(path, {
      body: JSON.stringify(body ?? {}),
      headers,
      method,
      signal,
    });
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
      transport({ body: request, method, name, path, signal: options?.signal });
  }
  return client as ApiClient;
};

/** The app's client, over HTTP to the local API server. */
export const apiClient = createApiClient(createHttpTransport());

// ── Raw file URLs ───────────────────────────────────────────────────────

/** A project file's bytes, for `<img src>` and blob loads. */
export const getProjectFileRawUrl = (projectPath: string, filePath: string) =>
  `/api/project-file-raw?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(filePath)}`;

/** A file's bytes as committed at HEAD. */
export const getProjectGitFileAtHeadRawUrl = (
  projectPath: string,
  filePath: string,
) =>
  `/api/project-git-file-at-head-raw?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(filePath)}`;

/**
 * Loads one of the raw file URLs above as a blob, failing with `ApiError`
 * the way the JSON routes do.
 */
export const fetchApiBlob = async (
  url: string,
  { signal }: ApiCallOptions = {},
): Promise<Blob> => {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const reason = await response.text().catch(() => "");
    throw new ApiError(url, response.status, reason.trim());
  }
  return response.blob();
};
