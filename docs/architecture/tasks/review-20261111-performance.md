# Performance review, 2026-11-11

Seven candidates from the November 11 performance architecture review,
implemented in order with one commit each (PERF11-06 and PERF11-07 after
measuring them, 2026-11-12). The review read code paths; the
measurements below are synthetic and local, not end-to-end latency.

## PERF11-01: Give the Agent turn one message-so-far

Status: complete

Problem and trigger: the host rebuilt each turn's assistant message by
reading its own stream with `readUIMessageStream`, which clones the whole
message (every tool input and output so far) for each non-delta chunk.
Saves while a turn ran were triggered by `finish-step`, which only Claude's
merged AI SDK stream can carry: no other adapter writes one. Codex,
OpenCode, Cursor, Grok and Antigravity turns reached the Host catalog only
at their end, unlike the glossary's "saved at most once a second". The
route test faked steps through `turn.merge`, so the gap was untested.

Scope: `electron/api/chat/turn-message.js` owns the turn message: it builds
the assistant message with the AI SDK's `AbstractChat` (the machinery the
client's `useChat` runs on), seeded with only the request's last message so
a turn continues an assistant message exactly when the request ends with
one. The chat changes one message in place; a copy is taken only for a
report. Reports are paced by time: at most once per interval while the
message changes, never while the previous report is being handled, and once
at the end (also after an error or Stop). Error chunks are left out of the
host's copy, as `readUIMessageStream` ignored them. `observeTurn` in
`agent-turn.js` passes its tee'd copy to it; the observer's delta joiner is
gone (a held delta would have kept prose out of a timed save). The turn
recorder (`turn-execution.js`) lost its held-step throttle and declares
`saveIntervalMs`; the default (one second) is `TURN_MESSAGE_INTERVAL_MS` in
`agent-turn.js`.

Deliberately excluded: Turn stream retention (the registry keeps every
byte; PERF-07 deferred bounded replay), the double whole-transcript save at
turn start (review candidate 5), and any change to the client's own saves.

Completion criteria:

- Every provider adapter's turn is saved while it runs, at most once a
  second, with the request once and then only the assistant message.
- No clone per chunk; one copy per report.
- A short turn is saved once, at its end; Stop and stream failure still
  produce a final save with `completedAt`.
- Clients streaming the chat ignore the extra `transcript` events
  (`canLoad` skips `streamingChatIds`); other loaded clients refetch their
  page, as the catalog already did for Claude.

Validation:

- `turn-message.test.js` (10 tests, fake timers): cadence, quiet-then-change,
  no overlap with a slow save, owned copies, continuation without changing
  the request, empty turns, error chunks, stream failure, failed step saves.
- `codex-replay.test.js`: the real Codex adapter (native transport faked)
  saves "Half way." before `turn/completed`. It fails against the previous
  `agent-turn.js`/`turn-execution.js` (`undefined !== 'Half way.'`).
- `chat-turn-routes.test.js`: a provider that marks no steps is saved while
  it waits, request once, then only the assistant row.
- Synthetic observer cost, 60 tool calls of 20 KB plus 1,500 deltas (1,801
  chunks), Node 22.23.4, save time excluded: `readUIMessageStream` with the
  old joiner 165–185 ms, `followTurnMessage` 15 ms.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (205 files, 1,422 tests) pass.

Remaining/deferred: a live turn on each provider was not run.

## PERF11-02: Apply and save catalog rows by identity

Status: complete

Problem and trigger: `applyCatalogChanges` passed every Project and Chat to
`decodeCatalogEntries`, whose normalizers always return new objects, so a
one-row host event replaced every row and both lists. The save scheduler
marks slices dirty by field identity, so `saveSlices` then encoded the
whole workspace and stringified every Project and Chat to diff, usually
sending nothing. `encodePersistedState` and `settle` also filtered every
Chat once per Project (O(P x C)).

Scope:

- Codec: `decodeCatalogEntries` takes the rows the caller already holds
  (`kept`) and returns them as the same objects, still deduplicated by id
  and path, and a held chat still dropped with its project. Decoding a
  decoded row gives an equal row (tested), so only cost and identity change.
- Codec: `chatsByProjectOf` groups chats once; `encodePersistedState` and
  the document's `settle` read each project's own chats from it.
