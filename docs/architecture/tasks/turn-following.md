# Following a host turn, as its own module

## FOL-01: Turn following has one owner; the chat stream uses the Host endpoint's rule

Status: implemented (narrowed; see Excluded)

Problem and trigger: from the 2026-11-12 architecture review (candidate 8).

- **Turn following had no interface of its own.** It is which running host
  turns this client reads into a chat's session, and what it does when a
  stream is lost. Its state was spread over:
  - three session fields: `reconnectNeeded`, `retryTimer` and `retryDelay`;
  - two module-level sets: `resuming` and `pendingResumes`;
  - writes in six places in `chat-runtime.ts`.

  Its rules could only be exercised by driving the whole runtime through a
  stubbed global `fetch`.
- **The chat stream repeated the Host endpoint's network rule.** `chatFetch`
  re-implemented what `hostFetch` does: refuse redirects, report the
  response, and report a network failure as unreachable.
- **One rule written twice.** "This status is worth asking again" (5xx, 408,
  429) appeared in `chatFetch` and in `handleSessionError`.

Scope:

- **`chat/turn-following.ts`** (`createTurnFollowing`) owns:
  - which chats are followed now, and follows asked for while one runs;
  - per chat, whether its stream was lost, the backoff (250 ms doubling to
    5 s, reset when bytes arrive) and the retry timer.

  Its interface is `follow` (with `newTurn`), `reattach`, `lost`, `isLost`,
  `failed`, `receiving` and `forget`. The runtime supplies what a follow does
  (load the transcript, resume the stream, refresh the catalog), what
  happens when one settles, and how it fails.
- **The Host endpoint** (`lib/connections/host-endpoint.ts`) gains
  `fetchFromHost`, the one way a request reaches a host, and
  `isTransientHostStatus`. `hostFetch` is built on the former. `chatFetch`
  now uses both and keeps only what is its own: the turn stream cache's
  resume cursor and its read.

Excluded: moving submission and commit-message warming out of
`chat-runtime.ts`. That would be mostly relocation, as the review warned, so
it is deferred. The private header carrying the host through the AI SDK
transport stays: the transport contract requires it.

Completion criteria:

- No turn-following state remains in the session record or at module scope
  in the runtime.
- The following rules are tested without the runtime:
  - one follow at a time;
  - a new turn during a follow;
  - the backoff sequence and its reset;
  - stopping when the turn ends, the session is replaced, or it is
    forgotten;
  - reattaching.
- The runtime's existing reconnect and backoff tests pass unchanged.
- The chat stream and `hostFetch` share one request rule, which is tested.

Validation (2026-11-13): `pnpm check` passed: the scratch-file check, lint,
typecheck, and 216 test files (1,514 tests, 4 skipped).

- `turn-following.test.ts`: 6 tests.
- `host-endpoint.test.ts`: 4 tests.
- The runtime's 12 tests, including reconnecting after a dropped body and
  backoff with deduplicated resumes, pass without change.

`chat-runtime.ts` went from 1,368 to 1,300 lines.

Limitation: no live host disconnect or suspend was exercised.

Remaining/deferred: moving submission and commit-message warming out of
`chat-runtime.ts`.

Recovery: docs/architecture/tasks/turn-following.md#fol-01. Check the status
above and the validation results.
