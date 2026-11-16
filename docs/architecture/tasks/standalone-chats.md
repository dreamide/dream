# Standalone chats

Chats that are not tied to a folder the user picked. Each one is an ordinary
Project whose folder Dream manages under `~/.dream/chats`. All of them are
shown together under one "Chats" tab.

Background (researched 2026-11-16):

- **T3 Code** ("No project" threads, pingdotgg/t3code PRs #13612, #26767,
  #36369) gives each thread its own folder, `~/.t3/scratch/<date>-<words>-<id8>`.
  It has no optional path and no provider changes. It hides git features,
  refuses when the folder's root is inside a git checkout, keeps folders when
  a thread is deleted, and cleans up folders that are empty or hold only
  `node_modules`. "Turn into project" adopts the folder where it is.
- **Codex desktop** ("New chat" beside Recents) gives each chat its own folder,
  `~/Documents/Codex/<date>/<slug>`, and the root is configurable. Inside
  Codex a folder counts as projectless when it has no `.git` and no project
  config, and such chats skip the folder-trust prompt.

Why a folder at all: the chat and its messages live in the database either
way. The folder is the agent's working directory. Dream runs agent CLIs, and
each one needs a working directory: tools run there, Codex's sandbox can
write only there (`writableRoots: [projectPath]`, `codex-common.js`), and
the CLIs read `AGENTS.md`/`CLAUDE.md` from it and from its parents. A shared folder
would share one checkpoint shadow repo across chats, because checkpoints are
kept per Project path.

Why one Project per chat: a Project's identity is its folder. `projects.path`
is NOT NULL and unique per host (`electron/db/schema.ts`), `findByPath`
reuses an existing Project when the same path is opened again, and the host
resolves the agent's working directory from the chat's Project. A worktree is
already its own Project with an app-managed folder (`ProjectConfig.worktree`).
Giving each standalone chat its own Project and folder means checkpoints, the
file tree, mentions, terminals, provider session resume and every adapter
keep working unchanged.

## Decisions (2026-11-16)

- The folder is created with the chat, when "New chat" creates its Project.
  Lazy creation was considered and dropped: every Host entry point that runs
  in a Project's folder would have to create it on demand.
- The root is `~/.dream/chats` on the chat's Host, beside `~/.dream/worktrees`.
- Standalone chats are refused when the root is inside a git checkout.
- Folders are cleaned up: removed when empty or holding only `node_modules`,
  never when they hold anything else.
- One "Chats" tab shows the standalone chats of every Host.

## Terms

- **Standalone chat:** a Chat whose Project is marked
  `ProjectConfig.standalone` (non-null). Its Project is a **standalone
  project**. Add both to `GLOSSARY.md` under Project when SC-02 lands.
- **Chat folder:** a standalone project's folder,
  `~/.dream/chats/<YYYY-MM-DD>-<id8>`, where `<id8>` is the first eight
  characters of the Project id. It is created with the Project.

## SC-01: Host chat folders

Status: implemented

Problem and trigger: a standalone project needs a unique, existing folder on
its Host before it is added. Only the Host knows its own home folder (SSH and
paired hosts included) and whether that location is inside a git checkout.

Scope: one new Host module (`electron/host/chat-folders.js`) owns the root,
the naming, the git refusal and creation, behind one **create** route.

- Create takes the new Project's id and returns the absolute path of a new
  chat folder, `<root>/<YYYY-MM-DD>-<id8>`. It creates the root recursively
  and the leaf non-recursively, so an existing folder is never claimed twice.
- When the root (or its nearest existing ancestor) is inside a git work
  tree, it refuses with a reason that names the repository's top level, and
  creates nothing.
- Once created, a chat folder is an ordinary Project folder. Turns, titles,
  terminals, the run command, checkpoints and file reads use it unchanged.
  A chat folder that has gone missing behaves like any missing Project
  folder.

Excluded: the root is not configurable yet, and folders are never moved.

Completion criteria:

- Create returns distinct, existing folders for distinct Project ids, and
  fails rather than reusing a folder that already exists.
- Create refuses, with the repository named, when `~/.dream` is inside a git
  work tree. Tests use a temporary home folder.
- The behavior is the same on the local host and on an SSH host (each uses
  its own home folder).

Implementation: `electron/host/chat-folders.js` (root, name, git refusal,
creation) and `POST /api/chat-folders` (`electron/api/chat-folder-routes.js`),
registered for local and paired clients (`operate` in
`host/auth/route-policy.js`). The client calls `apiClient.createChatFolder`
with the Host's id. A refusal answers 409 with the reason as the message.

Validation: `chat-folder-routes.test.js` uses temporary home folders. It
covers the name, an empty created folder, distinct folders, refusing an
existing folder, refusing inside a work tree (injected, and with a real
`git init`), and rejecting ids that cannot name a folder. `pnpm lint`,
`pnpm typecheck` and `pnpm test` (222 files) passed. Not exercised over a
real SSH host; the route is the same module on every host.

Remaining/deferred: a setting for the root (Codex has one).

## SC-02: Standalone projects in the workspace document

Status: implemented

Problem and trigger: the workspace document treats every Project as a tab
the user opened. It seeds a default chat into any open Project with no live
chat (`settle`, `store/workspace-document.ts`), and lists closed Projects in
the recent list.

Scope: the workspace document, the codec and the store actions.

- `ProjectConfig.standalone: { createdAt: string } | null`, persisted in the
  project metadata like `worktree` (`electron/shared/persisted-state-codec.js`).
  The host catalog can then read it.
- `createStandaloneChat({ hostId })` asks SC-01 to create a chat folder for a
  new Project id, then opens the Project with `standalone` set. Before
  creating one, it reuses an existing standalone project on that Host whose
  only chat is still empty, so at most one empty chat folder per Host is in
  use.
- At most one standalone project is open in the whole workspace. Showing one
  (`showStandaloneChat`, or creating one) closes the one that was open
  through the close action, terminals included.
- `settle` closes a standalone project whose chats were all deleted, rather
  than seeding a default chat. A new standalone project, with no chats yet,
  still gets its first one. When its chats are purged, the project is
  removed too.
- Standalone projects are left out of the recent/closed project list
  (`empty-project-workspace.tsx`) and the Skills settings project picker.

Changed from the original scope:

- **Git is not hidden by the flag.** SC-01 refuses chat folders inside a
  git checkout, so a chat folder reads as "not a repository" and the
  existing `isRepo` gating already hides branches, worktree creation and
  "Continue in a worktree". A user who runs `git init` in a chat folder gets
  git features, as SC-04 intends after promotion. Hiding the Git panel's
  entry for standalone projects is SC-03's.
- **The project name is not kept in step with the chat title.** Nothing
  shows a standalone project's name (the Chats list shows chat titles).
  SC-04 names a promoted Project after its chat.
- **The project switcher** is the tab strip, which is SC-03's.

Excluded: the Chats tab UI (SC-03).

Completion criteria:

- Workspace document tests cover:
  - creating, reusing the draft, and opening a second one (the first closes);
  - deleting the only chat (the project closes, no default chat is seeded);
  - purging (the project is removed);
  - restore at startup with a standalone project open.
- A turn running in a standalone chat keeps running, and its activity stays
  visible, after another standalone chat is opened. Terminals of the closed
  one stop (see Remaining).
- A fork or branch of a standalone chat stays in the same standalone project
  and shares its folder.
- The codec round-trips `standalone`, and older rows read as `null`.
- `GLOSSARY.md` gains Standalone chat and Chat folder.

Implementation: `store/standalone-chat-actions.ts` (`createStandaloneChat`,
`showStandaloneChat`); `showStandaloneProject`, `findStandaloneDraft` and
`standaloneProjectsWithoutChats` in `store/workspace-document.ts`, and the
`settle` rule; `deleteChat` and `permanentlyDeleteChats` in
`store/chat-actions.ts` close and remove what `settle` took out.

Validation:

- `workspace-document.test.ts`: six new tests, all under the document
  invariant check.
- `standalone-chat-actions.test.ts` (fake API): creation, draft reuse, the
  swap stopping the closed project's terminals, refusal, deletion closing,
  and purge removing.
- `persisted-state-codec.test.js` and `electron/persisted-state.test.js`:
  `standalone` round-trips through the codec and the relational store, and
  an older row reads as `null`.
- `pnpm check` passed.
- By code reading, not in the running app: closing a project does not stop
  its turns (they run on the host, and `chat-runtime.ts` finishes a turn
  against open or closed projects), and branching adds the chat to the same
  project (`branchChat`).

Remaining/deferred: keeping terminals alive when switching between
standalone chats would need several standalone projects open at once behind
one tab. Revisit if switching away from a chat with a running terminal is
common.

## SC-03: The Chats tab

Status: proposed

Problem and trigger: standalone chats need one place in the tab strip, and
ways to start one.

Scope: `header/project-tabs.tsx`, `projects-panel.tsx` (`ProjectSidebar`),
`empty-project-workspace.tsx`, the command palette and keybindings.

- The tab strip shows one "Chats" tab, first, instead of a tab per
  standalone project. The tab stands for whichever standalone project is
  open, and is active when that project is active.
- In the Chats tab, the sidebar lists the standalone chats of every Host,
  newest first, with their activity. Rows on a Host other than the local
  one carry its label, as project tabs do. Choosing a row opens that chat's
  project (SC-02).
- "New chat" in the Chats tab creates on the home Host. When other Hosts are
  connected, a menu offers them.
- Other entry points: "Start a chat" beside "Open folder" on the empty
  workspace, a command palette entry, and a shortcut.
- When creating a chat folder is refused (SC-01), the reason is shown and
  nothing is created.
- The Chats tab cannot be closed or reordered.

Completion criteria:

- With standalone chats on two Hosts, the tab strip shows one Chats tab and
  its list shows both, labelled.
- Every entry point creates a chat, or reuses the empty draft, and focuses
  its composer.
- A disconnected Host's standalone chats are listed the way that Host's
  closed Projects are today.
- Checked in the running app on the local host, following
  `docs/development-tools.md`.

Validation: not started.

## SC-04: Turn into project

Status: proposed

Problem and trigger: a standalone chat can grow into real work.

Scope: a store action and an entry in the Chats list's row menu.

- It is offered once the chat has had a turn.
- It clears `standalone`, keeps the folder where it is, names the Project
  after the chat's title, and opens it as an ordinary tab. Every chat in that
  project moves with it.
- The folder stays under `~/.dream/chats`. Cleanup (SC-05) skips it because
  its Project is no longer standalone.

Excluded: moving a chat into an existing Project. That changes the agent's
working directory (provider sessions would reconstruct), and the chat's
files would not follow.

Completion criteria:

- The promoted Project appears as a tab and is gone from the Chats list.
  Its chats, provider sessions and checkpoints are unchanged, because the
  path is unchanged.
- Git features show once the user runs `git init` in it.

Validation: not started.

## SC-05: Chat folder cleanup

Status: proposed

Problem and trigger: chat folders outlive their chats. Folders are not
created again once removed, so only a folder whose Project is gone may be
removed.

Scope: SC-01's Host module, run when the host catalog removes a standalone
project and once at host startup.

- A folder directly under the root is removed when it is empty or holds only
  `node_modules`, and no Project in the host catalog has it as its path.
- At startup, folders younger than one hour are skipped. A folder can exist
  briefly before its Project reaches the catalog, because the client
  registers the Project and the catalog learns of it on the next save.
- Any other content keeps the folder, even after its chat is purged: those
  files are the user's.
- A promoted Project (SC-04) still owns its folder, so it is never removed.

Completion criteria:

- Tests cover:
  - an empty folder is removed when its standalone project is purged;
  - a `node_modules`-only folder is removed the same way;
  - a folder holding one file is kept after its chat is purged;
  - a folder that still has a Project, standalone or promoted, is never
    removed;
  - an orphaned empty folder is removed at startup unless it is younger than
    the grace period.
- Removal never follows symlinks out of the root.

Validation: not started.

Remaining/deferred: a way to browse or delete folders that outlived their
chats.

## Recovery

Document: `docs/architecture/tasks/standalone-chats.md`. Order: SC-01, SC-02,
SC-03, then SC-04 and SC-05 in either order. All five are proposed; none is
implemented or validated. User constraints: the five decisions above.
