# Architecture backlog

Open work carried over from completed architecture task documents that were
deleted once their tasks were implemented. Each item was explicitly deferred,
excluded or left pending in its task and was still open when this list was
written. The originals are in git history:
`git log --diff-filter=D -- docs/architecture/tasks/`.

## Connections & remote hosts

- Paired devices act as the host's OS user with no project isolation: a view
  session can read any file by path, including a daemon's `host.json`. Team
  tenancy and per-project grants were never built. (was CONN-02,
  remote-connections.md)
- The optional LAN listener and automatic LAN discovery were deferred. Without
  HTTPS a browser cannot keep the `__Host-` session cookie, so a plain LAN route
  needs one of those first. (was CONN-05, remote-connections.md)
- A native mobile client and its push notifications are a separate, unscheduled
  project. It would reuse the host API, identity, device sessions and HTTPS
  routes, and needs its own specification before work starts. (was CONN-09 and
  CONN-10, remote-connections.md; DH-17, detached-host.md)
- A host-owned browser: a Chromium service on the execution host with
  persistent tabs, per-project storage, agent automation and streamed viewing
  and control, so an agent can browse with no desktop attached. Today the
  desktop window's browser is lent to the host. Audio and picture-in-picture
  would follow. (was CONN-11, remote-connections.md)
- A second tab of the same browser stays on the pairing screen after another
  tab re-pairs, until it is reloaded. (was CONN-04, remote-connections.md)
- SSH failures that `ssh` treats as fatal (a refused key, a changed host key)
  carry no refusal reason, so the connection reads as `offline` rather than
  `unauthorized`. (was ARC17-05, review-20261117.md)
- When removing a Tailscale Serve entry that Dream made for another port fails,
  Dream still forgets the entry. (was ARC17-08, review-20261117.md)
- The home host's catalog readiness is not tracked in `hosts`. A browser client
  that started while its home host was away counts it as ready once its
  connection is, before recovery has loaded its catalog. (was ARC17-07,
  review-20261117.md)
- Forgetting a host takes three separate calls in `host-actions.ts` (catalog
  baselines, host socket client, connection supervisor). (was CBL-01,
  catalog-baselines.md)
- Catalog event payloads are untyped: `CatalogEvent` is
  `{ kind: string; [key: string]: unknown }`. (was CBL-01, catalog-baselines.md)
- Chats waiting on an approval are not dropped from
  `hostAwaitingApprovalChatIds` when their project closes. (was DH-06,
  detached-host.md)
- The host route table does not drive everything: response shapes are only
  declared in the renderer's `api-client.ts` (the server has no response
  schemas), which listener registers a route is still decided in the
  registration code, and the desktop edge's server is not checked against the
  table. (was ARC17-14, review-20261117.md)

## Hosts & desktop

- The `dream-host` npm launcher has never been published. The release workflow
  skips it without an `NPM_TOKEN` repository secret (none is set) and needs the
  `dream-host` package name. Installing against a published release archive was
  never exercised either. (was DH-04, detached-host.md; CONN-06,
  remote-connections.md)
- The OS-held state lock does not notice its lock file being deleted while it
  is held. (was DH-01, detached-host.md)

## Chats & turns

- The renderer still writes its own copy of the chat row's Provider session in
  `chat-runtime.ts` and clears it on a model or speed change. Removing the copy
  touches the codec, `src/types/ide.ts`, branching, stash and the delegation
  store. (was PSD-01, provider-session-decision.md; ARC17-01,
  review-20261117.md)
- Renderer finish saves of a transcript remain beside the host's turn saves.
  Removing them needs host-owned chat metadata and durable user answers.
  (was PERF-01, v0.26.0-performance.md; PDRY-01, transcript-cache-ownership.md)
- Commit-message warming after a turn still lives in `chat-runtime.ts`.
  (was FOL-01, turn-following.md)
- Codex subagent threads are not reported as sessions, so their browser tool
  calls fall back to the newest-turn guess instead of their own project.
  (was ARC17-06, review-20261117.md)
