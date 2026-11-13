# Glossary

Canonical names for the concepts in Dream's code. When a file uses a
different word for one of these, the word here is the one to move toward.

## Project

A directory the user has opened in Dream, with its own chats, UI layout and
model selection. `ProjectConfig` in `src/types/ide.ts`. A project is **open**
(in the tab strip) or **closed** (kept in the closed list so it can be
reopened with its chats intact).

An **open-project attempt** is one request from the open-folder dialog to
open a typed or selected directory on a chosen Host. Dismissing the dialog,
changing the Host or path, or starting another attempt retires the old one;
late results from it cannot open a Project.

## Project file traversal

The recursive selection of a Project's regular files for file-name lookup,
Composer mentions and text search. It skips blocked directories, symlinks and
paths excluded by any applicable `.gitignore` on the way down. Selecting a
subdirectory keeps ancestor ignore rules and paths relative to the Project.
The directory browser has a different purpose: it shows immediate entries,
including ignored files and symlinks. Text search further filters the selected
files by content, size and the user's query options.

## Project file tree

The Files panel's tree of a Project's files
(`src/components/ide/project-file-tree.ts`): one `@pierre/trees` model, its
directories listed as they are expanded and never while the tree's filter
is open. Typing a filter injects matching paths from a cached flat index
instead of walking folders. Revealing a file loads and expands its
ancestors; a file absent once the root has loaded is **missing** (its tab
closes), one overtaken by a refresh is **superseded**. The directory
loader and path index are its internals. Not the directory browser, and
not Project file traversal (which is the host's side of the file list).

## Project search work budget

The maximum number of individual matches a Project text search retains across
all files and lines. A dense line can use the remaining budget without retaining
every match on that line. Finding one additional match makes the result
**truncated**; reaching the limit alone does not prove more matches exist.
Cancelled searches return only the matches collected before stopping.

## Worktree

A project that is a git worktree of another project's repository.
`ProjectConfig.worktree` (`ProjectWorktreeInfo`) is non-null; the parent
project is `parentProjectId`. Its lifecycle is one module on each side of
the route seam. The main process's **worktree lifecycle**
(`electron/api/project-git/worktree-lifecycle.js`) lists, creates,
compares, merges and forgets worktrees over the one git runner. The store's
**worktree actions** (`src/components/ide/store/worktree-actions.ts`)
create, attach, complete, forget and purge worktree projects, and build the
worktree record in one place. To **forget** a worktree is to remove its
checkout, its branch once merged, and what Dream kept for the directory
(checkpoints); to **purge** it is to drop the app's own record of it, chats
included. A worktree git has already forgotten is answered as gone (404),
never by matching the error text.

**Finishing a worktree** (`src/components/ide/git-actions/worktree-finish.ts`)
is merging its branch into its base, removing it, or both. A worktree
project's Git actions dialog and the projects panel's remove dialog render
the same flow. It decides when a worktree may be removed (its status read,
uncommitted changes only when discarded, its branch only after an unblocked
delete preview) and when it may merge. It purges a worktree only after git
has removed it. The dialogs differ only in when they purge: on closing, or at
once.

## Branch deletion

Deleting a local branch (`electron/api/project-git/branches.js`). A branch is
**merged** when every commit is in the repository's base branch, locally or on
its remote. A merged branch can simply be deleted; an unmerged one (a
squash-merged pull request's branch looks like one) only against a **confirmed
head**, the commit the **delete preview** showed, so a branch that has moved
since is kept. The current branch, the base branch and the main checkout's
branch are never deleted. A branch checked out in a linked worktree goes only
with that worktree. Remote branches are not touched.

## Project runtime state

The maps the store keeps per project outside the project record: refresh
keys, terminal sessions and their status, browser tab loading, the draft
chat. They are registered in `store/project-runtime-state.ts`, which is
what closing or purging a project drops; a new per-project map is added
there, once. Every workspace removal reaches the store through
`commitWorkspaceRemoval`, which stops the removed projects' terminals and
then drops their runtime state, so no path that removes a project or chat
leaves a shell or a map behind.

## Chat

One conversation with an agent inside a project. `ChatConfig`, `chatId`.
Every open project has at least one live chat, and the project's UI names
which one is active. A chat is **soft-deleted** when `deletedAt` is set.
A **draft chat** is an empty chat a project shows again on "new chat"
instead of creating another (`draftChatIdByProject`); a chat stops being
one once it has messages. A **default chat** is the chat a project gets
when it has none, built by `createDefaultChatConfig` in the codec from the
workspace's default model.

Older code calls this a _thread_; the chat runtime calls a running one a
_session_; _remote conversation_ is the provider's id for it (see Provider
session). All of them mean chat.

**Chat attachment files** (`electron/host/chat-attachments.js`) are a chat's
non-image attachments saved beside the state database for agents to open. The
transcript holds the bytes, so the files are a cache: each turn rewrites what
is missing, and they are removed once the chat's row is gone. Claude uses them;
other providers still write per-turn temporary copies.

Temporary attachment files belong to the Agent turn from preparation through
provider completion. A failed preparation or a stopped turn releases them too;
a client ceasing to observe the turn does not. Attachment content descriptions
use the same decoding and naming rules whichever Provider reads them.

## Chat transcript cache

The transcripts this client currently holds for its chats. It owns both the
first load of a transcript and refreshes when the host catalog says it changed.
A transcript is **known saved** only when its retained messages match a saved
snapshot; merging in a local answer can make it unsaved again. Live consumers
and unsaved messages protect a transcript from eviction.

The chat view loads the latest **transcript page** (40 messages, a soft
1 MiB byte budget that keeps at least one complete message). Row cursors
load earlier history. `transcriptPageByChatId` records the loaded boundary;
branching explicitly loads the full transcript, host dispatch reads full
history, and saving a partial page merges by message ID on the writer.

## Chat activity

What a Chat is doing, as this window's sessions and its host both see it
(`src/components/ide/chat-activity.ts`). There are three questions, each with
one answer:

- **Running:** a turn runs, followed here or not. Another client's turn
  counts.
- **Waiting on its user:** a question or tool approval is open, here or on
  the host.
- **Accepts a message:** no session here streams the chat and no message is
  queued for it. A turn on the host does not block a message, because the
  host queues runs.

Whether this window's own session is busy, and which transcripts it keeps, are
about this window rather than the chat, so the chat runtime and the
transcript cache answer them.

## Live transcript

What a chat panel shows of its Chat's runtime session while a turn streams
(`getChatSessionView` in `src/components/ide/chat/chat-runtime.ts`): the
session's messages, published at most once per stream update interval
(50 ms), and its status and error at once. The session reads its `Chat`
once per update, for its own bookkeeping and every panel; a panel watches it
only while its Project is shown (`useLiveTranscript`), so a hidden column or
a Project in the background is not rendered again by a running turn, and
reads the session afresh the moment it is shown. Session files are worked
out per message object, so a live turn re-reads only its own message.

## Workspace document

One client's **workspace**: which projects (on which hosts) are open or
closed, which chats are open, the draft per project and which project is
active. Moving toward holding only that view; projects, chats and
transcripts themselves belong to the host catalog (today the document still
carries them):
`store/workspace-document.ts`. Every operation on it (open, close, set,
activate and remove projects; remove a host's projects; apply a host's
catalog changes, load a host's catalog, adopt a project the host refused;
restore at startup; add, add beside, branch, focus, delete, remove, restore
chats; close, reorder and size chat columns; toggle multi-chat) is a pure function ending in `settle`, which
enforces the one invariant the app relies on: every open project has a
live chat, its active chat is one of them, its open chats are live chats of
that project with the active one among them, and the active project is
open. An operation that can take projects or chats out returns a
**workspace removal**: the next document and the ids of everything that
left it. The zustand actions are thin wrappers around these operations; the
main process settles persisted state with the same codec primitives, and
raw rows from a host are validated by the codec's `decodeCatalogEntries`
before the document settles them. Rows the document already holds are not
decoded again, a row arriving equal to the held one is the held one, and a
list whose rows all held keeps its identity: a host's change to one chat
replaces that chat alone, and a catalog reloaded unchanged changes nothing
the store or the save scheduler would notice.

## Provider session

The provider-side identity of a chat's conversation, used to resume it:
`remoteConversationId`, `remoteConversationModel`,
`remoteConversationModelSpeed`, `remoteConversationProjectPath`. Not a chat.
Older code and docs call this the _remote session_; "remote" there means the
provider's side, never another machine (see Host).

The host retains one handle and transcript-coverage fingerprint per chat
and provider in `provider_sessions`. Returning to a provider resumes only
an unchanged covered prefix, with missed text and tool results supplied as
context; invalid coverage reconstructs. Supported adapters keep sessions
across model changes. A **native fork** creates an independent provider
session at the source assistant message's recorded native boundary;
unverified or unsupported boundaries reconstruct from canonical history.

Each Agent turn's Provider session (`electron/api/chat/provider-session.js`)
decides what the turn starts from. It tells the adapter which native session
to resume and what the provider missed (the **handoff**), then keeps the
session the turn reported. A turn starts in one of four ways: **resumed**;
with a **delta** handoff; from a **native fork**; or **reconstructed** from
the full history. Its message records which as its **context transfer**,
taken from the adapter's report. So when the provider no longer has the
session, the message records the reconstruction that actually happened. The
chat row's copy of the session is a mirror for "Continue in terminal";
nothing reads it to decide a resume.

## Host

The machine whose filesystem, agent CLIs and terminals a project uses. The
**local host** is the machine Dream's window runs on; an **SSH host** is
another machine Dream reaches over SSH; a **paired host** is one reached
over HTTPS with a device session. Not to be
confused with a provider session, which lives on the provider's side
whatever the host.

An **SSH prompt** belongs to the connection attempt that asked it, even when
several Hosts connect at once. Declining it cancels that attempt alone;
replacing or disconnecting the attempt makes its late answers ineligible.

## Host identity

Who a host is, however it is reached (`electron/host/identity.js`): a
**persistent host ID** and an Ed25519 key pair, created once per host data
directory and kept across restarts, runtime upgrades and address changes.
The **host descriptor** (ID, key fingerprint and public key, protocol,
capabilities, version; no paths or credentials) is listed with every
catalog, and a client checks it before applying that catalog. An ID match
is a consistency check, not authentication: the route vouches for the host
(this app's own process, an authenticated SSH session). A route that cannot
vouch for it verifies the key instead.

## Saved host connection

One client's record that a **client connection ID** reaches a persistent
host, and by which **routes** (`electron/shared/host-connections.js`,
`hostConnections` in persisted state). The connection ID is what that
client's projects, workspace rows and requests name a host by: `local`, a
legacy SSH id, or a remote connection id. A **route ID** names one way of
reaching the host (local, SSH, or paired HTTPS). The record is saved on the route's
first verified catalog load; until then a connection routes by its ID
alone. After that, a route that reaches another host is refused. A second
connection that authenticates the same host merges its routes into the
existing connection. A catalog whose project or chat IDs collide with another
host's is refused. The local
route is never refused. Device and session IDs belong to remote
authorization, which is a separate concern.

A saved connection edit is accepted against the current connection, after
verification. An accepted edit or removal supersedes verification already
under way; its late result cannot restore a removed route or Host. Credentials
and SSH settings go only when no saved route still uses them.

## Home host

The host a client's `local` connection reaches. On the desktop it is the host
running on the desktop's database, found from its state lock whoever started
it, or else one the desktop starts (`createHomeHostAttachment` in
`electron/desktop-host.js`: `dream-host serve --owner desktop` in its own
process); with `DREAM_HOST_MODE=in-process` it is the host inside the app
(route `local`). The desktop manages only its own process: a host a desktop
started is stopped when it quits and replaced when its version differs; a
host the user started with `dream-host` is attached to and left running. The
attachment verifies the state database owner and the existing host identity
before forwarding requests. In a browser it is the
paired host serving the page (route `origin`), pinned like any address.
Projects without a `hostId` live on the home host. A desktop always has one.

## Host mode

How a desktop launch runs its home host (`electron/desktop-host-mode.js`):
`DREAM_HOST_MODE=in-process` when set; the host in this
process while the workspace shares the state database's writer; otherwise
**detached** (the Home host in its own process). It is not a setting in the
app.

## Desktop startup

What a desktop window waits on at launch is `electron/renderer-server.js`'s
`start()`: the home host and the renderer start together. In production the
window loads at once, and the renderer's server holds `/api` requests and
socket upgrades until the host listens (`whenHostListening`); in
development the window waits for Vite and the host both, since Vite's proxy
cannot hold a request. A host that cannot start, nor fall back to the
desktop's process, still ends the launch. The catalog then loads as it
always has: the window's first catalog read waits for the host.

## Host options

Every option a host starts with (`electron/host/options.js`): a flag and an
environment variable each, resolved flag, then variable, then a setting the
host saved (remote access), then the default, with the source of each value
kept. `dream-host help` and the table in `docs/host-service.md` come from it.
Options belong in documentation, not the app. Remote access set by
`--remote-port` reports where it came from, and Settings shows it read-only
with the reason.

## Connections settings page

Desktop only; a browser client does not have it. **Remote hosts** is the hosts
this app uses. **Remote access** is this computer's own host: remote access,
paired devices and pairing a device
(`src/components/ide/settings/sharing-access-section.tsx`). Dream never changes
another machine's sharing; that is done on that machine (its own Dream, or
`dream-host remote` and `dream-host pair`).

## Connection runtime

The client's way to reach its hosts (`src/lib/connections/`). The **client
platform** (desktop or web) supplies the workspace storage (main-process IPC
or IndexedDB), the home route and desktop-only services. The **host
endpoint** layer is the only place a credential is attached: the launch
token on the desktop, the session cookie in a browser. It accepts only a
host's `/api/` paths and never follows a redirect. The **connection
supervisor** keeps each host's connection state (`connecting`, `ready`,
`reconnecting`, `unauthorized`, `incompatible`, `offline`), apart from
catalog readiness, and turns lifecycle signals into resumes: sockets
replaced, catalogs refetched, running turns followed again.

