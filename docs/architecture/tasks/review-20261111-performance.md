# Performance review, 2026-11-11

Three candidates from the November 11 performance architecture review,
implemented in order with one commit each. The review read code paths; the
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

Status: proposed

Problem and trigger: `applyCatalogChanges` passes every Project and Chat to
`decodeCatalogEntries`, whose normalizers always return new objects, so a
one-row host event replaces about P + C objects. The save scheduler then
sees both slices change, and `saveSlices` encodes the whole workspace and
stringifies every Project and Chat to diff, usually sending nothing.

Scope: catalog sync owns "which rows changed" in both directions; rows not
in an event keep their identity and are neither decoded nor encoded.

## PERF11-03: A live-transcript subscription that knows visibility

Status: proposed

Problem and trigger: every mounted ChatPanel, hidden Chats and background
Projects included, renders its turn at up to 20 Hz. The 50 ms throttle is
applied twice, and session files are rescanned in full per update.

Scope: the live-transcript view model owns cadence, visibility and its
derived summaries for the chat runtime's observer and the panel.

Recovery: docs/architecture/tasks/review-20261111-performance.md; PERF11-01
complete, PERF11-02 and PERF11-03 next, in order, one commit each, as the
user asked. No new branches.
