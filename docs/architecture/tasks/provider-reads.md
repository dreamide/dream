# Provider reads: one sequence for models, one ladder for usage limits

## PRD-01: Each kind of provider read is written once

Status: implemented (amended from the review; see Scope)

Problem and trigger: from the 2026-11-12 architecture review (candidate 9).

- **Model fetchers.** Six fetchers in `provider-models.js` each wrote the same
  sequence: is the CLI installed, which version, read, then treat no models
  or a failed read as an error. The `{ installed, models, source:
  "unavailable", version, error }` result was built by hand 17 times.
- **Usage limits.** Five readers in `usage-limits.js` each wrote the same
  ladder: read live and remember a good answer; on failure, return the
  remembered answer with the error; then use limits the CLI left on disk;
  then report nothing.
- **Two snapshot shapes.** OpenAI's last good answer, and every snapshot a
  turn records (`storeProviderUsageLimitSnapshot`), kept only the limits. A
  fallback answer from one lacked fields every other provider's answer has.
- **No timeouts.** Three requests had none: Codex usage, Claude usage and
  Claude's token refresh. A hung request would hang the registry's shared
  30-second read for every popover.

Scope:

- **`readProviderModels`** (`provider-models.js`) is the models sequence.
  Each of the six fetchers supplies its install check, version and read. A
  read returns the models, or `{ error }` when a precondition fails (Codex
  not logged in). Cursor's read keeps its fallback to the default models.
- **`readUsageLimits`** (`usage-limits.js`) is the ladder. A provider
  supplies its live read, which throws when there is no answer. Optionally it
  supplies a disk fallback (`readLocalUsageLimits`) and its own failure
  wording, which Grok uses for a lapsed login. OpenAI, Anthropic, Grok,
  Antigravity and OpenCode Go use it.

  Each provider's checks before reading stay its own: the Codex login, Grok
  credentials and the Antigravity CLI. So does Anthropic's disk-only path
  when it has no credentials, and Claude's token refresh on 401 or 429.
- **One snapshot shape.** `storeProviderUsageLimitSnapshot` stores a full
  result, like a live read.
- **Timeouts.** The three requests that had none now have 15 s
  (`USAGE_REQUEST_TIMEOUT_MS`).

Amended from the review:

- The review said there were two caches for usage limits. There are not: the
  registry's 30-second cache shares one read among everyone who asks, and the
  snapshot remembers the last good answer for fallback. Both stay.
- The review proposed putting the ladder in the provider registry. Each
  ladder stays in the module of its read instead; the registry's records
  already call those fetchers, and holding the ladders would couple the
  registry to their details.

Excluded:

- reading credentials and Claude's refresh writing credentials back, which
  are untested as before;
- OpenCode's local stats (the SDK, then the CLI);
- the normalizers.

Completion criteria:

- Every model fetcher uses `readProviderModels`, and the unavailable result
  is written in one place.
- Every usage reader with a live read uses `readUsageLimits`.
- A snapshot has the same shape whoever stored it.
- The two sequences are tested directly.

Validation (2026-11-13): `pnpm check` passed: the scratch-file check, lint,
typecheck, and 216 test files (1,521 tests, 4 skipped).

- `provider-models.test.js`: 3 new tests for the models sequence.
- `usage-limits.test.js`: 4 new tests for the ladder, including a turn's
  snapshot being a full result.

The two files went from 2,210 to 2,050 lines.

Limitation: no live provider API, CLI or credential store was called. The
tests replace the reads.

Remaining/deferred: tests for the credential reads and Claude's token
refresh.

Recovery: docs/architecture/tasks/provider-reads.md#prd-01. Check the status
above and the validation results.