A connection's **selected route** is the verified route currently carrying its
requests; a **fallback route** carries them while a more preferred route is
unavailable. Its **route supervisor** (`electron/shared/route-supervisor.js`)
owns that selection, and the **desktop connection adapter**
(`electron/connections/desktop-connections.js`) owns its SSH endpoints and
paired HTTPS transports and stable local port forwards, independently of the
host's process lifetime. A native **device credential** is a private grant for
one verified host and HTTPS origin, separate from exported connection metadata.

**Connection recovery** coordinates those resumes per host. Refused hosts
remain quiet until their credential or route changes. Replacing a connection
invalidates pending work from the old connection; chat observation resumes
after the fresh catalog is accepted. Recovery never resubmits a write.

## Browser client

Dream's renderer in a plain browser, served by a paired host's remote
listener (`electron/api/client-assets.js`). Its home host is that origin;
its workspace is in IndexedDB; it pairs on the pairing screen
(`src/components/remote/`) and signs out from Settings. It has no SSH hosts
and no webview browser. It is for a computer's browser: Dream has no phone
layout (mobile is a separate, future project).

## Workspace database

The desktop's own SQLite file (`<name>.workspace.db`,
`electron/workspace-database.js`): its config and settings, saved prompts
and workspace rows. It sits beside the host's state database, which holds
the catalog. Each file has one writer: the desktop's save queue for the
workspace, the host's for the catalog. Every write to either file is a named
**state write** (`electron/state-writes.js`), the write side of the
catalog's named reads. The save queue takes it by name, in order with the
rest, and its worker runs it in a transaction of its own. A desktop that
shares its database with its in-process host lends the host that same
queue. One host runs per state database,
held by its **state lock** (`electron/host/state-lock.js`): an exclusive
SQLite transaction on `<state db>.host-owner` that the operating system
releases however the host ends, described by `<state db>.host-lock` (who
holds it). One desktop runs per workspace database, by the same lock on that
file. An existing workspace moved out of the
state database once, from a backed-up copy, leaving the original untouched.