- Delegation has no automatic parent wake-up when a child finishes (parents
  poll `task_status`) and no isolated worktrees for child chats.
  (was ORCH-05, host-orchestration.md)
- Standalone chats: the `~/.dream/chats` root is not configurable (was SC-01);
  showing another standalone chat closes the previous project and stops its
  terminals (was SC-02); and there is no way to browse or delete chat folders
  that outlived their chats because they hold files (was SC-05).
  (standalone-chats.md)
- The draft clear inside `setMessagesForChat` was not moved into the workspace
  document, because it sits on the streaming hot path. (was WSDOC-01,
  workspace-document-removals.md)

## Providers

- Cursor and Antigravity get no Dream-managed MCP servers (`mcp: false`), so
  neither can initiate delegation. (was AGY-01, antigravity-provider.md;
  ORCH-05, host-orchestration.md)
- Antigravity's `ask` permission mode runs `--mode plan`; interactive mid-turn
  approval was deferred. (was AGY-01, antigravity-provider.md)
- Antigravity gets attachments only as text descriptions, not files it can
  open; nothing probes its `--conversation` before sending, so a resume is
  reported without being checked; and it has no skills discoverer, so Settings >
  Skills does not list it. (was ARC14-07 and ARC14-08, review-20261114.md)
- Reconstructed history is bounded to Codex's limits (about 175,000 tokens) for
  every text adapter; bounds sized to each Provider's context window were
  deferred. (was ARC14-07, review-20261114.md)
