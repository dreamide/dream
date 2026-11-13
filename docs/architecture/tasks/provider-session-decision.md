# One Provider session decision per Agent turn

## PSD-01: Provider session decides what a turn starts from

Status: implemented

Problem and trigger: from the 2026-11-12 architecture review (candidate 1).
What an Agent turn starts from on its provider's side was decided in three
stages:

- The Chat run scheduler copied the chat row's four `remoteConversation*`
  fields into the request. `executeChatRequest` always overrode them from
  `provider_sessions`, so the copy did nothing.
- `executeChatRequest` checked coverage, the handoff and a native fork.
- Each of the five Provider adapters then checked model, speed and path again
  (`shouldResumeProviderSession`; ACP left out `provider`), ran its native
  probe, and chose between the latest prompt and the full history.

`contextTransfer` was stamped before any probe ran. So a turn whose probe
failed, and which rebuilt its history, recorded `delta` or `native-fork`. The
handoff text also rode inside `projectReferencesPrompt`, so that rebuilt
history carried the missed messages twice. None of this wiring had a test.
The provider-specific rules (Claude and Codex forks, the Codex orchestration
tools gate) branched on provider IDs outside the Provider registry.

Scope: `electron/api/chat/provider-session.js` owns the Provider session for
one Agent turn: the decision (resume, delta handoff, native fork, rebuild),
the instruction to the adapter (`resumeSessionId`, `sessionHandoff`),
`contextTransfer` once the adapter reports how it started, and the saves
afterwards (the `provider_sessions` row with its coverage, and the chat row's
copy). Adapters keep their native probe and their prompt construction, and
report the outcome with `turn.session(id, { resumed, reason })`. The writer
passes that report to the host's turn observer (`onSessionStart`), so no
adapter forwards anything.

The provider-specific rules move into the provider records:

- Claude's and Codex's forks become `fork` on their records
  (`native-fork.js`).
- The tools gate becomes the `toolsFixedAtSessionStart` capability, with
  `ORCHESTRATION_TOOLS_VERSION` in the turn contract.
- `transcriptFingerprint` moves to `turn-transcript.js`, and
  `session-context.js` is removed.

Decisions taken in the review:

- The module covers the decision, how the turn starts, and the recording
  afterwards (Q1 C).
- The adapter reports the outcome (Q2 A).
- The chat row becomes a mirror that nothing reads to decide anything (Q3 A).
- Provider-specific rules move into the records (Q4 A).
- Each turn gets one handle (Q5 A).
- The report extends `turn.session` (Q6 A).
- The handoff travels in its own slot (Q7 A).
- A clean resume records `resumed` (Q8 A).
- Tools fixed at session start becomes a capability flag (Q10 A).

Changed scope: Q9 (the renderer stops writing its copy of the chat row's
session) was dropped. The renderer also saves the chat row for other reasons,
for example a title. A save that lands before the host's change arrives would
send the row back without the session and overwrite the host's copy. Both
copies come from the same metadata, so the renderer is left unchanged.

Completion criteria:

- Every non-first turn records how it started: `resumed`, `delta`,
  `native-fork` or `reconstructed`. A `reconstructed` turn carries a reason
  when a fork or a probe failed. A first turn records nothing.
- A probe that fails records `reconstructed`, never what the host intended.
- A rebuilt history does not carry the handoff text.
- Model, speed and path are checked once, through the capability row, for
  every provider, including the ACP providers.
- The scheduler no longer copies the chat row's session. The request body's
  four fields are accepted and ignored.
- All five Provider adapters report their start. Claude, Codex and ACP
  tests cover the report. Antigravity's test covers its resume, and OpenCode
  has no harness (see Validation).
- The module's tests cover the decision, the outcome, the saves, the fork and
  its failure, the tools gate and an abort before a fork.

Validation (2026-11-13): `pnpm check` passed: the scratch-file check, lint,
typecheck, and 207 test files (1,457 tests, 4 skipped). Before the change
the affected suites had 28 files and 201 tests. What the tests cover:

- `provider-session.test.js` replaces `session-context.test.js` and the old
  `provider-session.test.js`. It covers every start, the reason after a
  failed probe or fork, model and speed against the real capability rows,
  the tools gate, an abort before a fork, the saves, and running without a
  catalog.
- `chat-run-transcript.test.js` runs two Chat runs through a real catalog.
  The second turn resumes, and its saved message records `resumed`; the
  first records nothing.
- Adapter tests check the reported start, and that the handoff appears on
  resume and is dropped on fallback:
  - Claude: resumed and gone-session cases.
  - Codex: a live thread, and a restore that fails.
  - ACP: an agent that cannot load the session.
- `agent-turn.test.js` checks that the start is reported once.
- `registry.test.js` checks that `fork` exists exactly where `nativeFork` is
  set.

Gaps:

- OpenCode's adapter still has no test harness (review candidate 4), so its
  start report is checked only by reading the code.
- The Antigravity test checks the resumed launch, not the start report.

Remaining/deferred:

- The renderer still writes its copy of the chat row's session
  (`chat-runtime.ts:480-502`) and clears it when the model or speed changes
  (`chat-panel.tsx:626-639`). Removing the copy from the chat row entirely
  (review Q3 B) touches the codec, `src/types/ide.ts`, branching, stash and
  the delegation store, and is not proposed here.
- Live forks and resumes against real CLIs were not run. Adapter tests use
  the existing fakes.

Recovery: docs/architecture/tasks/provider-session-decision.md#psd-01.
Check the status above and the validation results.