## Edge listener

The desktop's API port when its home host runs in another process
(`electron/desktop-host.js`): it forwards the home host's HTTP/streams and
socket, replacing the desktop token with the host's token. SSH forwarding and
browser tool execution stay in the desktop. Closing the edge detaches its
clients; host turns and terminals keep running in a host the user started. A
fresh desktop discovers surviving terminals for its known projects.

Keeping a host running without the desktop is the user's: `dream-host serve`
under their own service manager (`docs/host-service.md`). Dream manages no
services.

## Remote access

Whether a host serves paired devices, and how (`electron/host/remote-access/`).
It is the host's setting, saved beside its state database: on or off; through
**Tailscale Serve** (HTTPS on the tailnet) or **Cloudflare Tunnel**; and a
stable loopback port for the remote listener.
An address is **ready** only once a request through it reached this host;
Cloudflare also requires proof of the host's installation key. The user runs
the tunnel's cloudflared connector; Dream never installs, starts or stops it.
Dream changes only the Serve entry it created (`servedBy`).
Configured in Settings > Connections on the host's own computer, or with
`dream-host remote` on a headless machine. Started with `--remote-port` (and
its variables), a host serves paired devices through the user's own reverse
proxy for that run (`mode: "proxy"`), and Settings shows it read-only.