- One-shot agent CLI runs: no caller passes a `signal`, so chat titles and git
  text cannot be stopped; Grok's `timeoutMs` bounds only the prompt request
  (initialize, authenticate and session creation keep the 30-second ACP
  default); Cursor still passes the prompt as an argument through `cmd.exe` on
  Windows; and the ACP connection and Codex app server keep their own spawn and
  lifetime (Codex's stderr tail is 20,000 characters, the shared one 64,000).
  (was ARC14-04, review-20261114.md)
- Claude credentials: a 429 refreshes the token (rotating the refresh token);
  a refresh whose write-back fails can leave a dead stored token; the keychain
  write passes the whole credential document as a `security` argument, visible
  to other processes; two concurrent 401s each refresh with the same token; and
  `withAccessToken` relies on a `status` that only `fetchClaudeUsageWithToken`
  sets. (was ARC17-13, review-20261117.md)
- Grok credentials: an expired credential is sent when it is the only one, and
  an expiry too large for a `Date` throws a `RangeError` instead of answering
  "Run `grok login`". (was ARC17-13, review-20261117.md)
- `codex-auth.js` is plain functions with no tests; it was not made a factory
  over injected sources like the other Provider auth modules. (was ARC17-13,
  review-20261117.md)

## Git

- A branch's base is not fully consolidated: the status's `baseBranch` and the
  branch list's base block still come from `defaultBranch`, not `baseOf`;
  current-branch reads and `getGitDiffBaseRef` were left where they are; and
  GitHub's own default branch is never asked, so a repository whose base only
  GitHub knows offers no pull request. (was ARC17-03, review-20261117.md)
- The pull request description sanitizer strips only a lone opening fence, so a
  description the model wraps in a ```` ```markdown ```` fence keeps it.
  (was ARC17-10, review-20261117.md)
- Generated git text is cached by each change's path, status and line counts,
  not its content, so an edit that keeps the counts reuses the earlier message
  on both host and renderer. (was ARC17-10, review-20261117.md)
- Committing with no message from the host ("commit, push and create" with
  generation off) generates on `openai` with no model. (was ARC17-10,
  review-20261117.md)
- The pull request panel reads comments and files in GitHub's raw shape
  (`html_url`, `user.login`), and `createProjectPullRequest` runs `gh pr create`
  from `actions.js` rather than through the pull requests module.
  (was GHPR-01, github-pull-requests.md)
- The write-file chip in chat transcripts reads git status and diffs by path
  alone, without the Project's host; `projectResourceKey` and the raw file URLs
  accept no host for it. (was ARC14-02, review-20261114.md)
- The worktree dialog's per-file compare diffs (`CompareFileRow`) load inside
  the dialog rather than as Project resources. (was FWT-01, worktree-finish.md)

## Files & workspace

- Files panel drafts are not kept across a restart or a project close.
  (was FES-01, file-editor-session.md)
- The file tree takes the files refresh key as `refreshVersion` instead of
  reading through Project resources. (was PFT-01, project-file-tree.md)
- Saved-prompt row mapping is still in `persisted-state.js` rather than the
  codec, and `loadPersistedCatalog`, `loadPersistedChatMessages` and
  `searchPersistedChatMessages` are exported only for tests. (was WSP-01,
  one-workspace-save-path.md)
- The xterm view still reads the terminal output buffer and sends resizes
  itself, outside the Terminal session owner. (was ARC14-05, review-20261114.md)

## Performance

- No filesystem watcher: external changes to a repository are seen on the next
  volatile read, and stable facts expire on the repository context's policy.
  (was PERF-03, v0.26.0-performance.md)
- Project and chat changes still encode the whole workspace before diffing it.
  (was PERF-06, v0.26.0-performance.md)
- The turn registry keeps every byte of a running turn for replay. Bounded
  message-so-far reconnect replay was not built; it changes the host socket's
  resume contract. (was PERF-07, v0.26.0-performance.md; PERF11-01,
  review-20261111-performance.md)
- A turn's save cost grows with its length, because each step rewrites the
  whole message. Storing a message's parts as rows, so a step appends, is a
  schema change. (was SQL-03, sqlite-read-pool-write-sink.md)
- Transcript search's `LIKE` folds ASCII case only. (was SQL-01,
  sqlite-read-pool-write-sink.md)
- A project's first checkpoint capture can still pass the 20-second turn budget
  on very large projects, so that turn runs without a checkpoint.
  (was PERF11-06, review-20261111-performance.md)
- The catalog loads twice at launch (hydration, then the socket's first reset,
  45 to 105 ms). Removing the second needs catalog responses to carry the event
  cursor. (was PERF11-07, review-20261111-performance.md)
- There is no React render-count harness or DOM test environment, so the
  render savings of structural sharing, catalog rows by identity, the
  live-transcript subscription and shown-only Project resources are inferred,
  not measured. (was PERF-02, v0.26.0-performance.md; PERF11-02 to PERF11-04,
  review-20261111-performance.md)

## Code cleanup

- Nine `IdeState` members have no caller: `getActiveChat`,
  `getChatsForProject`, `setChatSort`, `setPanelSizes`, `setOutputPanelOpen`,
  `setModelSearchQuery`, `setProviderModels`, `startRunner` and `stopRunner`.
  (was ARC17-11, review-20261117.md)
- The `alreadyStreaming` message is unused in `chat-runtime.ts` and the
  locales. (was ARC17-02, review-20261117.md)
- The temporary attachment list in `electron/host/chat-attachments.js` says
  "[also passed via --image]" for images, which no adapter does.
  (was ARC14-07, review-20261114.md)
- `// @ts-check` on `electron/host/index.js` and `electron/desktop-host.js`, so
  tsc holds them to `HomeHost`, needs their existing implicit-any and
  parameter-type errors fixed first. (was ARC17-12, review-20261117.md)

## Missing automated tests

- The HTTPS route adapter, including its TLS host-key proof. (was ARC17-04,
  review-20261117.md)
- `remote-cli.js` and the daemon's remote access start-up line. (was ARC17-08,
  review-20261117.md)
- Codex's 10-second interrupt confirmation timeout through the adapter.
  (was ARC17-09, review-20261117.md)
- OpenCode one-shot text and usage stats, beyond the server module's tests.
  (was OCS-01, opencode-server.md)
- Antigravity's start report (`turn.session` resumed or reconstructed); its test
  covers only the resumed launch. (was PSD-01, provider-session-decision.md)
- Project file traversal: subtree listing and listing cancellation.
  (was PDRY-02, project-file-traversal.md)
- Project search budget: dense-line caps, exact limit versus truncation,
  partial-line cancellation and read cleanup. (was PDRY-03,
  project-search-budget.md)
