# State writes declared once

## SWR-01: One table of writes, beside the table of reads

Status: implemented

Problem and trigger: from the 2026-11-12 architecture review (candidate 3).
Reads were one table, `catalogReads` (`host/catalog-store.js`), called as
`read(type, payload)`. A write was spelt three to five ways:

- a method on the save queue;
- a message string;
- a row in the worker;
- often a `persisted-state.js` wrapper that only passed the call on.

For example, `catalog.applyChanges` went to `writer.applyCatalogChanges`, then
`"catalog-changes"`, then `applyPersistedCatalogChanges`, then
`applyCatalogChanges`.

Other friction around writes:

- **The writer's interface was restated by hand three times, and the copies
  disagreed.** `main.js` forwarded seven methods, the `host/index.js` doc
  listed six, and the `host/catalog.js` type listed four.
- **Transactions had three conventions.** `persisted-state.js` wrapped some
  writes, `run-store.js` opened its own, and the provider-session and
  device-session writes had none.
- **The transcript-save rules lived in three modules.** Merging queued saves
  was in the queue; `mergeOnly` was in `persisted-state.js`, a file whose
  header says "I/O only"; and the row diff was in the catalog store.

Scope: `electron/state-writes.js` holds `stateWrites`, every write to a state
database by name. Each row has the store function it runs and, where the
queue may merge a write with the same one queued just before it, how to
merge them.

- **Writes:** `catalog-changes`, `transcript`, `run-queue`,
  `provider-session`, `device-session`, `workspace-changes` and `config`.
  Names mirror the reads where both exist.
- **One transaction convention.** `runStateWrite` runs each write in a
  transaction of its own, so store functions no longer open one. The run
  store's and the workspace save's own transactions are gone. The legacy
  import wraps its workspace step itself.
- **The save queue** (`state-save-queue.js`) exposes `write(name, payload)`,
  `ready()`, `settled()`, `loadWorkspace()` and `flushAndClose()`, replacing
  seven named methods. Its merge rule comes from the table, and it refuses an
  unknown write before posting it.
- **The worker** (`persisted-state-worker.js`) runs every write through the
  table. Its own messages are only `write`, `open`, `load-workspace` and
  `close`.
- **One writer type.** `StateWriter` (`write`, `ready`, `settled`) is
  documented once, in `state-save-queue.js`. The catalog and host-auth
  reference it, and `main.js` lends the host its queue as it is, so the
  hand-written forwarding object is gone.
- **Two adapters.** The save queue and `createInThreadStateWriter`, which
  writes on the calling thread for tests. Tests that wrote through the
  removed wrappers now use `writeState(name, payload, options)`, the same
  table the worker runs.
- **Removed:** `savePersistedConfigValue`, `savePersistedWorkspaceChanges`,
  `savePersistedChatMessages` and `applyPersistedCatalogChanges`.
  `saveWorkspaceChanges` and `writeConfigValue` are now exported from
  `persisted-state.js` for the table.
- **Transcript rules together.** `mergeTranscriptSaves` and the `mergeOnly`
  save are both in the `transcript` row; the row diff stays in the catalog
  store, as before.

Excluded: the read pool and `catalogReads` are unchanged. Migrations and the
legacy import keep their own transactions. Renderer code is untouched.

Completion criteria:

- Adding a write means adding a row in `state-writes.js`. The queue, the
  worker, a writer shared with the host and the host's writer type follow
  from it.
- A write that fails, partway through included, leaves the database as it
  was.
- An unknown write is refused, by the queue and by `runStateWrite`.
- The names the host and the desktop write by each have a row.
- Every existing caller and test writes through the table.

Validation (2026-11-13): `pnpm check` passed: the scratch-file check, lint,
typecheck, and 209 test files (1,476 tests, 4 skipped).

`state-writes.test.js` (6 tests) checks:

- the named writes all have a row;
- a refused merge-only save and a write failing halfway both leave nothing
  behind;
- an unknown write is refused;
- queued writes apply in order;
- the in-thread writer behaves as a state writer.

Limitations:

- No test proves that the queue sends two merged transcript saves to the
  worker as one. The rule itself is tested (`mergeTranscriptSaves`,
  `state-save-queue.test.js`), and so is the result, which is the same merged
  or not.
- The desktop's shared-writer path in `main.js` (an in-process host sharing
  the workspace's queue) still runs only when Electron launches, as before.
  What changed there is the hand-off line itself.

Environment note: during this work, process starts on the machine took about
9.5 s each for a while, `node -e 0` and `cmd.exe` included. Vitest could not
start its fork workers then. Once starts were back to normal (about 0.1 s),
`pnpm check` ran in 57 s.

Remaining/deferred: none for this task.

Recovery: docs/architecture/tasks/state-writes.md#swr-01. Check the status
above and the validation results.