- Workspace document: `settleRaw` (catalog changes, catalog loads, adopted
  projects) passes the document's rows as kept, takes a decoded row equal
  to the held one as the held one, keeps a list whose rows all held, and
  `pruneOrphans` keeps the draft and transcript maps when nothing left.
- Catalog sync: a row's key is worked out once per object (store rows are
  never changed in place), so a save stringifies only new objects.

Deliberately excluded: tracking dirty rows instead of dirty slices in the
save scheduler, the workspace-row JSON (`recordWorkspace`, one per project),
and whole-catalog reload triggers (refresh on reset, window return).

Completion criteria:

- A host's change to one chat leaves every other Chat, every Project, both
  project lists and the draft/transcript maps identical.
- A catalog that arrives equal to what is held leaves the lists identical,
  so subscribers do not re-render and no save slice is marked.
- Deduplication by path and orphaned chats behave as before.

Validation:

- `workspace-document.test.ts`: three new tests (one-chat change, equal
  reload, held chat with removed project plus a path conflict); all three
  fail against the previous document and codec.
- `persisted-state-codec.test.js`: decoding twice gives equal entries; kept
  entries come back as themselves; grouping keeps order.
- Synthetic, 30 projects x 20 chats, one host chat change, Node 22.23.4,
  mean of 200 runs, before -> after: apply 1.35 -> 0.53 ms, encode
  0.58 -> 0.36 ms, catalog diff 2.18 -> 0.06 ms; rows keeping identity
  0 -> 629 of 630; project list kept no -> yes. A whole-catalog reload of
  equal rows: lists kept no -> yes, about 1.2 ms either way.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (205 files, 1,428 tests) pass.

Remaining/deferred: React render counts were not measured; the gain there is
inferred from identity.

## PERF11-03: A live-transcript subscription that knows visibility

Status: complete

Problem and trigger: every mounted ChatPanel subscribed to its session's
`Chat` with `useChat`, including hidden columns (kept mounted to stay
attached to a response) and every chat of a background Project (kept
painted beneath the active one), so a running turn re-rendered all of them
at up to 20 Hz. Each panel registered its own throttled callback beside the
runtime's. Session files were rescanned across every loaded message on each
update, then re-stabilised by `JSON.stringify` in their provider.

Scope:

- Chat runtime: each session publishes one live transcript view (messages
  from its single throttled callback, status and error at once) and tells
  the panels watching it. `getChatSessionView`, `watchChatSessionView` and
  `subscribeLiveTranscript` are its interface.
- ChatPanel: `useLiveTranscript` (`useSyncExternalStore` over the published
  view) replaces `useChat`; it watches only while `isProjectActive`, which
  is false for hidden columns and background Projects, and reads the view
  during the render that shows the panel, so no stale frame. Reading the
  published view, not `chat.messages`, keeps React from re-rendering per
  chunk. `stop` is the session `Chat`'s own.
- Session files: worked out once per message object; given the previous
  result, a message whose files are unchanged keeps its map. The provider's
  JSON re-stabilising is gone.

Deliberately excluded: the runtime observer's own per-update work (awaiting
answer, activity attention, write refreshes, `findChatConfig`), scroll
follow and answer/reasoning text deferral, ChatPanel memoisation and the
keystroke re-render of the transcript, and inactive Project workspaces being
painted (kept, per the comment in `ide-shell.tsx`).

Completion criteria:

- A hidden or background panel is not told of its session's updates; a
  shown one is, at most once per interval.
- A panel shown again renders the session's current published transcript.
- Settled messages keep their session-file maps across updates.

Validation:

- `chat-runtime.test.ts`: one publication per interval for four updates, no
  publication without a change, an unwatched panel not told; a hidden
  subscription never told and a shown one told once; the view agrees with
  the finished transcript after a submission.
- `session-files.test.ts`: unchanged messages and an unchanged live message
  keep their maps; a file saved by the live message changes only its map.
- The running development app hot-reloaded the change. The log shows a
  hooks-order warning from Fast Refresh replacing `useChat` in a mounted
  component, and no errors after Vite's full reload. No turn was run there.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (205 files, 1,431 tests) pass.

Remaining/deferred: render counts were not measured (no DOM test
environment or render-count harness exists); the effect on hidden panels is
by construction and the subscription test. A streaming turn with a hidden
column and a background Project should be checked in the app.

