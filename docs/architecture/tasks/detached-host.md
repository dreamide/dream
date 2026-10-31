# Detached host

Follow-up to the 2026-10-29 comparison with T3 Code's `t3 serve` (pinned
source `pingdotgg/t3code@dd14848`). Dream already has the daemon, the host
service, pairing, the browser client and several routes per host. These
candidates close the remaining gaps the comparison found. Scope agreed
2026-10-29: implement DH-01 through DH-06.

Dependency order: DH-01 → DH-02 → DH-03. DH-04, DH-05 and DH-06 are
independent of them.

Second round, agreed 2026-10-30 (DH-07 to DH-17). Two goals:

1. **Consistent start.** The host is started one way, `dream-host`, configured
   through flags or environment variables.
2. **Settings only offer what works.** The UI offers only what the running setup
   supports, and says when a change needs a restart.

The connection settings follow T3 Code's split: a client page (this app and
the hosts it uses) and a host page (one host's sharing and access).

Decisions recorded 2026-10-30:

- **Precedence:** a flag beats an environment variable, which beats a saved
  setting, which beats the default ("default" was the answer, read as the
  proposed order).
- **Overrides:** a flag or environment variable may override a setting saved
  through the UI. The UI then shows it read-only, with its source.
- **Service management** (`dream-host service …`) is removed completely, with
  no deprecation period. Keeping a host running is the user's job;
  `dream-host` is the standard way to run it, and the docs show how to run it
  under each OS's service manager.
- **No keep-running preference.** The desktop manages only its own process: a
  host it started, it stops when it quits; a host it did not start, it leaves
  alone.
- **No phone client.** Dream is not meant to be used on a phone. Connecting from
  a phone is not offered; mobile is a separate, future project. This reverses
  CONN-04's phone layout and the phone pairing of CONN-01 to CONN-05
  (`remote-connections.md`); see DH-17.
- **Pairing by code only, with no approval** (later the same day). The link
  method and the host-side confirmation of a code are removed; see DH-18.

DH-07 to DH-18 supersede parts of DH-02, DH-03 and DH-06, as noted under each.

## DH-01: State lock held by the operating system

Status: implemented

Problem and trigger: the state lock (`electron/host/state-lock.js`) is a JSON
file naming a PID, judged live with `process.kill(pid, 0)`. Windows reuses
PIDs quickly: after a host crash, an unrelated process can inherit the PID,
and every later host start refuses with "Another Dream host … is using this
host's data" until someone deletes the file. `startedAt` is recorded but never
compared.

Scope: the lock's authority becomes an exclusive SQLite transaction on
`<state db>.host-owner`, held for the host's lifetime and released by the OS
however the process ends. The `.host-lock` JSON record stays, as a
description of the holder for messages and for the service attachment, and is
written only after the OS lock is held (now with `lock: "os"`). A record
without that marker comes from an older host, which only knows the record:
while its PID lives it is still treated as held, so old and new hosts exclude
each other during an upgrade. Readers that judged liveness by PID
(`service/update.js`) ask whether the OS lock is held instead
(`isStateLockHeld`). The desktop takes the same lock on its workspace
database, so a second desktop on one workspace is refused with a dialog
(before, it crashed on the host's state lock). Excluded: T3's watcher for the
lock file being deleted while held.

Completion criteria:

- A second acquirer, in the same process or another, gets `StateLockedError`
  naming the holder from the record. Met.
- A record left by a dead process whose PID is now alive does not block a
  new host. Met.
- A crashed holder (killed without cleanup) does not block the next host. Met.
- Service update recovery uses the OS lock to decide whether the previous
  host still runs. Met.

Validation: `electron/host/state-lock.test.js` (6 tests, including a holder in
a separate Node process killed with SIGKILL, and a live pre-OS-lock record).
A packaged child host's record read `{"kind":"desktop","lock":"os",…}`.

Remaining/deferred: a lock file deleted while held is not noticed.

## DH-02: The desktop's home host runs as a child process

Status: implemented; partly superseded by DH-09 (no keep-running; the desktop
stops only the host it started, and attaches to a host it did not start)

Problem and trigger: by default the desktop ran its home host inside
Electron's main process (`createHost` in `electron/main.js`). Agent turns, git
and catalog work shared the window's event loop, a host crash took the window
with it, and closing the window ended every turn. Service mode already made
the desktop a pure client through the edge listener (`electron/desktop-host.js`),
but only through an installed service and an environment variable.

Scope: the desktop starts `dream-host serve` on its own data directory as a
detached child (`ensureDaemon`, Electron's binary as Node with
`ELECTRON_RUN_AS_NODE`), under a private host home `<state db>.host`, and
attaches to it through the edge listener service mode uses (both are now
`createHostAttachment`). A child from an earlier session is reused; one from
another app version is replaced. Quitting asks the child to shut down unless
the user keeps it running (DH-03). `serve` removes `ELECTRON_RUN_AS_NODE` from
its own environment, so terminals and agents it starts run normally. The Codex
app server stops with the host that owns it (`host.close`). The renderer is
told `service` for a child host: terminals outlive reloads and are discovered
again, and the host's agents use this window's browser. The host in the app
remains as `DREAM_HOST_MODE=in-process`, while the workspace shares the state
database's writer, and as the fallback when a child cannot start and nothing
else holds the data (`withInProcessFallback`). An explicit
`DREAM_HOST_MODE=child` makes that failure the launch's failure instead.

Scope change (2026-10-29): the original criterion "a second desktop process
on the same data reuses the running child" was replaced. Two desktops on one
workspace would be two writers of the workspace database, so the second is
refused with a dialog (DH-01's lock). Desktops on different databases
(`DREAM_DB_PATH`) each get their own child host.

Completion criteria:

- Default launch: the host runs in a separate process; the edge verifies its
  identity, database owner and protocol before forwarding. Met.
- Quit (keep-running off): the child shuts down cleanly and releases its lock.
  Met.
- Reload: terminals keep running and the renderer reattaches to them. Met by
  construction (the renderer's service-mode path); not exercised in a window.
- A second desktop on the same workspace is refused with a message. Met by the
  lock; the dialog was not exercised.
- A child that cannot start falls back to the host in the app (logged), unless
  the mode was explicit. Met in tests.

Validation:

- `electron/desktop-host.test.js`: a real detached daemon started, attached,
  token-checked, stopped at close, kept running and reattached, and replaced
  for another version. Also the fallback rules, and service detection.
- Packaged app (`electron-builder --dir`, Windows x64):
  - `Dream.exe` as Node ran the host from `app.asar` (`version`, then
    `ensure`). Its catalog read through the worker threads, it held the OS
    lock as `desktop`, and it started a ConPTY terminal through `node-pty`
    from `app.asar.unpacked`.
  - The desktop launched on a temporary `DREAM_DB_PATH` started its child
    host (`[host] Started host …`). A window close stopped it ("Shutting down
    (requested)", lock and record gone). With keep-running on, the host
    stayed ("Leaving the host running") and the next launch reattached
    ("Attached to host …"). With it off again, the next quit stopped it.

Remaining/deferred: macOS and Linux packaged runs; a reload with live
terminals in a window; the second-desktop dialog in a window.

## DH-03: Host mode chosen in Settings and detected

Status: implemented; superseded by DH-09 (keep-running removed), DH-10
(service detection removed with service management) and DH-11 (the "This
computer" section becomes the Hosts page's "This app")

Problem and trigger: service and remote-only modes needed `DREAM_HOST_MODE` in
the desktop's environment. A desktop launched normally while a service owned
its database failed on the state lock.

Scope: a desktop host preference file (`<state db>.desktop-host.json`,
`electron/desktop-host-preference.js`): `mode` (`local` or `remote`) and
`keepRunning`. It sits beside the state database rather than in userData, so a
development app on its own database keeps its own. Settings > Connections >
This computer (`home-host-section.tsx`, desktop methods
`getHomeHostSettings`, `setHomeHostPreference`, `relaunchApp`) shows the mode
now and why, keep-running (applies at quit), and remote-only (applies after a
restart, with a restart button). The order at startup is:

1. `DREAM_HOST_MODE`, which still works and wins.
2. The host in the app while the workspace shares the state writer.
3. Remote only, if chosen.
4. An installed service whose launch serves this desktop's data directory and
   state database (`serviceServesDesktop`).
5. Otherwise the child host of DH-02.

Completion criteria:

- An installed service for this data directory is attached without any
  environment variable. Met in tests (detection); not exercised with a real
  installed service.
- Remote-only from Settings takes effect after a restart. Met by construction;
  not exercised in a window.
- Keep-running leaves the child host running after quit, and the next launch
  reattaches to it. Met (packaged app, see DH-02).

Validation: `electron/desktop-host-preference.test.js` (mode order, file
reading and writing), `desktop-handlers.test.js` and `preload.test.js` (the
three methods), and the packaged keep-running runs above. The Settings section
was not inspected visually in either theme.

Remaining/deferred: a visual check of the section in light and dark themes; a
walkthrough with a real installed service.

## DH-04: One-line host install

Status: implemented; publishing pending. DH-10 removes the `service` commands
the installed runtime offered; the installers themselves are unchanged.

Problem and trigger: a headless machine needs the right runtime archive found,
checked and unpacked by hand (`docs/host-service.md`). T3 ships `npx t3`.

Scope:

- **npm launcher** (`scripts/npm-launcher/dream-host.js`, packaged by
  `scripts/build-host-installers.mjs` as the `dream-host` npm package): no
  dependencies. It downloads the platform's runtime and `SHA256SUMS` from the
  GitHub release of its own version, verifies the checksum, unpacks with the
  system's tar (Windows' own `tar.exe`, never a GNU tar on PATH), and
  smoke-tests `version`. It installs into `~/.dream/host/versions/<version>/`,
  the place SSH installs use, and then runs the runtime with the given
  arguments.
- **`install-host.sh`**: generated from the SSH install script
  (`buildInstallScript`), so the two cannot drift. It links `dream-host` into
  `~/.local/bin`.
- **`install-host.ps1`**: installs into `%USERPROFILE%\.dream\host\versions`
  and adds a `dream-host.cmd` shim, with its folder on the user PATH.
- **Release workflow**: builds all three, attaches the scripts to the
  release, and publishes the npm package when an `NPM_TOKEN` secret exists
  (prereleases to the `next` tag).
- `build-host-runtime.mjs` also uses Windows' own tar for its archive.

Completion criteria:

- `npx dream-host@<version> version` prints the runtime contract on a clean
  machine of a published platform. Met against a local release server on
  Windows; not yet against a published release.
- A checksum mismatch or an unknown platform stops with a clear message. Met.
- The scripts install a version and refuse a mismatched archive. Met for
  PowerShell (temp home) and partly for sh (see below).

Validation:

- `scripts/npm-launcher/dream-host.test.js` (6 tests).
- A real Windows runtime archive and the installers were built into a temp
  folder and served over local HTTP:
  - npm launcher: downloaded, verified, installed and ran `version`; the
    second run reused the install.
  - `install-host.ps1`: run with HOME redirected to a temp folder and the user
    PATH write removed. It installed, wrote the shim, and the shim ran.
  - `install-host.sh` under Git Bash: downloaded, verified and unpacked, then
    stopped at the smoke test, as expected for a Windows archive (exit 78). A
    wrong `SHA256SUMS` stopped it with exit 77.

Remaining/deferred:

- Publishing needs an `NPM_TOKEN` secret and the npm package name `dream-host`.
- The sh installer has not been run on Linux or macOS.
- The PowerShell installer's user PATH change has not been exercised.

## DH-05: Resume a turn from where the client stopped

Status: implemented

Problem and trigger: `GET /api/chat/:chatId/stream` replayed a running turn
from its first byte on every reconnect (`turn-registry.js`). A phone on a weak
connection during a long turn downloaded the whole turn again each time.

Scope: each turn gets an id, sent as `x-dream-turn-id` with
`x-dream-turn-offset` on every view of it. A client holding the first N bytes
of that turn asks with `?turn=<id>&from=<N>` and gets only what follows. The
renderer's turn stream cache (`src/components/ide/chat/turn-stream-cache.ts`,
used by `chatFetch` in `chat-runtime.ts`) keeps the bytes of each running turn
it has read and splices them in front of the tail. The AI SDK therefore still
reads a complete replay (`resumeStreamIsReplay`). An unknown turn, or an
offset past what the host holds, gets the whole stream from 0. A tail the
client cannot complete is refused and asked for again. Bytes are dropped when
a stream of the turn ends, when the host answers 204, or when another turn
replaces it. The desktop's proxies already forward the query string and
response headers, and the renderer reaches the API same-origin.

Completion criteria:

- Reconnecting mid-turn on the same page downloads only the tail, and the
  message rebuilt is identical to a full replay. Met in tests.
- A reload (no cache) gets the full stream. Met.
- A different turn under the same chat gets the full stream. Met.
- The desktop's proxy routes forward the query string and the headers. Met by
  reading `host-proxy-routes.js`.

Validation: `turn-registry.test.js` (offsets inside and on chunk boundaries,
another turn, an offset not reached) and `turn-stream-cache.test.ts` (splice,
replay, refused tail, forgetting). Not exercised against a live provider turn
in a window or a phone browser.

Remaining/deferred: a live reconnect check over a slow or dropped link (a
phone is no longer a target client, see DH-17; any client that reconnects
benefits).

## DH-06: Headless pairing, approval signal, WSL hosts

Status: implemented, except WSL hosts, removed 2026-10-30 (see below); the QR
code of `serve --pair` was removed under DH-17

Problem and trigger: three smaller gaps from the comparison.

Scope:

- **Headless pairing.** `dream-host serve --pair` runs `pair` once the host
  listens when a remote listener is up. Otherwise it says how to turn remote
  access on. As before, only a verified address is offered as a link; an
  unverified one gets the code.
- **Approval signal.** `tool-approvals.js` records the chat of each pending
  approval (the turn observer's `chatId` reaches `createAgentTurn`). The host
  publishes `{kind: "approval", chatId, awaiting}` on the catalog channel when
  a chat's first approval is asked and its last settles, and lists
  `awaitingApprovalChatIds` with the catalog. Clients keep
  `hostAwaitingApprovalChatIds`. The projects panel shows an amber "Waiting for
  you" dot, and the project tab's waiting badge includes such chats even when
  no session in the window follows the turn. A turn that ends clears it.
- **WSL hosts.** On Windows, an SSH route whose target is `wsl:<distribution>`
  (`electron/ssh/wsl.js`) runs its scripts, `ensure` and the link through
  wsl.exe, with no master, askpass or port forward: WSL forwards the
  distribution's loopback ports. A host that runs but does not answer is a
  fatal error naming the localhost-forwarding setting. The SSH host dialog
  suggests the installed distributions. Editors with a WSL remote (VS Code,
  Cursor, Windsurf) open the project through it; others open
  `\\wsl.localhost\<distribution>\...`.

Scope change (2026-10-29): "a WSL host survives the desktop restarting" is not
achievable as stated. WSL stops a distribution once no wsl.exe holds it, so the
host in it runs only while Dream (or something else) holds the distribution.
The criterion became "reconnects after the desktop restarts".

Completion criteria:

- `serve --pair` prints one link and QR, or says why it cannot. Met (remote
  access off: guidance; remote listener up: code, no unverified link).
- A pending approval marks the chat in every client; answering or stopping
  clears it. Met in tests.
- A WSL host can be added, opened, and reconnects. Met with a fake wsl.exe
  against a real daemon; not exercised against a real distribution.

Validation: `tool-approvals.test.js`, `catalog-approvals.test.ts`,
`wsl.test.js` (arguments, UTF-16 output, a connection end to end with a fake
wsl.exe, a missing distribution); `serve --pair` run both ways. The new
indicator was not inspected visually.

Scope change (2026-10-30): WSL hosts were removed (code, UI, docs). Dream
does not install or manage a host inside WSL; the user installs and runs
`dream-host` wherever it is needed and reaches it like any other host.

Remaining/deferred:

- A walkthrough with a real distribution. It installs a runtime and starts a
  host inside it.
- A visual check of the approval indicator.
- Chats waiting on approval are not yet dropped from the client's map when
  their project closes.

## DH-07: One option table for starting the host

Status: implemented

Problem and trigger: the host's options are flags only, except
`DREAM_HOST_HOME` and `DREAM_DB_PATH`. Each way of starting it picks its own
defaults: one hour of idle timeout from `serve` and `ensure`, never for a
service. The desktop passes flags no one documents (`--owner`,
`--diagnostics`). The database is chosen two overlapping ways (`--data-dir` and
`DREAM_DB_PATH`). The desktop's host inherits the app's `.env`, which
`dream-host` never reads.

Scope:

- **The table.** One module (`electron/host/options.js`, name to confirm) lists
  every host option: flag, environment variable (`DREAM_HOST_*`), type,
  default, whether it can change while the host runs, and whether a saved
  setting backs it (remote access).
- **Resolution.** Options resolve as flag > environment variable > saved
  setting > default, and the source of each value is kept for DH-08.
- **Who uses it.** `serve`; `ensure`, which passes options through; the
  desktop's own host, which passes its options as flags; `dream-host --help`;
  and the options table in the docs.
- **Options:** home, data directory, database, port, idle timeout, remote port,
  remote origins, trusted forwarded host, client directory, diagnostics, and
  who started the host.

Open in this candidate:

- One way to name the database, with `DREAM_DB_PATH` kept or retired.
- Whether `dream-host` reads a `.env` file.
- Which `DREAM_HOST_MODE` values remain after DH-09 and DH-10.

Completion criteria:

- Every option has a flag and an environment variable, listed by
  `dream-host --help` and in the docs, both generated from the table.
- Precedence is tested for each kind of option, including one with a saved
  setting.
- An invalid value is refused with the option's name and where it came from.
- The desktop starts its host only through the table.

Validation:

- `electron/host/options.test.js` covers precedence, the derived paths,
  `DREAM_DB_PATH` after `DREAM_HOST_DATABASE`, lists and switches from
  variables, refusals naming their source, flags written back, and the docs
  table, which is generated (the test fails when it drifts).
- Live: `dream-host help` lists every option with its variable.
  `DREAM_HOST_PORT=abc dream-host status` is refused with "Invalid
  DREAM_HOST_PORT".
- A host started with `DREAM_HOST_IDLE_TIMEOUT=0` reports that value as `env`,
  from `DREAM_HOST_IDLE_TIMEOUT`.

Decided (2026-10-30, the proposals):

- The database is named by `--database` / `DREAM_HOST_DATABASE`, with
  `DREAM_DB_PATH` still read after it; `serve` passes the resolved path to its
  workers.
- `dream-host` reads no `.env` file.
- `DREAM_HOST_MODE` takes `auto`, `remote` and `in-process`. `service` is
  refused with a pointer to `dream-host serve`; `desktop` is read as `auto`.

Remaining/deferred: none.

## DH-08: The host reports its settings and where they came from

Status: implemented

Problem and trigger: a client cannot tell which of a host's settings it may
change, which were fixed by a flag or environment variable, or which are
saved but wait on a restart. So the UI offers changes that fail (the remote
access listener) or silently do nothing until a restart.

Scope: a route on the host (`/api/host/settings`, `manage` scope) answers, for
each option of DH-07:

- its value now and its source (flag, environment variable, saved, default);
- whether it can be changed from a client;
- any saved value waiting on a restart.

It also answers the host's header facts: name, ID and fingerprint, version,
addresses, start time, and whether a desktop started it.

Completion criteria:

- Every DH-07 option is reported with its source.
- A saved change to an option that needs a restart is reported as pending
  until the restart.
- The route follows the route policy (`manage`) on both listeners.

Validation: `options.test.js` (the report: values, sources, flags or
variables, what a client may change, remote access fixed at start). Live: the
report of a host started with an environment variable and `--remote-port`.

Scope change: the route is `POST /api/host/settings`, as every route of the
renderer's client is a POST or PUT. No option changes while a host runs, so
`pendingRestart` is always false; it is there for one that will.

Remaining/deferred: none.

## DH-09: The desktop manages only the host it started

Status: implemented

Problem and trigger: decided 2026-10-30. The desktop should manage its own
process and nothing else. Today it offers to keep its host running after
quitting, and it cannot attach to a host the user started with `dream-host` on
its data (it fails with "Could not start Dream").

Scope:

- **Finding the host.** At launch, the desktop looks for a host already
  running on its database. Any host can be found from the database alone: the
  state lock's record names where its run record is.
- **A host the user started.** The desktop attaches after the usual identity
  and protocol checks. It never stops it, and a version difference is shown
  (DH-12) rather than acted on.
- **A host a desktop started.** One left by a crashed desktop is still the
  desktop's own: it is reused, replaced on a version change, and stopped when
  the desktop quits.
- **No host.** The desktop starts one and stops it when it quits.
- **Removed:** the keep-running preference, its UI, its file field and its docs.

Completion criteria:

- With `dream-host serve` running on the desktop's data, the desktop attaches,
  and quitting the desktop leaves it running.
- A host the desktop started stops when the desktop quits, including one left
  by a crashed desktop.
- No setting keeps a desktop-started host running after quit.

Validation:

- `electron/desktop-host.test.js`, with real hosts:
  - the desktop's own host starts, is restarted and stops at close;
  - a host the user started is attached, refuses a restart, and keeps
    running after close, even at another version;
  - a crashed desktop's host is reused, and replaced for another version;
  - a v0.31 host (PID-only lock, run record in the default home) is found;
  - an unreachable holder is refused with a reason;
  - the in-process fallback.
- Packaged Windows app on a temporary `DREAM_DB_PATH`:
  - It started its own host, whose lock record named owner `desktop` and its
    run directory, and quitting stopped it.
  - With a host started by the packaged binary's `dream-host` on the same
    data, the desktop logged "Attached to the host … started with
    dream-host", and the host was still running after the desktop quit.

Remaining/deferred: macOS and Linux packaged runs.

## DH-10: Remove service management

Status: implemented; the service manager examples are unverified

Problem and trigger: decided 2026-10-30. Running the host under the
operating system's service manager is the user's job, not Dream's.

Scope:

- **Code removed:** `dream-host service` and everything behind it
  (`electron/host/service/`, `service-cli.js`), the desktop's service
  attachment and detection (`createServiceHostAttachment`,
  `serviceServesDesktop`), and `DREAM_HOST_MODE=service`.
- **Docs.** `docs/host-service.md` becomes "Run the host": install, run,
  options (DH-07), and examples that run `dream-host serve` under systemd
  `--user`, launchd and Windows Task Scheduler. The examples include restart
  on failure, the idle timeout turned off and environment variables. Updating
  means installing the new version and restarting the unit.
- **Existing services.** Services installed by v0.30.0 and v0.31.0 keep
  running their retained runtime until the user removes them; the docs list
  where each OS keeps the unit.
- **Glossary.** The glossary loses Host service and Service runtime update.

Completion criteria:

- No code installs, starts, stops, updates or detects a service.
- The docs' examples run the host on each OS. The Windows example has been run
  here; the others are marked as unverified until they are.
- A desktop with a v0.31 service running on its data attaches to it as to any
  host the user started (DH-09).

Validation:

- `git rm` of `electron/host/service/` and `service-cli.js`; nothing refers to
  them.
- `dream-host service …` prints the removal notice.
- `DREAM_HOST_MODE=service` is refused (`desktop-host-preference.test.js`).
- `docs/host-service.md` is now "Run the host", with the generated options
  table.
- A v0.31 service on the desktop's data is found by DH-09 (tested with a
  stand-in, not a real v0.31 service).

Remaining/deferred: the systemd, launchd and Task Scheduler examples have not
been run. Registering them here would change this machine's startup and user
PATH, which needs the user's go-ahead. The docs say they are starting points.

## DH-11: Hosts page (this app, and the hosts it uses)

Status: implemented; not inspected visually on the desktop. Scope changed
2026-10-30: the "Run agents on this computer" toggle was removed (see below).

Problem and trigger: Settings > Connections mixes what this app owns (its
saved hosts, whether it runs a host) with what a host owns (remote access,
paired devices). Nothing says which is which.

Scope: a client-owned **Hosts** page, desktop only (a browser client uses only
the host that serves it):

- **This app.** A **Run agents on this computer** toggle, which needs a restart
  and offers one. It is read-only, with its source, while `DREAM_HOST_MODE`
  decides.
- **Hosts.** This computer's host and the saved hosts, each with its state.
  **Add host** offers SSH host, WSL distribution (DH-16) and Pairing link.

Completion criteria:

- Everything on the page is about this app or its saved hosts; nothing a host
  owns.
- Turning the local host off or on says a restart is needed and offers one.
- UI review per `CODING_STANDARDS.md` in both themes.

Validation: typecheck, lint and the handler and preload tests (the
`restartHomeHost` and `listWslDistributions` methods). Settings now has **Hosts**
(desktop only: `ThisAppSection` and the saved hosts) and **Sharing & access**
in place of Connections. The browser client shows Sharing & access and no
Hosts page (checked in the browser panel).

Scope change (2026-10-30): the user removed the **Run agents on this
computer** toggle, the **This app** section and the saved preference behind them
(`<state db>.desktop-host.json`, `setHomeHostPreference`, `relaunchApp`).
Choosing not to run a host on this computer from the app is not a real use
case. The Hosts page is the saved hosts alone. `DREAM_HOST_MODE=remote` is
unchanged (`electron/desktop-host-mode.js`, which replaces
`desktop-host-preference.js`).

Remaining/deferred: a look at the Hosts page in a desktop window, in both
themes.

## DH-12: Sharing & access page (one host's)

Status: implemented

Problem and trigger: a host's identity, version and address are shown nowhere.
Remote access, pairing and paired devices sit in one long section. Controls
that cannot work yet are offered anyway.

Scope: a host-owned **Sharing & access** page for one host:

- **Header.** The host's name and a menu: copy the host ID and fingerprint, and
  Restart host for a host this desktop started.
- **Version.** The host's version, address, and how it relates to this app:
  same version, or older or newer (DH-09).
- **Remote access.** Off, Tailscale or Cloudflare. A control that depends on
  another is disabled with the reason.
- **Authorized clients.** Paired devices with this desktop marked, their access
  levels, **Revoke others** and **Create link**, and pending code requests.

Completion criteria:

- Every control either works in the current setup or is disabled with the
  reason.
- The page shows the same thing for the desktop's own host and for a host the
  user started.
- UI review per `CODING_STANDARDS.md` in both themes.

Validation: the page in the browser client at 605px wide, dark theme,
on a host started with `--remote-port`:

- its name, version and address, "Started with dream-host…" and "Same as
  this app";
- remote access read-only with the reason;
- **Create link**, and this browser marked "This device".

Two layout problems found there were fixed: wrapping flag names, and values
shown as escaped JSON.

Scope change (2026-10-30): the user removed the list of options the host
started with and the "Started by Dream…" / "Started with dream-host…" line.
Options belong in the documentation, not the app. The page keeps the host's
name, version and address, the reason a control is disabled, remote access and
authorized clients. The settings report's per-option list is no longer shown.

Remaining/deferred:

- the desktop's view (Restart host on its own host) in a window;
- the light theme;
- **Revoke others** with more than one client;
- the code view of **Pair a computer** (DH-18 replaced **Create link** and its
  link view).

## DH-13: Overrides and restart notices in Settings

Status: implemented

Problem and trigger: the second goal of this round. The UI must not offer a
change that cannot take effect, and must say when one needs a restart.

Scope: DH-11 and DH-12 read DH-08's report.

- **Overridden settings.** A setting fixed by a flag or environment variable is
  read-only and names its source ("Set by `--remote-port`").
- **Pending restarts.** A saved change that waits on a restart says so. For a
  host this desktop started, it offers Restart host. For a host the user
  started, it says to restart `dream-host`.

Completion criteria:

- No UI-editable host setting can be changed while a flag or environment
  variable fixes it.
- Every change that needs a restart says so until the restart happens.

Validation: remote access set at start is read-only with the flags named
(seen in the browser panel). A client that is not the host's own computer's
operator cannot switch access on or off, and is told why.

Remaining/deferred: no host option is changeable at run time yet, so no
pending-restart notice can appear from the host. With the Hosts toggle
removed (DH-11), nothing in the app needs a restart of Dream itself.

## DH-14: Remote-access flags as an override of the saved setting

Status: implemented

Problem and trigger: `--remote-port`, `--remote-origin` and
`--trust-forwarded-host` start a listener that the Remote access status does
not show. Turning remote access on in Settings then fails with "The remote
listener is running." The listener does not count as activity, so the host
can idle out while devices depend on it.

Scope: through DH-07, these flags and their environment variables override
the saved remote access setting. The remote access status reports them with
their source, Settings shows them read-only (DH-13), and their listener counts
as activity.

Completion criteria:

- A host started with the flags reports remote access as on, from flags.
- Settings shows that read-only, and nothing in Settings can start a second
  listener.
- The host does not idle out while the listener is up.

Validation:

- `remote-access.test.js`: an override listens with its options, reports
  `mode: "proxy"` with its sources and readiness, refuses enable and disable,
  and leaves the saved settings alone.
- Live: a host started with `--remote-port 0 --remote-origin …` reports
  remote access as on, from those flags, with the port actually in use, and
  refuses Settings' change with the reason.
- Remote access being on counts as activity, so the host does not idle out
  (`isBusy` reads `status().enabled`).

Remaining/deferred: none.

## DH-15: Sharing & access for other hosts and the browser client

Status: implemented; not exercised with SSH or paired hosts

Problem and trigger: remote access and paired devices can be managed only for
the desktop's home host, and only from the desktop. An SSH host or paired host
needs `dream-host remote …` on that machine.

Scope:

- **Desktop.** DH-12's page for any host the desktop uses: editable when its
  credential has `manage`, read-only with `view` or `operate`. The desktop's
  route to an SSH host carries the host's launch token, so it has `manage`.
- **Browser client.** The page for its home host, in a computer's browser
  (DH-17).

Completion criteria:

- An SSH host's and a paired host's sharing can be managed from the desktop
  with `manage`, and only viewed without it.
- A browser client with `manage` can manage its host.

Validation: the page offers this computer's host and every connected
host. `/api/remote/session` decides what is offered:

- the desktop's route to an SSH host carries the host's launch token (local
  operator), so it may change remote access;
- a paired HTTPS route sees remote access read-only;
- a client without `manage` sees why.

The remote listener now answers the remote access status and the settings
report to `manage` (route policy); changing access stays local-only. The
browser client case was checked in the browser panel.

Remaining/deferred: a walkthrough with a connected SSH host and a paired HTTPS
host.

## DH-16: WSL distribution picker

Status: removed 2026-10-30 (see the scope change below)

Problem and trigger: a WSL host is added by typing `wsl:<name>` as an SSH
target. That is undiscoverable, and its route shows that internal form.

Scope:

- **Add host → WSL distribution**, on Windows only, lists the installed
  distributions (`wsl.exe --list`) and creates the `wsl:<name>` route, which
  stays internal.
- The SSH dialog no longer suggests `wsl:` targets.
- The route is shown as the distribution's name.
- The choice is hidden where WSL is absent or has no distributions.

Completion criteria:

- A WSL host can be added without typing.
- Existing `wsl:` routes keep working and are shown by name.

Validation: typecheck, lint, and the handler test of
`listWslDistributions`.

- **Add host** offers **WSL distribution** when there are distributions not
  yet added; it saves the internal `wsl:<name>` route.
- Routes show the distribution's name with a WSL badge.
- The SSH dialog no longer suggests `wsl:` targets.

Scope change (2026-10-30): WSL hosts were removed (code, UI, docs). Dream
does not install or manage a host inside WSL; the user installs and runs
`dream-host` wherever it is needed and reaches it like any other host.

Remaining/deferred: a walkthrough with this machine's Debian or Ubuntu (it
installs a runtime and starts a host inside the distribution).

## DH-17: No phone client

Status: implemented, as proposed

Problem and trigger: decided 2026-10-30. Dream is not meant to be used on a
phone; mobile is a separate, future project. CONN-04 built a phone layout and
CONN-01 to CONN-05 aimed pairing at phones (QR codes), so connecting from a
phone is currently offered.

Scope (proposed; each item to confirm):

- Remove the compact phone layout (`src/lib/use-compact-layout.ts`, below
  640px) and its sheet panels.
- Remove QR codes from pairing in Settings, `dream-host pair` and
  `serve --pair`, keeping the link and the code.
- Remove phone wording from the UI, docs and glossary.
- Record the reversal on CONN-04 and the phone milestone in
  `remote-connections.md`.

The browser client stays, for a computer's browser.

Completion criteria: to be set once the scope is confirmed.

Validation:

- The compact layout is gone (`use-compact-layout.ts` and `compact-bar.tsx`
  removed, with their branches in the workspace, the header, the file
  explorer and Settings). A narrow window shows the normal layout, as seen at
  605px in the browser panel.
- QR codes are gone from Settings and from `dream-host pair` and
  `serve --pair`, and the `uqr` dependency is removed; the link and the code
  remain.
- Phone wording is gone from the UI messages in all locales, the docs and the
  glossary. `remote-connections.md` records the reversal (2026-10-30).

Remaining/deferred: none.

## DH-18: Pairing by code only, with no approval

Status: implemented

Problem and trigger: decided 2026-10-30. The user found the link method
cumbersome: a long secret URL to copy to the other computer, next to a code
path that also needed someone on the host to confirm the device by name. With
no phone client (DH-17), the other computer types well, and whoever creates
the code is already the approval.

Scope:

- **Host.** A pairing is a short code only: 8 Crockford base32 characters
  (40 bits), single use, ten minutes, attempts rate limited to 10 a minute
  host-wide. `redeemPairingCode` turns it into a session at once. Removed: the
  link secret and its fragment, claims, `POST /api/remote/pair`,
  `/api/remote/pair/claim`, `/api/remote/claims` and
  `/api/remote/claims/answer`. `POST /api/remote/pair/code` now answers with
  the session (a cookie for a browser, a token for the desktop).
- **CLI.** `dream-host pair` and `serve --pair` print the code and the
  verified address. `dream-host claims`, `confirm` and `deny` are removed.
- **Desktop.** **Add host > Pairing code** takes the address and the code, with
  no tabs and no waiting; Cancel stops an attempt in flight. The link IPC
  (`pairHost`) is removed.
- **Browser client.** The pairing screen takes a code and a device name; there
  is no `/pair#pair=…` entry point.
- **Sharing & access.** **Pair a computer** (was **Create link**) shows the code
  and the host's address, each with a copy button. The pending requests list
  is removed. A paired client appears under Authorized clients and can be
  revoked there.

Completion criteria:

- No link, claim or confirmation remains in the host, CLI, desktop, browser
  client, settings, locales or docs.
- A code redeems once, an expired or used code is refused, and code attempts
  are rate limited. Met in `host-auth.test.js`.

Validation: `host-auth.test.js`, `desktop-handlers.test.js`,
`remote-access-state.test.ts` and `pnpm check`.

Remaining/deferred: a walkthrough pairing a second desktop and a browser
against a real host, and a visual check of the new dialogs.

## Order of the second round

DH-07 → DH-08 → DH-09 → DH-10, then DH-11 → DH-12 → DH-13 → DH-14 → DH-15.
DH-16, DH-17 and DH-18 can go at any point.

Recovery: docs/architecture/tasks/detached-host.md. DH-01 to DH-18 are
implemented (DH-04 publishing pending). What remains is listed under each
candidate: mostly walkthroughs (macOS/Linux, real SSH/HTTPS/WSL hosts, the
service manager examples) and visual checks of the desktop pages. Latest
validation: `pnpm check`, the packaged Windows walkthroughs of DH-02 and
DH-09, and the browser client's Sharing & access page.
