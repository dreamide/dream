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
`ProjectConfig.worktree` (`ProjectWorktreeInfo`) is non-null. Created,
compared, merged and cleaned up by the git routes; the parent project is
`parentProjectId`.

## Chat

One conversation with an agent inside a project. `ChatConfig`, `chatId`.
Every open project has at least one live chat, and the project's UI names
which one is active. A chat is **soft-deleted** when `deletedAt` is set.

Older code calls this a _thread_; the chat runtime calls a running one a
_session_. Both mean chat.

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