## PERF11-04: Project resources own which projects are read

Status: complete

Problem and trigger: `useProjectResource` read whenever its caller passed
`active` (default true), so visibility was each caller's to remember. Four
always-mounted readers did not pass it: `ProjectBranchFooter` (in every
ChatPanel, hidden columns included), `BranchSwitcher`, the Changes tab's
status read and its row diffs follow their own flags. A Project in the
background therefore re-read its summary status on every git bump, which a
catalog reload sends to every open Project of a host. Window return bumped
only the front Project, to avoid that cost, so background Projects kept a
stale branch after an external commit until something else bumped them.

Scope:

- `project-resources.ts`: `ProjectResourcesShown` (a context, default
  shown) and `useProjectResourcesShown`; `useProjectResource` is active
  only while its project is shown and its caller's `active` holds. The Git
  history subscriber (`use-git-history.ts`) follows the same rule.
- `ProjectWorkspace` provides it from its `active` (front and no Settings
  over it).
- Window return (`ide-shell.tsx`) bumps every open Project; only the front
  one is read now, the rest once each when shown.

Deliberately excluded: merging the producers' timers (the 750 ms agent-write
debounce and the terminal's quiet detection serve different purposes), the
forced full status read when a turn ends (`warmProjectCommitMessage`, at
most one extra read per turn), and aborting a read a newer version
superseded (its result is already discarded).

Completion criteria:

- No resource of a Project that is not shown is read on a bump; it is read
  once when shown, however many bumps came first.
- Readers outside any Project workspace behave as before.
- Every reader in a workspace, present or future, follows the rule without
  passing anything.

Validation:

- `project-resources.test.ts`: a project bumped three times while its
  reader is inactive makes no read, then one when shown, and is fresh.
  Existing cache tests cover active and inactive readers on a bump.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (205 files, 1,432 tests) pass.

Remaining/deferred: there is no DOM test environment, so the context itself
is covered by typecheck and inspection, not a render test. Host git
processes per bump were not counted in the app.

## PERF11-05: The Chat run prepares its transcript once

Status: complete

Problem and trigger: "the request's messages are saved once" was
implemented twice, by parties that did not know of each other. The run
scheduler read the chat's transcript, appended the submission and saved
the whole transcript; the turn recorder then started with `beforeSaved`
false, so its first save (with PERF11-01, often the only one before the
end) sent `[...before, message]` again. The whole request was also
stringified and hashed twice: once to check the Provider session's prefix
(`resolveSessionContext`), and again with the assistant message at the end.
Changed-row writes kept the SQLite writes small; the cost was the clone to
the save worker, the stringify and the compare, which grow with tool
output.

Scope:

- `electron/api/chat/turn-transcript.js`: `prepareTurnTranscript(messages,
  { saved })` gives a turn its request once: `before` (what the assistant
  message is written after; a continued assistant message is replaced),
  whether the request is already saved, `fingerprint(length)` and
  `fingerprintWith(message)`. The fingerprints feed one sha256 a message at
  a time and copy it where a prefix ends, so every prefix the turn needs is
  read off one pass and the end of the turn adds only its own message. They
  equal `transcriptFingerprint` (tested), so stored sessions still resume.
- Run scheduler: saves only the submission, `fromIndex` at its place, and
  passes `requestSaved: true` to `executeChatRequest`.
- `executeChatRequest` prepares the transcript before the session check;
  `resolveSessionContext` takes its `fingerprint`; `executeAgentTurn` and
  the turn recorder take the prepared `transcript` (defaulting to an unsaved
  one, so the `/api/chat` route and direct callers behave as before). A
  recorder whose request is saved writes only the assistant row from its
  first save.

Deliberately excluded: the scheduler's `JSON.parse` of the whole transcript
(the request needs it, and a provider reads it), the `/api/chat` route's
own request (its client saves on its own schedule, so the turn still saves
it once), and checkpoint capture (review candidate 6).

Completion criteria:

- A Chat run's transcript is sent to the save worker once per turn: its
  submission as one row, then only the assistant row.
- The request is fingerprinted in one pass per turn; the stored
  fingerprint still matches the transcript it leaves, so the next run
  resumes the Provider session.
- Requests not from a Chat run save the request once, as before.

