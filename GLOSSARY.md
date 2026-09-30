# Glossary

Canonical names for the concepts in Dream's code. When a file uses a
different word for one of these, the word here is the one to move toward.

## Project

A directory the user has opened in Dream, with its own chats, UI layout and
model selection. `ProjectConfig` in `src/types/ide.ts`. A project is **open**
(in the tab strip) or **closed** (kept in the closed list so it can be
reopened with its chats intact).

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

## Project runtime state

The maps the store keeps per project outside the project record: refresh
keys, terminal sessions and their status, browser tab loading, the draft
chat. They are registered in `store/project-runtime-state.ts`, which is
what closing or purging a project drops; a new per-project map is added
there, once.

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
_session_; _remote conversation_ is the provider's id for it (see Remote
session). All of them mean chat.

## Workspace document

The projects the user has open or closed, their chats and transcripts, the
draft per project and which project is active:
`store/workspace-document.ts`. Every operation on it (open, close, set and
activate projects; add, add beside, branch, focus, delete, remove, restore
chats; toggle multi-chat) is a pure function ending in `settle`, which
enforces the one invariant the app relies on: every open project has a
live chat, its active chat is one of them, its open chats are live chats of
that project with the active one among them, and the active project is
open. The zustand actions are thin wrappers around these operations; the
main process settles persisted state with the same codec primitives.

## Remote session

The provider-side identity of a chat's conversation, used to resume it:
`remoteConversationId`, `remoteConversationModel`,
`remoteConversationModelSpeed`, `remoteConversationProjectPath`. Not a chat.

## Terminal session

A shell process attached to a project (`__project_terminal__:<projectId>:…`)
or to the browser panel. Not related to a chat's remote session.

## Persisted state

Everything that survives a restart: projects, closed projects, chats and
their metadata, browser tabs, saved prompts, settings and the active
selections. `PersistedIdeState`. Transcripts (message bodies) are persisted
separately, per chat, and are not part of it. Stored in SQLite by the main
process; the renderer holds it in the IDE store.

## Persisted-state codec

The one module that owns the shape of persisted state, on both sides of the
renderer ↔ main seam: `electron/shared/persisted-state-codec.js`. It holds
the defaults, decodes anything shaped like persisted state (rows, an IPC
payload, a legacy blob) into a valid `PersistedIdeState`, encodes live store
state into what deserves to be saved, and maps projects, chats and settings
to and from database rows. A persisted field is added there, once.

## Agent turn

One request to an agent provider and everything it streams back for a
single assistant message: prose, reasoning, tool calls, approvals, plan
updates, context compaction, the remote session id and usage. Written by
the **agent-turn writer** (`electron/api/chat/agent-turn.js`), whose small
interface every provider adapter translates its native events into. The
writer owns the chunk shapes the client receives; adapters own only the
translation.

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

## Provider

One of the agent CLIs Dream can run a chat through: `openai` (Codex),
`anthropic` (Claude Code), `opencode`, `cursor`, `grok`. `AiProvider`.
Each has a record in the **provider registry**
(`electron/api/providers/registry.js`: readiness, stream, one-shot text,
title model, model and usage fetchers) built on its row in the shared
**provider capabilities** (`electron/shared/provider-capabilities.js`:
MCP, skill dispatch style, usage limits, browser-MCP scope), which the
renderer reads too. Adding a provider is one row and one record.

## Provider adapter

The translator from one provider's native events to agent-turn calls
(`*-stream.js`). ACP providers share one translator with a smaller
per-provider adapter behind it (`acp-stream.js` with `cursor-stream.js`
and `grok-stream.js`).

## Composer draft

The chat composer's text read as a mention-aware document
(`src/components/ide/chat/composer-draft.ts`). A **mention** is a picked
file or folder (a _reference_), a **picked skill** (both encoded as an icon
slot, six spaces, then the name), or a **typed skill** (plain `$name`).
Serializing a draft turns references into `@path` and picked skills into
`$name`, giving `{ text, references, skills }`. The composer, the stash and
queued prompts (saved prompts, stash runs, feedback) all serialize through
it.

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
