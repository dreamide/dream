// @ts-check
// The route table: every route a host serves over HTTP, by name, with its
// method, its path and who may call it from another device. A route's
// method and path are written here only. The host registers its handlers
// by these rows (electron/api/*-routes.js, through registerRoute), the
// remote listener's route policy reads each row's `remote`
// (host/auth/route-policy.js), and the renderer's route client builds its
// methods from the rows it calls (src/lib/api-client.ts). Handlers and
// request schemas stay beside the routes that use them; response shapes are
// the renderer's own declarations.
//
// A new route is a row here, its registration, and (when the renderer calls
// it as JSON) a route client row. electron/api/host-routes.test.js fails
// while the host registers a route this table does not list, or the table
// lists a route no listener registers.
//
// `remote` says what a paired device needs to call it on the remote
// listener:
//   view | operate | manage  that scope (host/auth/scopes.js);
//   public                   nothing: it grants nothing without a secret,
//                            and only the remote listener serves it;
//   local                    never served remotely: only this machine's
//                            own clients, holding the launch token.
// `remoteViewActions`, on a route whose body names an `action`: the actions
// that need only `view` (the others need the route's own scope).
//
// Kept out, because they are not routes a host registers by name: the
// remote listener's static client files (client-assets.js, its not-found
// handler), each listener's `/*` and `/api/*` middleware, and the desktop
// edge's forwarding of every other `/api/*` path and the host socket to its
// host (desktop-host.js).

/**
 * @typedef {import("../host/auth/scopes.js").Scope} Scope
 * @typedef {"GET" | "POST" | "PUT" | "ALL"} HostRouteMethod
 * @typedef {{
 *   method: HostRouteMethod,
 *   path: string,
 *   remote: Scope | "public" | "local",
 *   remoteViewActions?: readonly string[],
 * }} HostRouteSpec
 */