Validation:

- `turn-transcript.test.js`: every prefix fingerprint, in any order, equals
  `transcriptFingerprint`; the fingerprint with the assistant message
  follows the request or replaces a continued message; an empty request.
- `chat-run-transcript.test.js`: two runs through the real scheduler,
  `executeChatRequest` and save worker (provider faked): every save carries
  one row, submissions at 0 and 2, the second run resumes the first's
  Provider session, whose fingerprint equals the saved transcript's. It
  fails against the previous scheduler and recorder (a save of 4 rows).
- Synthetic, 201 messages (100 tool outputs of 20 KB, about 2.1 MB), the
  host-side work per turn (structured clone to the worker and
  fingerprints; SQLite compares excluded), Node 22.23.4, mean of 50 runs:
  25.5 ms before, 6.1 ms after.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (207 files, 1,436 tests) pass.

Remaining/deferred: a live run with a long transcript was not timed in the
app.

## PERF11-06: Checkpoint capture as one module with a stated cost

Status: complete

Problem and trigger (measured 2026-11-12, Windows, git 2.53, checkpoints on
by default):

- A project's first capture wrote every file as a loose object: 4.9 s
  (dream, 941 files), 26 s (umami, 2,157), 54 s (react-spectrum, 3,697,
  50 MB). Reading and hashing umami took 0.6 s; writing loose objects 16 s
  on C: (6.4 s on E:), still 10 s with `core.fsync=none`, so the cost is per
  file created. A fresh large project's first turn waited the full 20 s and
  got no checkpoint while git kept running under the project lock.
- `ensureShadowRepository` remembered setup in memory only, so the first
  capture per project after every host start ran 9 sequential `git config`
  processes: +550 to +830 ms (a git process costs about 55 ms here).
- A turn waited for the `before` ref write too (3 git processes, 160 to
  330 ms per turn), and the waiting rule (20 s, no reaction to Stop) lived
  in `chat-routes.js`.

Scope:

- A shadow repository's first capture (no index yet) packs the work tree's
  files with one `git fast-import` before `git add -A`, and the index's
  trees with a second before `write-tree`. Both only add objects; `add` and
  `write-tree` still decide the snapshot, so trees are git's own (files git
  converts, such as CRLF under `text=auto`, are written by `add` as before).
  `core.bigFileThreshold` was tried and rejected: any content conversion
  sends blobs back to loose objects. fast-import runs with
  `fastimport.unpackLimit=1`, as below 100 objects it unpacks them again.
- Setup is recorded in the shadow repository, so a host restart runs no
  `git config`.
