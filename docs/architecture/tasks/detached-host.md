# Detached host

Follow-up to the 2026-10-29 comparison with T3 Code's `t3 serve` (pinned
source `pingdotgg/t3code@dd14848`). Dream already has the daemon, the host
service, pairing, the browser client and several routes per host. These
candidates close the remaining gaps the comparison found. Scope agreed
2026-10-29: implement DH-01 through DH-06.

Dependency order: DH-01 → DH-02 → DH-03. DH-04, DH-05 and DH-06 are
independent of them.

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

Status: implemented

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

Status: implemented

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

Status: implemented; publishing pending

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

Remaining/deferred: a live reconnect check on a phone.

## DH-06: Headless pairing, approval signal, WSL hosts

Status: implemented

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

Remaining/deferred:

- A walkthrough with a real distribution. It installs a runtime and starts a
  host inside it.
- A visual check of the approval indicator.
- Chats waiting on approval are not yet dropped from the client's map when
  their project closes.

Recovery: docs/architecture/tasks/detached-host.md, DH-01 to DH-06 implemented
(DH-04 publishing pending); remaining items are listed under each candidate.
Latest validation: `pnpm check` (see the final run) and the packaged Windows
walkthrough of DH-02/03.
