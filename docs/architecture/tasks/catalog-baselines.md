# Catalog baselines, apart from the workspace

## CBL-01: Each host's catalog baseline has one owner and one rule

Status: implemented (narrowed from the review's candidate; see Scope)

Problem and trigger: from the 2026-11-12 architecture review (candidate 5,
"a host's catalog on this client, as one module per host").

- **A mixed module.** `store/ide-store-persistence.ts` held the client's
  workspace and, in module variables, every host's catalog sync state:
  - the catalog syncs;
  - the set of hosts it had "loaded";
  - the home host's running and awaiting chats and its descriptor from the
    startup load;
  - a registered conflict callback.
- **Side-channel startup.** `hydrate` called `loadPersistedIdeState()` and
  then had to read five getters in the right order.
- **Two facts named "loaded".** `isHostLoaded` meant a baseline exists, so
  saves go to that host, and it survives a disconnect. `hosts[id].loaded` is
  readiness, the HCL-01 lifecycle's, and resets on suspend. Callers chose
  between them, and nothing named either.
- **One rule, written twice.** "A host's baseline is its own projects and
  their chats" appeared in the startup load and in `loadHostCatalog`.
- **Tests mocked module functions.** Four tests replaced
  `ide-store-persistence` to reach these functions.

Scope:

- **The new owner.** `store/catalog-baselines.ts` owns each host's catalog
  baseline and its link to the host (`CatalogSync`):
  - `sync`, `hasBaseline` and `hostIds`;
  - `adopt(hostId, from)`, which applies the one rule (`catalogStateOn`);
  - `forget`;
  - `push`, which sends each host with a baseline its own part of the store;
  - `saveTranscript` and `ensureChat`.

  It is a factory (`createCatalogBaselines`, with injected per-host routes
  and a conflict callback) with one app instance, `catalogBaselines`.
- **A workspace-only persistence module.** `ide-store-persistence.ts` keeps
  the workspace (its load, its record and its save) and the startup read.
- **Startup returns one result.** `loadPersistedIdeState()` returns
  `{ state, workspaceLoaded, homeCatalog }`.
- **The home host's baseline is adopted in `hydrate`**, from the state as
  loaded and before the workspace is restored. Restoring can add a default
  chat to an open project, and that chat is new to the host and must be sent.
- **The lifecycle chooses by baseline.** It reloads a host that has a
  baseline and loads one that has none afresh, now by
  `catalogBaselines.hasBaseline`. The store's save guards a push with
  `persistenceBlocked`, which is the same fact as the old internal
  workspace-loaded check.
- **Callers.** The catalog actions, Connection recovery, host actions, saved
  connection edits, the transcript cache and the chat runtime now use the
  baselines directly.

Narrowed from the review: the candidate proposed one module per host,
created per store. That was not done. The transcript cache, the save
scheduler and the conflict handler are each built once, bound to the one
module-level store. Per-store baselines would mean threading a store
reference through all three, with no change in behaviour, since there is one
store per window. The factory still gives tests their own instances without
mocking modules.

Kept as decided by earlier tasks:

- **HCL-01:** the lifecycle still owns first load versus reload, readiness and
  supersession; projections still run inside its accepted read; baselines
  still survive a disconnect.
- **ARC-02 and SAVED-ROUTES:** Connection recovery and saved connection edits
  keep their owners.

Excluded, as each is a separate change:

- forgetting a host still takes three calls, in two places (the baseline, the
  host socket client and the supervisor);
- the handling of a host refused for its identity is still written three
  times;
- which hosts get catalog event watchers is still decided in an `IdeShell`
  effect;
- catalog event payloads are still untyped.

Completion criteria:

- `ide-store-persistence.ts` holds no host catalog state, and `hydrate` takes
  one startup result.
- The baseline rule exists once and both baselines use it: the home host's
  at startup and an SSH host's when it connects.
- Baselines and readiness have different names, in code and in GLOSSARY.md.
- No test mocks a module to reach the baselines. `host-actions.test.ts` uses
  the real baselines, and `connection-follow.test.ts` replaces only the
  catalog read.

Validation (2026-11-13): `pnpm check` passed: the scratch-file check, lint,
typecheck, and 212 test files (1,494 tests, 4 skipped).

`catalog-baselines.test.ts` (7 tests) checks:

- a host's part of the store, with an SSH snapshot project excluded;
- that a chat added after loading is sent;
- that saves go only to hosts with a baseline;
- forgetting a host;
- refused projects reported with their host;
- transcripts saved on their chat's host.

The guard test now checks the startup result itself.

Limitations:

- Hydration and the save path are not run end to end by a test, as before;
  the two-client host test builds its glue by hand.
- No live SSH or browser-client startup was run.

Remaining/deferred: the four excluded items above.

Recovery: docs/architecture/tasks/catalog-baselines.md#cbl-01. Check the
status above and the validation results.