## Remote access state

**Remote access state** is the operator's current view of Remote access
and Device sessions. A successful change supersedes older
reads; a failed refresh preserves the last accepted state. Form drafts are
the operator's edits and do not follow background refreshes.

## Device session

A paired device's credential on one host (`electron/host/auth/`). A
**pairing** is minted by the host's local operator (holding the launch token)
or by a device with `manage`. It is a short code (8 characters) that works
once and expires after ten minutes; attempts are rate limited host-wide.
Entering it on another computer, with the host's address, creates a
**session** at once: whoever created the code approved it. The session has
**scopes**, a ladder of `view`, `operate` and `manage`. The device keeps
the token: as an HttpOnly cookie in a browser, or in OS secure storage for a
native client. The host stores only a verifier of the token, written through
the save queue. A session expires after 30 days unused. Renewing it never
changes the credential. Revoking it closes its sockets and streams at once.
Socket tickets are bound to the principal that asked for them.

## Remote listener

The host's second HTTP listener, for paired devices (`electron/api/remote-app.js`).
It calls the same host services as the local listener. It checks the Host
header and the Origin, authenticates the session, and enforces the route
policy (`electron/host/auth/route-policy.js`), which assigns every served
route a scope. It refuses to start while any registered route lacks a policy.
Host-info, the agents' MCP endpoints, the window's browser tools and the
desktop's SSH proxy are never registered on it. It binds to loopback by
default; a reverse proxy is what exposes it.

## Host catalog readiness

A host's **catalog readiness** means this client has successfully applied its
catalog on the current connection. A connected transport can still have a
catalog loading or a catalog error. Concurrent refresh requests share the load;
disconnecting makes old responses ineligible to update the workspace. Previously
loaded catalog data remains available while the host is away.

Not to be confused with a host's **catalog baseline**
(`src/components/ide/store/catalog-baselines.ts`): what this client last knew
that host's catalog held, its own projects and their chats. Every save is
compared with it, and only the difference goes to that host. A host gets a
baseline when its catalog first loads here; the home host's is the catalog as
loaded at startup, before the workspace is restored. It keeps the baseline
while away, so readiness can be lost while the baseline stays: a host with a
baseline is reloaded against it, one without is loaded afresh. It loses the
baseline only when this client forgets the host.

## Host socket

