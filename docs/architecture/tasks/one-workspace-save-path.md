# One workspace save path in the main process

From the October 16 architecture review (candidate 8). This record was
written after the change, not before it.

## WSP-01: The workspace is written only as change sets

Status: implemented

Problem and trigger: the app saves the workspace as change sets the
renderer works out (`store/workspace-save.ts` → `saveWorkspaceChanges` →
the save worker). An older whole-state path survived beside it:

- the save queue's `save` and `saveActiveProject`, with
  `mergeActiveProjectIntoState`;
- the worker's `"save"` and `"save-active-project"` branches;
- `savePersistedState` and `savePersistedActiveProject`;
- `saveStateToRelationalDatabase` in `persisted-state.js`.

`main.js` never sent either of the queue operations. The path stayed alive
for three readers only:

- the one-time import of a pre-relational database;
- the persisted-state tests (21 calls);
- the renderer save tests (setup).

The workspace row policy was therefore written twice:

- **Order and numbering:** open projects before closed, each project once,
  numbered in that order. Once in `saveStateToRelationalDatabase`, once in
  `workspaceRows` in `workspace-save.ts`.
- **Described hosts:** a host the window has loaded has its rows written
  whole; any other host's rows only move. Once in each of the same two
  places.

The tests checked the copy that does not ship. That includes "a host not
loaded only moves" and its siblings.

Separately, `loadPersistedChat` and `resolvePersistedProjectPath` had no
callers. The worker dispatched on an if-chain that every new write had to
extend, unlike the read pool's `catalogReads` table.

Correction to the review: `scripts/import-codex-chats.mjs` never used this
path. Its `loadPersistedState` and `savePersistedState` are local functions
that write a pre-relational JSON blob straight into `app_state`. A current
database ignores that blob, since it already has relational state. That is
a separate defect, left as is and noted below. The script was removed on
2026-11-04.

Scope:

- Codec: `workspaceRowsOf(state)` is the one rule for which rows a state
  has, in what order and numbering. `workspace-save.ts` uses it;
  `workspaceRows` there is deleted.
- `persisted-state.js`:
  - the pre-relational import writes its workspace as one change set
    (`config`, saved prompts when the blob had them, an upsert of every
    row) through `saveWorkspaceChangesToRelationalDatabase`, the same
    writer every save uses;
  - deleted: `saveStateToRelationalDatabase`, `savePersistedState`,
    `savePersistedActiveProject`, `loadPersistedChat`,
    `resolvePersistedProjectPath`.
- Worker: an operation table (`open`, `save-config`, `save-chat-messages`,
  `save-workspace-changes`, `catalog-changes`, `load-workspace`, `close`).
  The two whole-state branches are deleted.
- Queue: `save`, `saveActiveProject` and `mergeActiveProjectIntoState` are
  deleted. Its one coalescing rule (merging transcript saves of a chat)
  remains.
- Tests: the persisted-state round trips and the renderer save tests'
  setup save through the production path: `takeWorkspaceChanges` from
  what is stored, then `savePersistedWorkspaceChanges`.

Excluded:

- Moving saved-prompt row mapping into the codec.
- Test-only exports (`loadPersistedCatalog`, `searchPersistedChatMessages`,
  `loadPersistedChatMessages`), which the host and catalog tests read
  through.
- The Codex import script (see above).

Completion criteria:

- `main.js`, the queue, the worker and `persisted-state.js` have one way to
  write the workspace: a change set.
- One row rule (`workspaceRowsOf`), used by the renderer and the legacy
  import.
- The described-host tests and every round trip run through
  `takeWorkspaceChanges`.
- The pre-relational import is covered by a test: catalog, transcripts,
  workspace rows in order, active project and saved prompts. It had none.

Validation (2026-10-16):

- `pnpm lint`, `pnpm check:scratch` and `tsc --noEmit` pass.
- `pnpm test`: 156 files, 1081 passed, 4 skipped.
  - Two tests are gone with the code they tested: the active-project save
    and the queue's active-project coalescing.
  - One test is new: the pre-relational import.
- A search finds no `savePersistedState`, `saveActiveProject`,
  `savePersistedActiveProject` or `saveStateToRelationalDatabase` in the
  code. The persisted-state tests' local whole-state helper is renamed
  `saveWholeState`.
- Sizes: `persisted-state.js` 963 → 820 lines, the worker 118 → 86, the
  queue 340 → 254.
- Behaviour: none intended. The import of a pre-relational database writes
  the same rows through the other writer; it upserts into an empty
  workspace, where the old path would also have deleted rows no longer
  listed.

Remaining/deferred: the exclusions above, except the Codex import script,
which was removed on 2026-11-04 rather than rewritten.

Recovery: docs/architecture/tasks/one-workspace-save-path.md#WSP-01.