export const HOST_ROUTES = Object.freeze(
  /** @satisfies {Record<string, HostRouteSpec>} */ ({
    // The host itself, for this machine
    /** A daemon's clean stop, for its local operator (`dream-host stop`). */
    hostShutdown: {
      method: "POST",
      path: "/api/host/shutdown",
      remote: "local",
    },
    /** Process id and platform: the descriptor is the remote's view of a host. */
    hostInfo: { method: "GET", path: "/api/host-info", remote: "local" },

    // Agent CLIs on this host, with run-scoped or launch credentials
    orchestrationMcp: {
      method: "ALL",
      path: "/api/mcp/orchestration",
      remote: "local",
    },
    /** Shared-url turns (Codex): the project is the calling turn's. */
    browserMcp: { method: "ALL", path: "/api/mcp/browser", remote: "local" },
    /** Project-url turns (OpenCode, ACP). */
    browserMcpProject: {
      method: "ALL",
      path: "/api/mcp/browser/:projectId",
      remote: "local",
    },

    // The desktop window's own browser: a browser tool call from an SSH
    // host's agent (the result is the tool's MCP content)
    callBrowserTool: {
      method: "POST",
      path: "/api/browser-tools/call",
      remote: "local",
    },

    // The desktop's forwarding to its SSH hosts (host-proxy-routes.js)
    hostProxy: { method: "ALL", path: "/api/hosts/:hostId/*", remote: "local" },
    hostProxySocket: {
      method: "GET",
      path: "/api/hosts/:hostId/host-socket",
      remote: "local",
    },

    // Host catalog (projects, chats, transcripts)
    catalog: { method: "POST", path: "/api/catalog", remote: "view" },
    catalogSearch: {
      method: "POST",
      path: "/api/catalog/search",
      remote: "view",
    },
    catalogTranscript: {
      method: "POST",
      path: "/api/catalog/transcript",
      remote: "view",
    },
    catalogTranscriptPage: {
      method: "POST",
      path: "/api/catalog/transcript/page",
      remote: "view",
    },
    catalogChanges: {
      method: "POST",
      path: "/api/catalog/changes",
      remote: "operate",
    },
    saveCatalogTranscript: {
      method: "PUT",
      path: "/api/catalog/transcript",
      remote: "operate",
    },

    // Chats, runs and approvals
    /** A running turn's stream, for a client that reconnects. */
    chatStream: {
      method: "GET",
      path: "/api/chat/:chatId/stream",
      remote: "view",
    },
    chatQueue: { method: "POST", path: "/api/chat/queue", remote: "view" },
    /** An Agent turn, streamed (the AI SDK's chat transport). */
    chatTurn: { method: "POST", path: "/api/chat", remote: "operate" },
    submitChat: { method: "POST", path: "/api/chat/submit", remote: "operate" },
    controlChatQueue: {
      method: "POST",
      path: "/api/chat/queue/control",
      remote: "operate",
    },
    /** Stops the chat's running turn (dropping the request does not). */
    stopChatTurn: { method: "POST", path: "/api/chat/stop", remote: "operate" },
    chatTitle: { method: "POST", path: "/api/chat-title", remote: "operate" },
    toolApprovalResponse: {
      method: "POST",
      path: "/api/tool-approval-response",
      remote: "operate",
    },

    // Files
    /** A host's folders, for picking a project folder on it. */
    hostDirectories: {
      method: "POST",
      path: "/api/host-directories",
      remote: "operate",
    },
    /** The folder of a new standalone chat, created on its host. */
    createChatFolder: {
      method: "POST",
      path: "/api/chat-folders",
      remote: "operate",
    },
    projectDirectory: {
      method: "POST",
      path: "/api/project-directory",
      remote: "view",
    },
    projectFiles: {
      method: "POST",
      path: "/api/project-files",
      remote: "view",
    },
    readProjectFile: {
      method: "POST",
      path: "/api/project-file",
      remote: "view",
    },
    /** A project file's bytes (the query names it). */
    projectFileRaw: {
      method: "GET",
      path: "/api/project-file-raw",
      remote: "view",
    },
    searchProjectFiles: {
      method: "POST",
      path: "/api/project-search",
      remote: "view",
    },
    projectIcon: { method: "POST", path: "/api/project-icon", remote: "view" },
    writeProjectFile: {
      method: "PUT",
      path: "/api/project-file",
      remote: "operate",
    },

    // Git
    gitStatus: {
      method: "POST",
      path: "/api/project-git-status",
      remote: "view",
    },
    gitBranches: {
      method: "POST",
      path: "/api/project-git-branches",
      remote: "view",
    },
    gitBranchDeletePreview: {
      method: "POST",
      path: "/api/project-git-branch-delete-preview",
      remote: "view",
    },
    gitWorktrees: {
      method: "POST",
      path: "/api/project-git-worktrees",
      remote: "view",
    },
    gitRemoteUrl: {
      method: "POST",
      path: "/api/project-git-remote-url",
      remote: "view",
    },
    gitPushPreview: {
      method: "POST",
      path: "/api/project-git-push-preview",
      remote: "view",
    },
    gitLog: { method: "POST", path: "/api/project-git-log", remote: "view" },
    gitPullRequestDetails: {
      method: "POST",
      path: "/api/project-git-pull-request-details",
      remote: "view",
    },
    gitWorktreeCompare: {
      method: "POST",
      path: "/api/project-git-worktree-compare",
      remote: "view",
    },
    gitWorktreeCompareDiff: {
      method: "POST",
      path: "/api/project-git-worktree-compare-diff",
      remote: "view",
    },
    gitDiff: { method: "POST", path: "/api/project-git-diff", remote: "view" },
    /** A file's bytes as committed at HEAD (the query names it). */
    gitFileAtHeadRaw: {
      method: "GET",
      path: "/api/project-git-file-at-head-raw",
      remote: "view",
    },
    gitCheckout: {
      method: "POST",
      path: "/api/project-git-checkout",
      remote: "operate",
    },
    gitBranchDelete: {
      method: "POST",
      path: "/api/project-git-branch-delete",
      remote: "operate",
    },
    gitWorktreeCreate: {
      method: "POST",
      path: "/api/project-git-worktree-create",
      remote: "operate",
    },
    gitCommit: {
      method: "POST",
      path: "/api/project-git-commit",
      remote: "operate",
    },
    gitCommitMessage: {
      method: "POST",
      path: "/api/project-git-commit-message",
      remote: "operate",
    },
    gitPush: {
      method: "POST",
      path: "/api/project-git-push",
      remote: "operate",
    },
    gitFetch: {
      method: "POST",
      path: "/api/project-git-fetch",
      remote: "operate",
    },
    gitPull: {
      method: "POST",
      path: "/api/project-git-pull",
      remote: "operate",
    },
    gitCreatePullRequest: {
      method: "POST",
      path: "/api/project-git-create-pr",
      remote: "operate",
    },
    gitWorktreeMerge: {
      method: "POST",
      path: "/api/project-git-worktree-merge",
      remote: "operate",
    },
    gitWorktreeCleanup: {
      method: "POST",
      path: "/api/project-git-worktree-cleanup",
      remote: "operate",
    },
    gitRevertFile: {
      method: "POST",
      path: "/api/project-git-revert-file",
      remote: "operate",
    },
    gitRevertAll: {
      method: "POST",
      path: "/api/project-git-revert-all",
      remote: "operate",
    },
    /**
     * One route for every GitHub pull request action; the actions that only
     * read need `view`.
     */
    codePullRequests: {
      method: "POST",
      path: "/api/code-pull-requests",
      remote: "operate",
      remoteViewActions: [
        "comments",
        "context",
        "detail",
        "files",
        "list",
        "mergeInfo",
        "reviews",
        "threads",
      ],
    },

    // Checkpoints
    checkpointChanges: {
      method: "POST",
      path: "/api/checkpoint-changes",
      remote: "view",
    },
    checkpointDiff: {
      method: "POST",
      path: "/api/checkpoint-diff",
      remote: "view",
    },
    checkpointRestore: {
      method: "POST",
      path: "/api/checkpoint-restore",
      remote: "operate",
    },
    checkpointDeleteChats: {
      method: "POST",
      path: "/api/checkpoint-delete-chats",
      remote: "operate",
    },

    // Terminals (their output and input travel on the host socket)
    terminalShells: {
      method: "POST",
      path: "/api/terminal-shells",
      remote: "view",
    },
    terminalDiagnostics: {
      method: "POST",
      path: "/api/terminal-diagnostics",
      remote: "view",
    },
    terminalStart: {
      method: "POST",
      path: "/api/terminal-start",
      remote: "operate",
    },
    terminalStop: {
      method: "POST",
      path: "/api/terminal-stop",
      remote: "operate",
    },
    terminalStopAll: {
      method: "POST",
      path: "/api/terminal-stop-all",
      remote: "operate",
    },

    // Providers, skills and MCP servers
    providerModels: {
      method: "POST",
      path: "/api/provider-models",
      remote: "view",
    },
    providerUsageLimits: {
      method: "POST",
      path: "/api/provider-usage-limits",
      remote: "view",
    },
    cliUpdates: { method: "POST", path: "/api/cli-updates", remote: "view" },
    skills: { method: "POST", path: "/api/skills", remote: "view" },
    readSkill: { method: "POST", path: "/api/skills/read", remote: "view" },
    cliUpgrade: { method: "POST", path: "/api/cli-upgrade", remote: "manage" },
    createSkill: {
      method: "POST",
      path: "/api/skills/create",
      remote: "manage",
    },
    setSkillEnabled: {
      method: "POST",
      path: "/api/skills/set-enabled",
      remote: "manage",
    },
    mcpImportCandidates: {
      method: "POST",
      path: "/api/mcp-servers/import-candidates",
      remote: "manage",
    },

    // The host socket (live traffic: terminals, catalog events). The ticket
    // is bound to whoever asked for it, and each channel message is checked
    // by the route policy's socketMessageScope.
    hostSocketTicket: {
      method: "POST",
      path: "/api/host-socket-ticket",
      remote: "view",
    },
    hostSocket: { method: "GET", path: "/api/host-socket", remote: "view" },

    // Pairing (remote-access-routes.js): anyone may ask, it grants nothing
    // without a secret
    remoteProof: {
      method: "POST",
      path: "/api/remote/proof",
      remote: "public",
    },
    remoteDescriptor: {
      method: "GET",
      path: "/api/remote/descriptor",
      remote: "public",
    },
    remotePairCode: {
      method: "POST",
      path: "/api/remote/pair/code",
      remote: "public",
    },

    // Device sessions. Each checks the caller's own scope too: a device may
    // end its own session, a manager any.
    remoteSession: {
      method: "GET",
      path: "/api/remote/session",
      remote: "view",
    },
    remoteSessionRenew: {
      method: "POST",
      path: "/api/remote/session/renew",
      remote: "view",
    },
    remoteSessionEnd: {
      method: "POST",
      path: "/api/remote/session/end",
      remote: "view",
    },
    remotePairingCreate: {
      method: "POST",
      path: "/api/remote/pairings",
      remote: "manage",
    },
    remoteSessions: {
      method: "POST",
      path: "/api/remote/sessions",
      remote: "manage",
    },
    remoteSessionRevoke: {
      method: "POST",
      path: "/api/remote/sessions/revoke",
      remote: "manage",
    },

    // Remote access: a device with `manage` may read it; changing it is this
    // machine's own business, for its local operator.
    remoteAccess: {
      method: "POST",
      path: "/api/remote/access",
      remote: "manage",
    },
    remoteAccessEnable: {
      method: "POST",
      path: "/api/remote/access/enable",
      remote: "local",
    },
    remoteAccessDisable: {
      method: "POST",
      path: "/api/remote/access/disable",
      remote: "local",
    },
    remoteAccessCheck: {
      method: "POST",
      path: "/api/remote/access/check",
      remote: "local",
    },
  }),
);

/** @typedef {keyof typeof HOST_ROUTES} HostRouteName */

/**
 * `route`'s path with each `:name` segment replaced by `params[name]`,
 * URI-encoded: `routePath(HOST_ROUTES.chatStream, { chatId })`.
 * @param {{ path: string }} route
 * @param {Record<string, string>} params
 * @returns {string}
 */
export const routePath = (route, params) =>
  route.path
    .split("/")
    .map((part) => {
      if (!part.startsWith(":")) return part;
      const value = params[part.slice(1)];
      if (value === undefined) {
        throw new Error(`No ${part.slice(1)} for ${route.path}.`);
      }
      return encodeURIComponent(value);
    })
    .join("/");