The one live connection between a client and a host, carrying every kind
of traffic as channels: terminal output and input, host catalog changes,
and its own resume. A client that reconnects says where each channel
stopped and gets only what it missed.

## Host runtime

Dream's host bundled with its own Node and terminal support, one archive per
platform, installed per version in `~/.dream/host/versions/<version>/`. On an
SSH host Dream installs the runtime of its own version there when it
connects, needing nothing installed first; elsewhere the npm launcher or the
install scripts do (`docs/host-service.md`).

## Host catalog

What exists on one host, owned by that host and the same for every client
that connects to it: its projects (directories on that machine, identified
by the host), their chats and chat metadata, transcripts, provider sessions
and checkpoints. Listed with it are the chats with a turn running and those
waiting on a tool approval (`electron/api/tool-approvals.js`, announced as
`approval` events on the catalog channel). A turn is written into the host
catalog as it runs, whether or not any client is watching: the request's messages once, then only the
assistant message being written. A transcript save replaces the chat's
transcript from an index on and writes only the rows that differ from what
is stored (`saveChatMessages` in `electron/host/catalog-store.js`), so
saving a transcript again costs what changed in it. While a turn runs, the
host follows its **turn message** (`electron/api/chat/turn-message.js`): the
assistant message assembled by the AI SDK's own chat, as the client's is,
whichever Provider wrote it, copied only when it is saved. It is saved at
most once a second while it changes, never over a save still under way; its
end at once. Search reads each
message's prose from `chat_message_text`, written beside the message.

The host reads its catalog through a **read pool** (`electron/state-read-pool.js`):
a few reader threads, each with a connection that only reads, opened once
the one writer (the save queue's worker) has created and migrated the
file. The host's own thread runs no catalog SQL; a transcript crosses as
its stored JSON text and is sent as is. Contrast the workspace, which is
one client's view of it.

## Repository context

What a host knows about the Git repositories its projects are in, and the
one way it runs git (`electron/api/project-git/repository-context.js`).
**Stable facts** (a project's repository root, the remote, the default
branch) are read once and remembered for a while. **Volatile reads**
(status, branches, worktrees) are shared between callers that ask at the
same moment, as every panel does on a refresh, and a summary status is
answered from a full one. Any git command not known to only read makes the
host forget all of it, so nothing read before a write is handed out after
it. Changes made outside the host's git (an agent's shell) show in the next
volatile read; remembered facts catch up when they expire.

## Terminal session

A shell process attached to a project (`__project_terminal__:<projectId>:…`)
or to the browser panel. Not related to a chat's provider session.
The client tracks a typed command until its output goes quiet, then refreshes
the Project's Git and Files panels. This observation follows the Terminal
session when its view is hidden; closing the terminal settles a pending
refresh, while removing its Project cancels it.

## Project resources