- `captureTurnCheckpoint` in the service states what a turn waits on: the
  snapshot tree, at most 20 s (`TURN_CHECKPOINT_WAIT_MS`), and not past
  Stop (the turn's signal). The `before` ref is written after, under the
  project lock; a capture already running when the turn stops waiting warms
  the shadow index and pins nothing, and one still queued does not start.
  `chat-routes.js` lost its timeout and passes the turn's signal.
  `createCheckpoint` (capture and pin, awaited) remains for its tests.

Deliberately excluded: killing git on timeout or Stop (a killed `add`
leaves `index.lock` on Windows and throws away the work that makes the next
capture fast); routing shadow git through Repository context (its writes
would make the host forget every project's cached git facts each turn);
finalization at turn end (intentional, GLOSSARY "Agent turn completion");
warming a shadow repository before a project's first turn.

Completion criteria:

- A first capture leaves no loose objects for the files and trees it
  packed, and its tree equals plain `git add -A` + `write-tree`.
- A host restart's first capture runs no `git config`.
- A turn waits only for the tree; Stop and the budget end the wait at once,
  and a capture nobody waits for writes no ref.

Validation:

- `service.test.js`: a first capture of 34 files (a CRLF file under
  `text=auto`, a path with a space and an accent, an empty file) equals
  plain `git add -A` + `write-tree` and leaves one loose object, the
  converted file; a fresh module (a host restart) leaves a changed shadow
  config alone, and sets it again without the record; a turn's capture
  finalizes and lists, a stopped one and one past its budget return null
  and pin no ref. The first two fail against the previous service.
- The same harness as the measurements (`createCheckpoint` on real
  checkouts, data directory in a scratch folder), before -> after: first
  capture dream 4.9 -> 1.4 s, umami 26 -> 2.4 s, react-spectrum 54 ->
  7.9 s; first capture after a restart 550 to 830 -> 4 to 6 ms of setup;
  a warm turn's wait 160 to 330 -> 130 to 215 ms.
- `pnpm lint`, `pnpm typecheck` pass; `pnpm test` (207 files, 1,439 tests)
  passed twice in a row. Three earlier runs each failed one different
  timing or port test outside checkpoints (`run-scheduler.test.js` paused
  state, `catalog-two-clients.host.test.ts` "bad port",
  `desktop-host.test.js`); each passes alone, with and without this change.

Remaining/deferred: a first capture of a project with tens of thousands of
files can still pass 20 s (react-spectrum's 3,697 files took 7.9 s); the
turn then runs without a checkpoint and the capture finishes behind it.
No live turn was timed in the app.

## PERF11-07: One startup sequence

Status: complete

Problem and trigger (measured 2026-11-12; the installed app holds its
database, so the packaged app was not launched):

- `main.js` created the window only after `rendererServerManager.start()`,
  which started the renderer (Vite in development, the static server in
  production) only after the host listened. Neither needs the host to start.
- The host's start, run in Node against copies of the dev and installed
  databases: importing its modules 1.2 to 1.5 s, `listen` 0.33 to 0.42 s.
  Eight saved development launches: the host listened 0.9 to 1.5 s after
  start (one at 11.8 s), the renderer connected 2.5 to 5.4 s after.
- 771 modules load unbundled at every host start; `@pierre/diffs` adds
  about 250 ms of them (measured three times), for `parseSingleFileDiff`.
- The catalog loads twice at launch (hydration, then the socket's first
  `reset`): 45 to 105 ms of host time with 62 projects and 387 chats, and
  about 1 ms to apply an unchanged catalog since PERF11-02.

Scope:

- `renderer-server.js` owns what the window waits on. `start()` starts the
  host and the renderer together and resolves when the window can load:
  in production when the static server listens, which holds `/api`
  requests and socket upgrades until the host listens; in development when
  both Vite and the host are up (Vite's proxy cannot hold a request).
  `hostListening` says when the host listens, or why it did not.
- `main.js` creates the window without waiting for the host, starts remote
  access once it listens, and still ends the launch with its dialog when
  the host cannot start (the in-process fallback is unchanged, inside
  `host.listen`).
- `parseSingleFileDiff` loads `@pierre/diffs` on its first diff.

Deliberately excluded: the second catalog load (measured above at 45 to
105 ms, after hydration and off the path to the window; removing it needs
catalog responses to carry the event cursor and every applying path to
adopt it, a correctness risk for little gain); bundling the host's modules;
overlapping the workspace and catalog loads in the renderer; device-session
loading (`auth.load`, part of the 0.33 to 0.42 s `listen`).

Completion criteria:

- In production the window is created while the host starts, and a request
  it makes meanwhile is answered once the host listens; a host that cannot
  start answers held requests with 502 and still ends the launch.
- In development Vite and the host start together.
- The host's start no longer imports `@pierre/diffs`.

Validation:

- `renderer-server.test.js` (production mode, a fake host the test
  releases): the window's page is served while the host starts; an `/api`
  POST and a socket upgrade made meanwhile wait, then are answered with the
  body intact and echo; a host that fails answers a held request with 502
  and `whenHostListening` rejects with its reason. Both fail against the
  previous renderer server, whose `start()` waited for the host.
- Host modules loaded at start 771 -> 531; importing the host graph
  1,133-1,187 -> 864-975 ms (three runs each, Node 22.23.4).
- The desktop's attachment (spawn the child host, wait for its record,
  verify it, bind the edge) on a fresh data directory, eight runs each,
  median 1,427 -> 1,226 ms. In production the window no longer waits for
  any of it; it waits for the static server only.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (208 files, 1,441 tests) pass.

Remaining/deferred: the packaged app was not launched (the installed app
holds its database), so the production window's own load and first paint
were not timed, nor the gain end to end; nor was development's overlap of
Vite and the host run. The second catalog load is deferred as above.

Recovery: docs/architecture/tasks/review-20261111-performance.md; PERF11-01
to PERF11-07 complete, one commit each, as the user asked. No new branches.
