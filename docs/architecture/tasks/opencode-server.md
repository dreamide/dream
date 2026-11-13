# An OpenCode server behind the OpenCode Provider adapter

## OCS-01: One module starts an OpenCode server; the adapter is replay-tested

Status: implemented

Problem and trigger: from the 2026-11-12 architecture review (candidate 4).

- **Untested.** OpenCode was the only Provider adapter that no test
  imported.
- **Nothing to substitute.** It was the only adapter with no transport
  module a test could replace. Codex has its app-server client; ACP has
  `adapter.spawn`.
- **Three server starts.** `@opencode-ai/sdk`'s `createOpencode` was called
  in three files, each with its own timeout (10 s, 15 s, 10 s) and its own
  way of closing:
  - the chat stream;
  - one-shot text (`generate-text.js`);
  - usage stats (`usage-limits.js`).
- **One closure, several concerns.** The turn ran as one 600-line closure that
  mixed:
  - the server's lifetime;
  - starting a session, including the saved-session health check;
  - event ordering;
  - translation into turn calls.
- **An ignored signal.** One-shot text passed `{ signal }` as a second
  argument, which the SDK ignores. Its 120 s timeout cancelled requests only
  by killing the server process.

Scope: `electron/api/providers/opencode-server.js` is an OpenCode server for
one unit of work, and the only importer of the SDK. It provides:

- `openOpenCodeServer`, which starts a server on a free loopback port. Its
  `close` stops the server exactly once.
- `withOpenCodeServer`, which runs work with a server and closes it however
  the work ends.
- `createOpenCodeSession`, which creates a session for an agent and model and
  treats a missing id as an error.
- `resumeOpenCodeSession`, which says whether a saved session may carry the
  turn, with the reason when not. Only a session whose last message is a
  finished, error-free assistant answer, not one stopped for tool calls,
  qualifies.

Changes in the callers:

- **The chat stream** starts its server and session through the module and
  keeps its translation as it was. A server that finishes starting after the
  turn ended is now closed, not left running.
- **One-shot text and usage stats** run inside `withOpenCodeServer`. One-shot
  text keeps its 15 s start timeout (renamed
  `OPENCODE_TEXT_SERVER_TIMEOUT_MS`) and its 120 s request timeout. Its
  requests now carry the signal where the SDK reads it.

Excluded: the translation (event ordering, tool and todo parts, permissions)
stays inside the stream's closure. It is now covered through the adapter's
interface by the replay test rather than split up. The tool budget
(`opencode-tool-budget.js`) and the usage stats' CLI fallback are unchanged.

Completion criteria:

- `@opencode-ai/sdk` is imported in one place.
- Every way a server's work ends closes it once.
- The resume rule has one implementation, checked case by case.
- The OpenCode adapter has a replay test that replaces only the SDK. It
  covers:
  - a fresh turn, including a part arriving before its message's role and
    the user's prompt being echoed back;
  - a healthy resumed session, with the handoff and the tool-budget reset;
  - an unhealthy session replaced, with its reason and without the handoff;
  - a session error;
  - an event stream that closes early;
  - Stop;
  - a permission answered under full access.

Validation (2026-11-13): `pnpm check` passed: the scratch-file check, lint,
typecheck, and 211 test files (1,487 tests, 4 skipped).

- `opencode-server.test.js`: 4 tests.
- `opencode-stream.test.js`: 7 tests.

Limitation: no test starts a real `opencode` binary. The replay test's events
are written from the event shapes the adapter reads, not recorded from a live
server.

Remaining/deferred:

- Splitting the stream's translation further, if a second consumer of the
  event ordering appears.
- One-shot text and usage stats have no tests of their own beyond the server
  module's.

Recovery: docs/architecture/tasks/opencode-server.md#ocs-01. Check the status
above and the validation results.