What a client reads about one project on one host (git status, branches,
worktrees, log, a file's diff, pull request context, detail and pages, the file list), held
in one cache (`src/lib/project-resource-cache.ts`, the kinds in
`src/components/ide/project-resources.ts`). A resource belongs to a
**group** (git or files) whose **version** is the store's refresh key; a
bump makes that project's group stale, and what is being shown is read
again at once. Reads at one version share, one resource can answer another
(a summary status from a full one), and a kind can be read only a few at a
time (`maxConcurrentLoads`: diffs). Panels read them with
`useProjectResource`; no panel reads a refresh key to decide when to fetch.
Each Project's workspace says whether it is shown (`ProjectResourcesShown`),
and no reader in it is read while it is not, whatever the reader asks: a
refresh key moving for a project in the background costs nothing until it
is shown, when what it shows is read once. So a producer bumps every project
a change may have reached (window return bumps them all) and leaves which
are read to the resources.
Pull-request writes make only their own project's pull-request resources stale,
including every loaded page; drafts and selection survive the refresh. A host
is part of every resource's identity, even when paths on two hosts match.

## GitHub pull requests

What Dream asks GitHub about a project's pull requests, on its host
(`electron/api/project-git/pull-requests.js`, behind two ports: the `gh` CLI
through `runGhCommand`, the one way the main process runs it, and git).
**A branch's pull request** is the one whose head is that branch on the
repository it pushes to: an open one first; a closed or merged one only
while the branch has no newer work. The PR panel and the worktree compare
both ask `branchPullRequest`. A pull request's **checks** come summed up:
unavailable, none, failed (with a count), pending or passed.

## Project git writes

Commit, push, pull, fetch, revert, checkout and creating a pull request,
for one project (`store/git-write-actions.ts`), whichever surface asks.
Each runs on the project's host; one runs at a time per project
(`gitWriteByProject`), and a second is refused; the project's git state is
read again once when it ends; it answers an outcome and never throws, and
the surface decides how a failure shows. Which statuses a summary read
leaves out is `narrowGitStatus` in `electron/shared/git-changes.js`, the
same on host and client.

## Commit draft

A commit being written (`src/components/ide/git-actions/commit-draft.ts`):
its message, whether it takes unstaged changes, whether the message is
**generated**, and committing it or committing and pushing. The Changes
tab's commit box and the worktree's commit dialog both render one. With
generation on, the message is the project's **generated git text** for the
changes the commit takes (`selectCommitChanges`), kept while generation
may not run (an agent is still writing).

## Generated git text

Commit messages and pull request details a model writes
(`src/components/ide/git-generated-text.ts`), cached by what they are
written from: the Project's Host, the changes as `electron/shared/git-changes.js` names them
(the same key the main process caches by), the model settings, and for pull
requests the branches, next step and git version. A failure reaches the
caller and is never cached. A pending or cached answer belongs to its Host,
even when another Host has a Project at the same path; background warming
reads and generates on the same captured Host.

## Changes view

What the Git panel's Changes tab shows beyond the git status
(`src/components/ide/changes/changes-view.ts`): expanded rows, large diffs
rendered anyway, and files hidden by a revert. A reverted file hides at
once, shows again if the revert fails, and otherwise waits for the first
status read after it. Each expanded row reads its diff as a project
resource.

## Persisted state

Everything that survives a restart: projects, closed projects, chats and
their metadata, browser tabs, saved prompts, settings and the active
selections. `PersistedIdeState`. Transcripts (message bodies) are persisted
separately, per chat, and are not part of it. Stored in SQLite by the main
process; the renderer holds it in the IDE store.

The store saves it through its **save scheduler**
(`store/save-scheduler.ts`): a change marks its slice dirty (config, saved
prompts, projects, chats), and a save shortly after sends only what changed
since the last one (`store/workspace-save.ts`): the config keys, saved
prompts and workspace rows that differ, to the main process, and, when
projects or chats changed, the catalog changes to each host. The main
process's save worker writes them and also answers the workspace load, in
order after the writes queued before it, so the main thread never touches
SQLite for the workspace. A change set is the only way the workspace is
written; the import of a pre-relational database writes one too. Which
rows a state has, and their order, is the codec's `workspaceRowsOf`; which
of them to send (whole, moved, removed) is `workspace-save.ts` alone. The theme and install id are written by the same
worker; Electron main only reads them, once, at startup, on a connection
that never migrates.

## Persisted-state codec

The one module that owns the shape of persisted state, on both sides of the
renderer ↔ main seam: `electron/shared/persisted-state-codec.js`. It holds
the defaults, decodes anything shaped like persisted state (rows, an IPC
payload, a legacy blob) into a valid `PersistedIdeState`, encodes live store
state into what deserves to be saved, and maps projects, chats and settings
to and from database rows. A persisted field is added there, once.

A **plain persisted field** is a top-level field stored as one `config` row
whose value depends on no other field (the app view, the chat sort). It is a
row in the codec's `PLAIN_PERSISTED_FIELDS`, its decoder; the empty state,
decode, encode, the `config` rows, the store's initial state, hydration and
save, and the save scheduler's config slice all follow that table. Adding
one is that row, its type, and its setter.

## Chat run

A **chat run** is the durable submission around a turn: its request ID,
queue position, captured input/model/permissions, and lifecycle state.
`electron/host/run-store.js` owns its rows; `electron/api/chat/run-scheduler.js`
dispatches one run per chat, after the preceding transcript has settled.
Stop ends the live turn as cancelled and holds queued work; Pause holds queued
work and lets the live turn finish. A failure or a host restart marks the run
failed or interrupted and pauses the queue. A failed or interrupted run
retries only by explicit action; sending a new message instead dismisses it
and resumes the queue.
A run saves only its submission (one row after the transcript it read) and
tells the turn its request is saved, so the turn writes only its assistant
message. The turn's request is prepared once (`turn-transcript.js`): where
the assistant message goes and every Provider session fingerprint the turn
needs, read off one pass over it.

## Delegated task

A **delegated task** is a child chat/run linked to its parent in
`delegated_tasks`. The host creates the child and queued request atomically.
`electron/api/chat/delegation.js` exposes launch, status/results and cancel
tools through run-scoped MCP tokens, or Codex thread-scoped dynamic tools.
Task keys deduplicate within a parent run, permissions are capped by the
parent, and parent Stop reaches descendants. Child results stay in the
host catalog after the parent finishes or the host restarts.

## Agent turn

One request to an agent provider and everything it streams back for a
single assistant message: prose, reasoning, tool calls, approvals, plan
updates, context compaction, the provider session id and usage. Written by
the **agent-turn writer** (`electron/api/chat/agent-turn.js`), whose small
interface every provider adapter translates its native events into. The
writer owns the chunk shapes the client receives; adapters own only the
translation.

**Agent turn completion** means its output has settled, its final transcript
and Provider session have been saved, and its checkpoint finalization has
finished. A failed save fails the turn; a failed checkpoint is reported but
does not fail it. Stopping waits for this settlement; a client ceasing to
observe does not stop the host's work.

A **change checkpoint** is a turn's `before` and `after` snapshots of its
project's files, kept as trees in a per-project shadow repository under the
host's data directory (`electron/api/checkpoints/service.js`). The service
runs its own git: its writes are to the shadow repository, so they are not
Repository context's. `captureTurnCheckpoint` is what a turn waits on before
its provider starts: the `before` snapshot only, at most 20 s, never past
Stop. A shadow repository's first capture packs the files and trees before
git adds them, since git would write each as its own file.

Behind the writer, every turn's output passes one **output stage**
(`electron/api/chat/turn-output.js`): consecutive deltas of one part are
joined, waiting at most 50 ms, so how often the client and the host's
turn observer hear from a turn does not depend on how chatty the provider
is or how its adapter names parts.

## Turn stream

A running turn's response as the host keeps it (`electron/api/chat/turn-registry.js`):
every byte from the first, under a **turn id** (`x-dream-turn-id`). A client
that reconnects with the bytes it read asks for the rest (`?turn=<id>&from=<n>`,
answered from `x-dream-turn-offset`); the renderer's **turn stream cache**
(`src/components/ide/chat/turn-stream-cache.ts`) puts its copy back in front,
so the AI SDK still replays the turn whole. Without a copy, or for another
turn, the host sends it from the start.

## Turn contract

The two things in a turn's stream that are Dream's own rather than the AI
SDK's, agreed by both sides in `electron/shared/agent-turn-contract.js`:
the **approval id** (`<provider>:<toolCallId>`) a tool-approval request
carries, the `ChatMessageMetadata` stamped on the response message, and the
**tool kind** stamped on each tool part.

## Tool kind

What a tool call is, whichever agent made it and whatever it named the
tool: `read`, `write`, `command`, `search`, `list`, `webFetch`, `agent`,
`taskOutput`, `toolSearch`, `mcp` (these render as **tool chips**), and
`question`, `planMode`, `todo`, `taskCreate`, `taskUpdate` (rendered by the
generic tool call, the question prompt and the todo list). The agent-turn
writer stamps it on every tool part as `toolMetadata.kind`, from the kind an
adapter passes or else from the tool's name; a part saved before kinds were
stamped is classified by name when read. `electron/shared/tool-call.js`
holds the vocabulary, every known tool-name spelling, and the `describe*`
readers that turn a tool's raw input and output into the typed fields its
chip shows (a **tool call** descriptor). A new tool spelling, or a new input
or output shape, is a change to that file alone.

## Session file

A file an agent saved in its own session folder, outside the project, and links
by a path relative to that folder (Grok Build's `images/1.jpg`). Its tool part
reports the absolute path (`describeSessionFile`). A chat link resolves against
the session files known as of its own message
(`src/components/ide/chat/session-files.tsx`), because a later session can reuse
the name, and otherwise against the project.

## Provider

One of the agent CLIs Dream can run a chat through: `openai` (Codex),
`anthropic` (Claude Code), `opencode`, `cursor`, `grok`, `antigravity`
(Google Antigravity). `AiProvider`.
Each has a record in the **provider registry**
(`electron/api/providers/registry.js`: readiness, stream, one-shot text,
title model, model and usage fetchers, native fork) built on its row in the
shared **provider capabilities** (`electron/shared/provider-capabilities.js`:
MCP, skill dispatch style, usage limits, browser-MCP scope, whether a
session keeps across models and whether its tools are fixed when it starts,
the setting holding its picked models, how its model ids are spelt), which the
renderer reads too. Adding a provider is one row and one record, plus its
`AiProvider` member and its `…SelectedModels` setting.

**Settling the model selection** (`settleModelSelection` in
`electron/shared/model-selection.js`) keeps every open project and its
chats on a model the settings offer, and the defaults on a picked model.
It is pure, and runs on every write of settings (`settleSettings` in
`store/settings-actions.ts`) and on hydration, never in an effect.

## Desktop bridge

`window.dream` (`DesktopApi`): what the renderer asks of the Electron main
process (windows, clipboard, dialogs, notifications, SSH hosts, theme
preferences, the workspace save) and what it is told back. Each **desktop
method** is a row in `electron/shared/desktop-channels.js`: its channel,
and whether it is invoked, sent or subscribed to. The preload builds
`window.dream` from the table, the fixture page builds the same over a
fake, and the main process's **desktop handlers**
(`electron/desktop-handlers.js`, built with Electron's parts passed in)
are registered on it. The theme preferences' rules are
`electron/shared/theme-preferences.js`, shared by the main process, the
preload and the renderer.

## Provider adapter

The translator from one provider's native events to agent-turn calls
(`*-stream.js`). ACP providers share one translator with a smaller
per-provider adapter behind it (`acp-stream.js` with `cursor-stream.js`
and `grok-stream.js`). OpenCode's runs over an **OpenCode server** for its
turn (`electron/api/providers/opencode-server.js`). That module is the only
place Dream starts one, for one-shot prompts and usage reads too, and the
one rule for whether a saved OpenCode session may be resumed.

## CLI catalog

What a host knows about the agent CLIs installed on it: whether each
command is there, where, and which version
(`electron/api/shared/cli-catalog.js`, the host's instance `cliCatalog` in
`cli.js`). One policy for all of it: a CLI that was found is remembered for
5 minutes, one that was not for 30 seconds (so an install shows up soon),
a lookup under way is shared, and `force` looks again. A CLI's upgrade, or
a failure to start it because it is gone, makes the host forget it.
Provider readiness checks and turn launches read it rather than looking
the CLI up, which on Windows is a PowerShell process each time.

## Right-panel navigation

What a project's right panel shows (`ui.rightPanelOpen`,
`ui.rightPanelView`): Git, Files, Browser, Terminal or Stash. It changes
only through the store's `showRightPanelView`, `closeRightPanel` and
`toggleRightPanel` (`store/panel-actions.ts`), whoever asks: the rail, a
shortcut, a chat chip, the browser agent. With `toggle`, a view already
showing (on the same Git tab) closes the panel. Leaving the terminal view
discards terminals nobody typed into; showing it starts one. Whether the
panel is **expanded** over the chats is the workspace's own view state.

## Git history

The commits loaded for one project's HEAD on one host. The shared first page
is a Project resource; `git-panel/git-history.ts` owns its continuation pages,
loading state and cancellation. A refresh replaces the continuation, so late
pages cannot extend a newer history. Paging advances by host rows received,
while visible commits are unique by hash. Search and graph rendering belong
to the view.

## Browser tab

A page open in a project's Browser panel. A project's active browser tab is
one of its tabs; its saved browser URL follows that tab, including a blank URL.
Closing the active tab selects its neighbor; closing the final tab leaves a
blank replacement. The panel also closes itself on final-tab close, while an
agent's close command leaves the panel open. An agent opening a URL can reuse
the active blank tab; the panel's Add tab always adds one.

## File editor session

A project's open files in the Files panel, held outside React
(`src/components/ide/file-editor-session.ts`): its file tabs (a **preview
tab** the next open replaces, or **pinned** ones), each open text file's
**buffer** (what is on disk and the unsaved **draft**), how each was read,
and a pending reveal for the editor. One per open project, created by the
store as `fileEditorSessions`; panels render its snapshot, so a draft
outlives the panel showing it. Closing a tab forgets the file; a refresh
reads clean files again and keeps drafts. Every way of opening a project
file goes through `openProjectFile`, which turns the path into the
project-relative form once (`project-file-path.ts`).

## Composer draft

The chat composer's text read as a mention-aware document
(`src/components/ide/chat/composer-draft.ts`). A **mention** is a picked
file or folder (a _reference_), a **picked skill** (both encoded as an icon
slot, six spaces, then the name), or a **typed skill** (plain `$name`).
Serializing a draft turns references into `@path` and picked skills into
`$name`, giving `{ text, references, skills }`. The composer, the stash and
queued prompts (saved prompts, stash runs, feedback) all serialize through
it.

A chat's **live draft** is held outside React by
`src/components/ide/chat/chat-drafts.ts`. It holds the text and its
references together, since a mention's path lives only in its reference, and
where prompt history navigation stands. It outlives the panel that shows it.
A queued message that could not be sent is appended to it, whether or not a
panel shows the chat. Sending empties it. The composer edits a draft through
one value, `{ text, references }`, that its owner holds: the chat's draft for
a chat panel, or the stash composer's own. The composer keeps only the token
at the caret.

## Skill catalog

The skills a provider can load for a project, fetched from the main process
and cached briefly (`provider-skills.ts`). Not to be confused with a skill
_mention_, which is text in a draft.

## Route client

The renderer's one way to call the main process's JSON routes
(`src/lib/api-client.ts`): one method per route, named in `API_ROUTES`.
Request types are inferred from the zod schemas the routes validate with,
so the contract lives in the schema files (`electron/api/**/schemas.js`).
A failed call throws `ApiError` with the server's plain-text reason.
Behind it sit two transports: HTTP to the local API server, and an in-memory
fake (`createFakeApiClient`) that store tests inject through the action
creators' `api` dependency.

## Route handler

The server side of the same seam (`electron/api/shared/json-route.js`):
parse the JSON body, validate it, run the route, answer with JSON or a
plain-text error whose status comes from a `RouteError` (or the route's
default).

## Shortcut action

Something the user can do from the keyboard (New chat, Toggle terminal…),
listed once in `src/lib/keybindings/actions.ts` with its default **chord**
per platform. A chord is modifiers plus one key, written `Mod+Shift+f`:
`Mod` is Cmd on macOS and Ctrl elsewhere. The user's changes are
**keybinding overrides** (`settings.keybindings`): only the actions they
changed, by action id, with `null` for "no shortcut". Components never read
keys themselves; they say what an action does with `useShortcut`, and one
window listener (`src/components/ide/shortcuts/shortcuts.ts`) runs the
action the pressed chord is bound to. **Reserved shortcuts** are keys the
main process, the OS or text editing take first, so they cannot be bound.