- Chat transcript cache refresh races and eviction. (was PDRY-01,
  transcript-cache-ownership.md)
- Overlapping saved-route edits (`saved-host-connection-edits.ts` has no test
  file). (was SAVED-ROUTES, review-20261109.md)
- Flaky tests recorded and not investigated: the `run-scheduler.test.js`
  timing test, "bad port" in `host-proxy-routes.test.js` and
  `catalog-two-clients.host.test.ts`, `desktop-host.test.js` under load, and
  git timeouts in `electron/api/checkpoints/service.test.js`. (was PGW-01,
  project-git-writes.md; CONN-01 and CONN-06, remote-connections.md; ARC14-01
  and ARC14-04, review-20261114.md; ARC17-05, review-20261117.md; PERF11-06,
  review-20261111-performance.md)

## Manual verification

Checks that were never run. They are not features; each needs a real host,
network, platform, provider or a person looking at the running app.

### Real networks and hosts

- A real Cloudflare tunnel with a user-run `cloudflared`: turning access on,
  edge Host/Origin/cache behaviour, browser and desktop pairing,
  streaming/socket continuity, approvals, sleep and network recovery, and a
  stopped connector turning the route not ready and back. Also an older desktop
  against this host and this desktop against an older host. (was CONN-08,
  remote-connections.md; ARC17-08, review-20261117.md)
- Real Tailscale Serve with HTTPS certificates on: a pairing walkthrough,
  streaming and WebSockets through Serve, live reconfiguration, the checking,
  ready and off states, and Linux operator permissions. (was CONN-05 and
  CONN-07, remote-connections.md; ARC17-08, review-20261117.md)
- A real SSH host: the managed runtime install, a first connect that prompts
  and a background probe that does not, concurrent prompts from two hosts,
  killing the session or network (reconnect, forwarded port back at the same
  local address), a host replaced behind the same target (shown incompatible at
  once), delayed catalog reads, and Wi-Fi/VPN/cellular changes.
  (was CONN-01 and CONN-07, remote-connections.md; DH-19, detached-host.md;
  SSH-PROMPT and SAVED-ROUTES, review-20261109.md; HCL-01, review-20261018.md;
  ARC-02, review-20261025.md; FOL-01, turn-following.md; ARC17-04 and ARC17-05,
  review-20261117.md)
- A paired HTTPS route: pairing a second desktop and a browser by code,
  revoking the device (route blocked, shown unauthorized, including when the
  catalog request is the one refused) while a host restart only cools it down.
  (was DH-18, detached-host.md; ARC17-04 and ARC17-05, review-20261117.md)
- A browser client: its home host going offline (notice, refused send, file
  tree coming back), the visibility resume path, a dropped chat stream during
  socket replacement, the 5-second terminal-input window, signing out, two
  browser clients editing one catalog, and an SSH host's browser lending after a
  route change. (was CONN-03, remote-connections.md; ARC17-07,
  review-20261117.md)
- A live reconnect over a slow or dropped link, downloading only the turn's
  tail. (was DH-05, detached-host.md)

### Platforms and packaging

- macOS and Linux packaged runs of the desktop's own host (start, reuse,
  replace, stop at quit, attach to a user-started `dream-host`).
  (was DH-02 and DH-09, detached-host.md)
- `install-host.sh` on Linux and macOS, and the PowerShell installer's user
  PATH change. (was DH-04, detached-host.md)
- The systemd `--user`, launchd and Task Scheduler examples in the "Run the
  host" docs. (was DH-10, detached-host.md)
- Device credentials in the native Windows and Linux secure stores.
  (was CONN-07, remote-connections.md)
- The packaged app's window load and first paint after the startup change, and
  the development overlap of Vite and the host. (was PERF11-07,
  review-20261111-performance.md)

### Desktop launch

- First start, a second desktop on the same workspace (the refusal dialog),
  `DREAM_HOST_MODE=in-process`, a detached host falling back, quitting with
  unsaved workspace changes, and a reload with live terminals.
  (was ARC14-06, review-20261114.md; DH-02, detached-host.md)
