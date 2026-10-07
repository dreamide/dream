# v0.26.0 environment improvements

Selected scope: implement all five candidates from the release retrospective.
Commit and push require user confirmation. Run existing checks; add no new tests
and start no dev server. Status below describes this task, not the original
performance proposals preserved in ../v0.26.0-performance.md.

## RETRO-01: Check gates

Status: complete

Completion: lint baseline clean; custom highlighting/helpers covered by Biome;
PR/main checks run lint, typecheck, and existing tests on Windows and Linux;
release packaging depends on the same validation; scratch hygiene included.

## RETRO-02: Durable task specifications

Status: complete

Completion: preserve all seven original candidates with stable IDs and honest
shipped/deferred scope; provide a reusable task/recovery template; route agents
to it from the repo entry points; generate HTML from the Markdown source.

## RETRO-03: Native discovery and visual fixtures

Status: complete

Completion: one command discovers the existing renderer and API; session metadata
includes logs and an opt-in debugger endpoint; fixture page blocks real IPC/API
writes and exposes real component previews, row geometry, loading replay, themes,
new/deleted/modified/wrapped/EOF cases, dialog/select/badges/toast inspection.

Validation must distinguish browser fixture checks from native Electron behavior
that needs the next user-controlled app launch.

## RETRO-04: Reviewer reference

Status: complete

Completion: concise guidance names representative screens, component choices,
interaction consistency, typography/copy, light/dark inspection, asynchronous
transitions, and cross-provider seam review; mechanical rules remain automated.

## RETRO-05: Diagnostic tooling

Status: complete

Completion: scratch allocator writes outside checkout and supplies a UTF-8 Python
runner; root scratch files fail the repository check; remove the committed
one-off script; reusable benchmark and development instructions are retained.

## Validation

- `pnpm check` passes: scratch hygiene, lint, typecheck, and 142 existing test
  files (937 passed, 7 skipped). No new tests were added. Vitest now isolates
  `DREAM_DB_PATH` from the running app; temporary records from the initial
  inherited-database run were identified and removed.
- `pnpm vite:build` passes. Fixture entry points and automation markers are
  absent from the production output. Existing bundle-size warnings remain.
- All 40 diff combinations match placeholder/highlighted row geometry: five
  cases, unified/split, wrap on/off, light/dark. This exposed and fixed a
  loading-state scrollbar that added 10 pixels on long lines.
- Dialog dismissal restores focus; Select offers every case; the screenshot
  toast action records only an in-memory call; fixture API requests are blocked.
- `pnpm inspect:dev` discovers the existing renderer and API. The standalone
  native logger/session smoke check verifies manifest output and redaction.
  Native app integration and opt-in CDP require the next user-controlled restart;
  no app or development server was launched for this task.
- The scratch guard rejects a temporary root probe, then passes after cleanup.
  The scratch allocator and Markdown-to-HTML report generator work.
- `pnpm bench:highlight` completed on Node 22.22: 300 lines, 106 updates,
  1,629.52 ms full highlighting versus 42.55 ms incremental. This is a local
  diagnostic, not an end-to-end performance claim.
- `git diff --check` passes. CI is configured but has not run remotely.

## Recovery

Document: docs/architecture/tasks/retro-v026-environment.md
Task IDs: RETRO-01 through RETRO-05
Remaining implementation: none. Changes are uncommitted. Native integration
verification awaits a user-controlled restart; remote CI awaits publication.
