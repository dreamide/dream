# Development tools

## Inspect an existing app

Run `pnpm inspect:dev` in this checkout. It probes existing session manifests and
prints the reachable renderer, API, fixture URL, debugger endpoint, and log path.
`--json` produces structured output; `--logs` prints a bounded tail of the log.
It never launches a server. Separate running checkouts have separate manifests.
Older Windows/macOS/Linux builds can fall back to discovery of the existing Vite
process; they have no native log/debug metadata until a user-controlled restart.

On the next development launch, Electron publishes its session record and captures
main-process, renderer-console, and Vite output under the OS temporary `dream-dev`
directory. Logs stop accepting writes at 5 MB per session, use asynchronous I/O,
and redact common credential forms. Keep raw logs private when sharing diagnostics.

For native inspection, set `DREAM_DEVTOOLS_PORT` to an unused loopback port before
the next user-controlled development launch. `inspect:dev` reports its `/json/list`
endpoint; attach a CDP-capable browser tool to the main Dream renderer target.
The debugger is opt-in and is unnecessary for the fixture browser page.

## Visual fixtures

Open the fixture URL from `inspect:dev` in the browser tools. `/__dev/fixtures`
is served only by Vite's development middleware; it is absent from production.
The entry point installs an in-memory desktop bridge before importing features.
Unknown desktop operations fail explicitly, and `/api` fetches are blocked.
It does not mount IdeShell or load/save your workspace.
The page reuses index.html's font and theme definitions while omitting its boot
scripts, so its geometry uses the same fonts as the app.

The left panel is a permanent placeholder reference; the right replays a delayed
transition through the real IdeDiffViewer. Compare both row positions and total
height. Cover modified, new, deleted, long wrapped lines, and no-final-newline
cases in unified/split mode, wrap on/off, and light/dark themes. Replay after
changing controls; warm and cold worker startup have different timing.

Reproducible URLs accept `case=modified|added|deleted|eof|wrapped`,
`mode=unified|split`, `theme=light|dark`, `wrap=0|1`, and `delay=0..10000`.
Use Measure rows or call
`window.__dreamFixtures.measure()` from the browser tool. Results include each
surface's row offsets, heights, text, readiness, and recorded desktop calls.
`comparison` stays pending until highlighting is ready, then compares row offsets,
heights, and total height within one pixel. For sequential browser diagnostics,
`window.__dreamFixtures.configure({example, mode, wrap, theme})` selects a case
without navigating; read `measure()` after the browser paints the new selection.

The screenshot button drives the real screenshot toast through the fake bridge;
Show in folder only records an in-memory operation. Dialog, Select, and outline
Badge previews use the shared components. Verify keyboard focus, dismissal,
toast-action size, and contrast. OS notifications and real preload/host wiring
still require native app inspection; fixtures do not establish that behavior.

## Scratch programs and benchmarks

Vitest keeps `DREAM_DB_PATH` explicitly empty in each worker so an agent launched
by the app cannot pass the live database into host tests. Existing host tests
configure their own temporary directories; dotenv cannot override that empty key.

Run `pnpm scratch <task-name>` to allocate a task directory outside the checkout.
Write large diagnostics to files there and execute those files. The directory
includes `run-python.ps1`, which sets Python UTF-8 and preserves the exit code.
Use the native patch tool for source edits; preserve the file's existing newline
convention. This avoids nested shell quoting and cp1252 diagnostic failures.

`pnpm check:scratch` rejects root `.tmp-*`, `.twcheck.*`, and numbered `fix`/`css`
scratch programs. It also runs inside `pnpm check` and CI. Reusable tools belong
in scripts/; one-off tools belong in the task directory.

`pnpm bench:highlight` compares full and incremental highlighting for 300 lines
of TypeScript streamed in 80-character updates, after highlighter warmup. It
prints input size, update count, Node version, and elapsed milliseconds as JSON.
It is a diagnostic, not a timing assertion or an end-to-end UI latency estimate.