- The desktop bridge: the saved theme with no flash, theme and colour changes
  across a reload, Ctrl+R with a terminal running, screenshot copy/save/show in
  folder, a notification click, an SSH password prompt, and window controls on
  Windows. (was DSK-01, desktop-bridge.md)

### Live providers

- Stopping a turn in Codex, OpenCode, Cursor and Grok, once while it starts and
  once mid-answer. (was ARC17-09, review-20261117.md)
- Two Codex chats in two projects at once, each using the browser on its own
  project's tabs. (was ARC17-06, review-20261117.md)
- Native forks and resumes against real CLIs. (was ORCH-02,
  host-orchestration.md; PSD-01, provider-session-decision.md)
- A live turn on each provider being saved while it runs, and a long
  transcript's turn timed in the app. (was PERF11-01 and PERF11-05,
  review-20261111-performance.md)
- Real CLIs for the one-shot runs (titles, commit messages, pull request text),
  and a real `opencode` server. (was ARC14-04, review-20261114.md; OCS-01,
  opencode-server.md)

### In-app UI checks

- Settings > Connections in a desktop window, both themes: the SSH host form,
  Pair a computer's code view, Revoke all with several clients, and the
  version notice. (was DH-11, DH-12, DH-18, DH-19 and DH-21,
  detached-host.md)
- The "Waiting for you" approval indicator. (was DH-06, detached-host.md)
- Settings > Providers in light and dark: logos and marks, OpenCode tabs after
  leaving the section, refresh, enable and upgrade on one card.
  (was ARC14-08, review-20261114.md)
- The open-project dialog on desktop and in a browser client: keyboard
  completion, SSH connect states, Add SSH host, Browse…, the native picker, both
  themes. (was OPEN-01, open-project-flow.md; D26-03, review-20261026.md)
- The Chats tab end to end: creating, listing, swapping and deleting standalone
  chats, composer focus after each entry point, the refusal toast, two hosts in
  one list, and git features after `git init` in a promoted chat.
  (was SC-03 and SC-04, standalone-chats.md)
- Git panel flows: expand-all and revert in the Changes tab, refresh while a
  diff shows, commit and commit-and-push, the worktree commit dialog, a failing
  PR generation, push/pull/fetch from the footer (commit buttons disabled
  meanwhile), branch switching, creating a PR, the PR panel on open, merged and
  failing-checks branches, the branch actions menu, Git history paging, and
  both worktree finish dialogs (merge conflict, dirty worktree, unmerged branch,
  retry). (was CDR-01, changes-diffs-as-resources.md; CDG-01,
  commit-draft-and-generated-git-text.md; PGW-01, project-git-writes.md;
  GHPR-01, github-pull-requests.md; PRR-01 and GLP-01, review-20261018.md;
  ARC14-03, review-20261114.md; FWT-01, worktree-finish.md)
- Files: opening from a Claude Code read chip, a draft surviving a view switch,
  closing a dirty tab, reopening a file changed on disk, expanding and
  filtering the tree, and a chat open revealing the file. (was FES-01,
  file-editor-session.md; PFT-01, project-file-tree.md)
- Chat: composer drafts (typing, picking a file, history Up/Down, sending, the +
  menu, surviving a panel unmount, both stash composers), the spinner and commit
  box for another client's turn, a streaming turn with a hidden column and a
  background project, and right-panel view switching latency. (was DRF-01,
  chat-drafts.md; ACT-01, chat-activity.md; PERF11-03,
  review-20261111-performance.md; RPN-01, right-panel-navigation.md)
- Browser panel tab operations and agent browser commands in live webviews,
  and multi-host UI where two hosts share a project path. (was BTN-01 and
  PRR-01, review-20261018.md; ARC14-02, review-20261114.md)
- Settings changes that settle models (unpicking a chat's model, disabling a
  provider) and the chat sort surviving a restart. (was MSS-01,
  model-selection-settle.md; PFO-01, persisted-fields-once.md)
- Transcript pagination's load-earlier scrolling, and host git processes per
  refresh bump counted in the app. (was ORCH-03, host-orchestration.md;
  PERF11-04, review-20261111-performance.md)
