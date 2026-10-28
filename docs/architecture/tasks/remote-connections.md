# Dream remote connections implementation plan

Build remote access around the existing Host, Host catalog and Chat run owners.
The first release should let a phone browser pair with a Dream host over
Tailscale, read chats, submit work, answer approvals and recover after suspension.
Then add unattended hosting, multiple routes and Cloudflare Tunnel support.
This connection effort covers the existing desktop and browser clients. A native
mobile application requires a separate project with its own scope, architecture,
estimates and release work; it is not a delivery milestone of this plan.

Status: CONN-01 to CONN-06 implemented; CONN-06's native Windows/Linux update,
login/reboot and live-provider walkthroughs remain unverified;
CONN-07 implemented (physical-network and cross-platform walkthroughs pending);
CONN-08 implemented, validation pending: the real-tunnel completion criteria
and native Windows/Linux walkthroughs are unmet.
CONN-09 and CONN-10
are reserved references for a separate, unscheduled mobile project. CONN-11 is
an independent future browser project. Current connection work ends at CONN-08.
Task numbers below retain their stable CONN-01 through CONN-11 references.

## Delivery order

| Milestone | Tasks | User-visible completion |
| --- | --- | --- |
| 1 Phone browser over Tailscale | 01–05 | Pair from a QR code, work from a phone, reconnect and revoke that phone |
| 2 Reliable unattended access | 06–07 | Keep the host running without its desktop window; reach one host through several routes |
| 3 Cloudflare Tunnel support | 08 | Reach the host from existing desktop and browser clients through a stable HTTPS tunnel |

Dependency order: 01 → 02 → 03 → 04 → 05. Task 06 follows 03 and 04;
07 follows 05; 08 follows 06 and 07. CONN-11 may reuse 02, 03 and 06 but is not
required to complete this effort. Mobile and push dependencies will be defined
when the separate mobile project is scoped; they do not gate CONN-08.

Scope decision (2026-10-26): replace the proposed Dream Connect account,
discovery and authorization service with Cloudflare Tunnel integration. Exclude
native mobile development and mobile push delivery from this work. Existing
phone-browser support remains part of the web client already implemented; it
does not imply a native app, a selected mobile framework, or a mobile schedule.

Ship milestone 1 before adding tunnel management. It requires no Dream account
or cloud backend. Initially the desktop-hosted machine must keep Dream running;
an existing standalone daemon can also serve the client. Its current idle timeout
must be disabled explicitly for unattended use until task 06 owns that policy.

## Architecture decisions

- Retain HTTP JSON routes, the AI SDK chat stream, host socket channels, the
  scheduler and the single SQLite writer. This is an access and client-lifecycle
  change, not a replacement execution model.
- Give every host installation a durable identity. A client's saved connection
  points to that identity and contains routes; a route is a URL or an SSH launch
  configuration. Tailscale is a way to reach a host, not a separate host type.
- Keep projects, chats, transcripts, provider credentials and execution on the
  host. Keep open tabs, layout, drafts, saved connections and UI preferences in
  each client's workspace. Do not synchronize desktop layouts onto phones.
- Keep the shared connection runtime free of Electron, React and browser globals.
  Inject storage, credentials, network transport and lifecycle signals. Desktop
  owns SSH processes; browser and native clients do not need an SSH implementation.
- Serve the first web client and its API from one HTTPS origin through Tailscale
  Serve. This avoids a hosted HTTPS client depending on a plain HTTP LAN API.
  Tailscale documents Serve as a tailnet reverse proxy with HTTPS support;
  Dream still performs its own pairing and authorization.
  [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
- Use a separate remote-facing listener/router with an explicit route policy.
  A tunnel must not expose desktop bootstrap credentials, internal MCP endpoints
  or the desktop's arbitrary SSH proxy routes. Both listeners call the same
  host services; they do not create another catalog or scheduler.
- Target personal-device access first. Pairing grants control of the host under
  its OS user; team tenancy and project-level isolation are separate work. Define
  session scopes now so view-only access and management privileges are explicit.
- Preserve existing SSH connections during migration. Add direct routes first,
  migrate desktop SSH onto the shared runtime, then retire redundant routing.

The model follows T3's separation of identity, reachability and process ownership,
as described in its pinned
[remote architecture](https://github.com/pingdotgg/t3code/blob/9077e818d836ec6e9cc373d7469034cccc593a5a/docs/internals/remote.md).
The milestones below are Dream's proposed implementation, not claims that every
feature in that source is available in a released T3 client.

## CONN-01: Persistent host identity and connection records

Status: implemented (desktop UI walkthrough pending; see Validation)

Problem and trigger: `local` and SSH configuration IDs currently identify routing
choices. The same host added through Tailscale would otherwise appear as another
host, and reconnecting to a reassigned address could target the wrong machine.

Scope: add `electron/host/identity.js` and a public, minimal host descriptor.
Extend `electron/host/protocol.js`, `src/types/ide.ts` and the persisted-state
codec with versioned saved connection/route records. Keep identity stable in the
host data directory across restarts and runtime upgrades. Include a public-key
fingerprint for authenticated identity verification as later routes require it.

Record the distinction between persistent host ID, client connection ID, route
ID, client device ID and authenticated session ID. Preserve current project/chat
IDs; resolve them within a host and audit caches for collisions across catalogs.
Maintain a mapping from legacy `local`/SSH IDs to persistent host IDs rather than
rewriting all rows during startup. Migrate an offline SSH record only after its
first verified connection. Changing a route must never silently change its host.

Completion criteria:

- Restart, runtime upgrade and endpoint change preserve the host identity.
- Concurrent initialization publishes one complete identity; separate data
  directories have separate identities.
- A legacy workspace opens with the same projects and chats. Pairing its host
  through another route does not duplicate those projects.
- A descriptor exposes identity and compatibility, not filesystem paths or
  credentials. An ID match alone is not treated as cryptographic authentication.
- An incompatible protocol produces an actionable error before catalog loading.

Agreed scope (as implemented):

- `electron/host/identity.js` creates `host-identity.json` (0600) in the host
  data directory: `host_<uuid>` plus an Ed25519 key pair. It is published with
  a hard link of a complete temporary file, or an exclusive create where links
  are unsupported, and is never replaced. An unreadable or tampered file stops
  the host with instructions; it is never silently regenerated.
- `createHost` exposes `getHostDescriptor()` (ID, `SHA256:` fingerprint,
  public key, protocol, capabilities, version). `/api/host-info`, daemon
  `ensure`/`status` and the host record name the ID. `/api/catalog` lists the
  descriptor as `host`. Protocol capability `host-identity` was added without
  a protocol version bump. `hostProtocolProblem` in `protocol.js` produces the
  actionable incompatibility message for SSH and for catalog acceptance.
- Saved connections are `hostConnections`, a codec plain persisted field
  (versioned `SavedHostConnection` records with `local`/`ssh` routes;
  `electron/shared/host-connections.js`). Connection IDs remain the legacy
  `local`/SSH IDs, so no workspace, project or chat row is rewritten.
- Before a catalog is applied, `host-catalog-lifecycle.ts` accepts its
  descriptor. A first verified load saves the connection. A saved connection
  that reaches another host, or a host that stops identifying itself, is
  refused, and so is a second connection to an already saved host, an
  incompatible protocol, or project/chat IDs that collide with another host's
  (copied data). A refusal disconnects that SSH host with the reason. The local
  route records rather than refuses. The local identity is recorded after
  hydration, so it is saved.
- The SSH connection pins the expected identity passed from the saved record,
  or the first host it reaches. A different host on connect or reconnect is a
  fatal error, so a reassigned address is never retried into the wrong host.
  Removing an SSH host forgets its saved connection; editing its target keeps
  the pinned identity.

Validation (2026-10-18): `pnpm typecheck`, `pnpm lint` and `pnpm test` (173
files, 1197 passed, 4 skipped) pass. Existing tests updated for the new field
and contract: codec plain-field samples (now compared deeply), save-scheduler
and workspace-save fixtures, the desktop-handler connect payload, the
host-actions connect payload and the daemon capabilities. No new tests were
added. Ad hoc scratch programs outside the checkout passed:
- Eight concurrent processes initializing one directory published one ID.
  Restart reread it; a separate directory got a new ID. A tampered key was
  refused and left in place.
- Acceptance covered: legacy host without identity (still routes, unsaved),
  first verification, repeat, wrong host, same ID with another key, a saved
  host that stops identifying itself, a duplicate SSH connection, an SSH
  connection reaching the local host, protocol 2, and local re-recording.
  The codec dropped unknown record versions and duplicate host IDs.
  Colliding fixture IDs across two catalogs were found; a host's own snapshot
  IDs were not.
- A real daemon (restarted) kept its ID. Its catalog descriptor contained no
  path, PID or token.
- The SSH connection with fake ssh and a real daemon: a reconnect to a daemon
  whose identity changed failed fatally without retry, an expected identity
  refused the other host up front, and a fresh connection accepted it.

Not yet inspected: the running desktop app with copies of real local and SSH
workspaces (Electron main must be restarted to load the host change), and an
SSH host on a real remote machine.

Remaining/deferred: device authorization is CONN-02; route selection,
cryptographic proof of identity over routes that cannot vouch for the host,
and merging several routes into one connection are CONN-07. Unauthenticated
descriptor access belongs to CONN-02's remote route policy.

## CONN-02: Pairing and revocable device sessions

Status: implemented (desktop pairing UI and CLI are CONN-05; see Validation)

Problem and trigger: the current launch token and one-time socket tickets do not
provide independent device credentials, session management or remote permissions.

Scope: add `electron/host/auth/` for pairing challenges, session storage and
authorization; integrate with `electron/api/app.js`, shared socket tickets and
socket connection ownership. Store records through the existing writer.
Retain desktop bootstrap as a local-only mechanism.

Use expiring, single-use pairing links/QR codes minted by a locally authorized
operator. Carry the secret in a URL fragment and remove it after exchange;
provide a rate-limited short-code alternative with host-side confirmation.
The grant names its scopes and device. Start with view, operate and manage;
only an authorized manager can pair or revoke other clients.

For the same-origin web client, prefer an HttpOnly Secure session cookie and
origin/CSRF enforcement. Native clients use credentials in OS secure storage.
Store token verifiers rather than plaintext bearer secrets on the host. Bind
socket tickets to sessions and recheck revocation when the ticket is redeemed.
Define expiry and renewal in the contract; renewal must not replace a healthy
stream. Ordinary workspace exports must contain no session secrets.

Completion criteria:

- Used, expired and brute-forced pairing attempts fail without granting access.
- Two phones receive independent sessions; revoking one closes its active
  sockets/streams and blocks renewal without stopping the other phone or host work.
- Every remotely exposed HTTP route and socket channel enforces its scope,
  including terminals, approvals, files, provider settings and browser tools.
- Remote clients cannot obtain the local launch token or reach internal
  orchestration MCP, desktop SSH proxy or management routes without authorization.
- Origin, Host and trusted-proxy handling is explicit; secrets are excluded from
  URLs sent to servers, diagnostics and logs. View-only sessions cannot mutate.

Validation: pending; inspect the full route/channel inventory and manually
exercise invalid pairing, expiry, CSRF, ticket replay and live revocation.
Run existing token, socket-ticket, proxy and approval checks.

Agreed scope (as implemented):

- `electron/host/auth/`:
  - `scopes.js` defines the ladder: view < operate < manage.
  - `host-auth.js` owns pairings and code claims (in memory), device
    sessions (in memory, plus the `device_sessions` table through the save
    queue's `device-session` write and the read pool's `device-sessions`
    read), authentication, renewal, revocation and live socket/stream
    tracking.
  - `route-policy.js` assigns a scope to each served route and each socket
    message, and lists the local-only routes.
  - Migration `0007` adds the table.
- The pairing, session and expiry contract is in the header of
  `host-auth.js`:
  - A pairing expires after 10 minutes and works once. The link carries
    `#pair=<id>.<secret>` in the fragment.
  - The short code is 8 Crockford characters, limited to 10 claims a minute
    host-wide, and needs operator confirmation by device name before the
    device's poll receives the session once.
  - Wrong secrets are limited to 30 a minute.
  - Tokens are `dsess.<id>.<secret>`; only sha256(secret) is stored.
  - A session expires after 30 idle days. A use after an hour extends it
    (and is written down). `POST /api/remote/session/renew` extends it
    without changing the credential, so streams and sockets continue.
    Revocation is immediate.
- `electron/api/app.js` now registers routes once for both listeners
  (`registerHostRoutes`, `serveApp`). On the local listener the launch token
  is the `local` principal with every scope.
- `electron/api/remote-app.js` is the remote listener:
  - Host allowlist from the public origins; `trustForwardedHost` is the
    explicit trusted-proxy switch.
  - Foreign Origin and cross-site fetch metadata are refused.
  - Bearer token or `__Host-dream-session` cookie (HttpOnly, Secure,
    SameSite=Strict). A cookie-carried request other than GET must send a
    matching Origin.
  - Route policy check: unlisted routes return 404, too-low scopes 403, and
    startup asserts every registered route is classified.
  - Response bodies close on revocation, which detaches the observer only.
- Local-only, never registered remotely: `host-info`, orchestration MCP,
  browser MCP, `browser-tools/call` and the `/api/hosts/:hostId/*` SSH proxy.
  On the host socket, the browser channel (including its resume
  announcement) is local-only. Terminal input and resize need operate;
  following terminals and catalog changes needs view.
- Socket tickets are bound to the requesting principal. Redemption rechecks
  the session, and revocation closes the socket with code 4401.
- Remote-access routes (`electron/api/remote-access-routes.js`):
  - Public: `GET /api/remote/descriptor`, `POST /api/remote/pair`,
    `/pair/code`, `/pair/claim`.
  - Session: `GET /api/remote/session`, `POST .../session/renew`,
    `.../session/end`.
  - Manage: `POST /api/remote/pairings`, `/claims`, `/claims/answer`,
    `/sessions`, `/sessions/revoke`. These are also served on the local
    listener for the local operator.
  - A web client receives only the cookie; a native client receives its
    token in the body.
- `createHost` exposes `listenRemote` and `closeRemote`. The daemon gained
  `--remote-port`, `--remote-origin` (repeatable) and
  `--trust-forwarded-host` so the listener can be exercised; the record and
  status include `remotePort`.

Validation (2026-10-18): `pnpm typecheck`, `pnpm lint` and `pnpm test` (173
files, 1197 passed, 4 skipped) pass. Existing tests updated: the socket
ticket test (redeem now returns the principal) and two migration-rewind
tests (they drop the new table). No new tests were added. Ad hoc scratch
programs outside the checkout passed:
- A real daemon with its remote listener passed 50 checks:
  - The descriptor is public; requests without a session, or with only the
    launch token, are refused.
  - All five local-only routes return 404.
  - Pairing: link exchange; replayed and forged secrets refused; secret only
    in URL fragments; web pairing sets the hardened cookie and returns no
    token.
  - CSRF and Host: cookie POST without Origin or from a foreign Origin
    refused; cross-site metadata refused; unknown Host refused with 421.
  - Scopes: view refused for catalog changes, chat submit, approvals,
    terminal start, commit, checkpoint restore, pairing and device listing;
    pull-request reads allowed and merges refused; operate refused for CLI
    upgrade.
  - Code flow: pending, then confirmed by name, then delivered once; code
    guessing limited.
  - Two phones' sockets: ticket replay refused; revoking one closed its
    socket (4401), blocked its requests, renewal and new tickets, and left
    the other phone's socket, requests and renewal working.
  - No token or pairing secret in the database or host log. A session and a
    revocation both survived a daemon restart. Self sign-out works.
- With a fake clock: expired pairing link and code; expired idle session and
  its renewal refused; sliding extension written down; tampered tokens
  refused; operate cannot mint manage; secret guessing limited. Socket
  scopes: view cannot type into terminals, and no remote client can run or
  announce the browser channel. Revoking a session ended its open stream
  with an error and cancelled only the observer.

- The local host built as Electron main builds it (a shared save queue
  behind main's writer adapter) starts without warnings. A pairing made on it
  is written through the shared queue, and the new session reads the catalog.
  The first desktop start failed because `electron/main.js`'s adapter lacked
  `writeDeviceSession`. That is fixed, and a failed session load no longer
  stops the local host.

Not yet inspected: a real browser over HTTPS, since the cookie path is
validated with Node fetch (CONN-04/05), and a desktop-hosted remote listener
(the desktop does not start one until CONN-05's settings).

Known limit, recorded rather than fixed: pairing grants the host's OS user.
View sessions read files by path, without project isolation, so they can
read files such as a daemon's `host.json` that contains its launch token.
That token is useless through the remote listener, which ignores it.
Project-level isolation is outside this plan.

Remaining/deferred: pairing and session UI, QR codes and CLI commands are
CONN-05. Serving the web client's pairing page at `/pair` is CONN-04.
Cloud-bound proof credentials are CONN-08. Team isolation and arbitrary
project-specific grants are outside this plan.

## CONN-03: Shared connection runtime and platform services

Status: implemented (desktop walkthrough pending; see Validation)

Problem and trigger: API authorization, socket URLs, workspace loading and SSH
actions currently assume `window.dream` and a local same-origin API.

Scope: introduce `src/lib/connections/` with one connection supervisor per host
and narrow platform ports for workspace storage, credentials, lifecycle and SSH
launching. Route `api-client.ts`, `api-session.ts`, `host-routing.ts`,
`host-socket.ts`, chat streaming and raw file/attachment fetches through it.
Adapt `ide-store-persistence.ts` to a workspace storage interface: current IPC
on desktop, IndexedDB in web. Keep the codec and workspace change-set rules.
Avoid implementing a fake desktop bridge in the browser.

Completion criteria:

- Every host request uses that host's endpoint and credentials, including
  downloads and streams; credentials never attach to unrelated URLs or redirects.
- Booting without Electron loads a paired host and a client-local workspace.
  Desktop startup and SSH access retain existing behavior.
- State distinguishes connecting, ready, reconnecting, unauthorized,
  incompatible and offline; catalog freshness is tracked separately.
- Foregrounding probes or replaces a stale connection, then resumes channel
  cursors or refetches after reset. Old connections cannot overwrite new state.
- Ambiguous chat submissions reuse existing durable request IDs. Other writes,
  approvals and buffered terminal input are not blindly replayed on reconnect.
- Removing a connection clears its credentials and local caches; a temporary
  disconnect preserves drafts and readable cached data.

Validation: pending; run existing host socket, routing, catalog-sync, transcript
and scheduler checks; inspect a dropped stream and delayed response during
connection replacement. Include two clients editing the same host catalog.

Agreed scope (as implemented):

- `src/lib/connections/`:
  - `platform.ts` chooses the client once: desktop (the preload bridge,
    launch token, main-process workspace) or web (a page served by a paired
    host, which is its home host). The browser gets no fake desktop bridge.
  - `workspace-storage.ts` is the workspace port: desktop IPC, or IndexedDB
    (`dream-workspace`) applying the same change sets with main's SQL rules
    (config keys, saved prompts with first `createdAt`, upsert/move/remove
    rows).
  - `host-endpoint.ts` resolves each host's URL, headers and credentials
    mode and is the only path that attaches a credential. `hostFetch`,
    `hostRequestOptions` (chat transport) and `hostWebSocketUrl` cover JSON
    routes, raw file loads, chat streams and the host socket. Only `/api/`
    paths are accepted and redirects are errors. The global `window.fetch`
    patch (`installApiSessionGuard`) is removed.
  - `supervisor.ts` keeps per-host state (`connecting`, `ready`,
    `reconnecting`, `unauthorized`, `incompatible`, `offline`), separate from
    catalog readiness, and the lifecycle port (visibility, back/forward
    cache, `online`). A browser client's home host is judged by its own
    requests and probed with `GET /api/remote/session`; desktop SSH hosts
    follow main's status events and identity refusals.
  - `runtime.ts` starts it from `main.tsx`; `forget.ts` signs a browser
    client out of its home host and clears its workspace and socket.
- The `local` connection is the client's **home host**. On the desktop its
  route is `local` (recorded, never refused). In a browser it is an
  `origin` route, pinned like any address: a different host at that origin
  is refused before its catalog is shown (`HostRoute` gained `origin`;
  `acceptHostDescriptor` takes `homeRoute`).
- Startup (`ide-store-persistence.ts`) loads the workspace from the
  platform port. A browser client whose home host is unreachable,
  unauthorized or a different host opens from the cached workspace rows.
  Nothing from that cache is synced to a host; the catalog is loaded when
  the host becomes `ready` (`store/connection-follow.ts`).
- Resuming (`online`, or foreground after 15 s hidden): every host socket is
  replaced, catalogs of the home host and connected SSH hosts are refetched,
  and running turns are followed on fresh streams (`reattachChatStreams`
  drops only this window's observer). A replaced socket's late messages are
  ignored. Terminal input waits at most 5 s for a socket, then is dropped
  rather than replayed (`replay: false`). A host refusing this client stops
  the socket's retries until its state clears. Chat submissions already
  retry by durable request id; nothing else is replayed.
- The shell now watches its home host's catalog without Electron too
  (browser relay and SSH status stay desktop-only).

Validation (2026-10-20): `pnpm typecheck`, `pnpm lint`, `pnpm test` (173
files, 1197 passed, 4 skipped) and `pnpm check:scratch` pass. Existing
tests updated: the HTTP transport call shape (credentials mode, redirect,
Headers), `fetchApiBlob`'s request argument and the relay test's fake
`send`. No new tests were added.

A scratch harness outside the checkout served the built renderer (`pnpm
vite:build`) at `http://127.0.0.1:7391` in the built-in browser. It forwarded
`/api` to a daemon's remote listener and added a paired device's bearer token
in place of the cookie, which needs HTTPS. Observed:
- Boot without Electron: no warnings. The workspace was created in
  IndexedDB, and the saved connection pinned the daemon's host ID through
  an `origin` route. Settings read the host's providers; the host's project
  opened. The workspace restored after reload, and the host socket opened.
- Every request went to the host's `/api` paths through the endpoint layer.
- A rename by another client arrived live over the socket, before and after
  socket replacement and after offline recovery.
- `online`: new socket ticket, session probe and catalog refetch.
- Offline start (harness dropped `/api`): the project, chat and model
  opened from the cache with one warning. Back online, the catalog loaded
  and the panels recovered without a reload.
- Credential refused (401): one ticket attempt, one probe, one catalog read,
  then no retries for 15 s. The page kept its project and drafts.
- Same origin, different daemon: refused with the identity message. The
  cached project stayed, nothing was pushed to the new host, and the saved
  connection still named the first host.

Not yet inspected:
- The desktop app itself (Electron was not running): local and SSH
  projects, terminals and chat streams over the new endpoint layer.
- The visibility path, because the built-in browser pins
  `document.visibilityState`; `online` exercised the same resume handler.
- A dropped chat stream and a delayed response during socket replacement,
  since no agent turn was run.
- The 5 s terminal-input window and `forgetHomeConnection`, which has no
  UI yet.
- Two browser clients editing one catalog; the other client here was a
  script.

Known limits: messages still name the home host by its address, and the
footer labels it "Local" in a browser. The identity refusal tells a browser
user to remove and re-add the host, where signing out and pairing again is
the remedy. Connection state has no UI yet. These are CONN-04's.

Remaining/deferred: ordered route failover is CONN-07. Keep the runtime in the
current tree initially; package it for native use in CONN-09 if needed.
Serving the client from the remote listener, the pairing page, connection
state in the UI and browser-specific labels are CONN-04.

## CONN-04: Browser client and phone layout

Status: implemented (real phones and the desktop walkthrough pending; see
Validation)

Problem and trigger: a reachable API alone cannot provide a usable client on a
phone, and workspace startup currently requires Electron IPC.

Scope: reuse the React application with a browser entry and responsive navigation.
Add a static asset handler to the remote listener and include the client build
in host archives via `scripts/build-host-runtime.mjs`. Adapt desktop-only
clipboard, dialogs, uploads, downloads and external links through platform
services. Keep desktop settings out of browser flows.

The first mobile layout offers host/project navigation, one active chat, readable
history, composer attachments, queue/Stop controls, approvals, file reading and
diff inspection. Opening an existing project or selecting a host directory uses
the host directory API, not the phone's filesystem picker.

Completion criteria:

- A clean browser profile can pair and complete that workflow without Electron.
- At 360px width, keyboard appearance and safe areas do not hide the composer
  or approval controls; desktop and tablet layouts remain usable.
- Phone and desktop see the same host changes while keeping separate layout and
  drafts. Simultaneous approval responses produce one accepted decision.
- Suspending the browser during a turn, then returning, restores current state
  without resubmitting work. Interrupted host runs retain existing explicit-resume
  behavior rather than appearing to continue.
- Static routes cannot serve arbitrary host files; cached assets remain compatible
  with the host protocol. Initial delivery does not cache authenticated API data
  in a service worker.

Validation: pending; inspect the running development app and built assets on
iOS Safari, Android Chrome and desktop browsers. Follow the development-tools
guide for UI inspection; do not start a dev server.

Agreed scope (as implemented):

- The host serves the client. `electron/api/client-assets.js` is the remote
  listener's not-found handler, not a route, so the route policy is
  unchanged. It serves one directory's regular files: no `..`, no dotfiles,
  no symlink out of the directory, nothing under `/api`, and only GET and
  HEAD.
  - `/assets/*` are immutable for a year. Everything else, including
    `index.html`, is revalidated on every load, so an upgraded host's client
    reaches the browser on its next load.
  - Page paths fall back to `index.html`.
  - `index.html` carries a CSP: scripts from `'self'` plus the inline boot
    script's hash and `'wasm-unsafe-eval'`, `connect-src 'self'`,
    `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`.
  - There is no service worker, and API responses stay `no-store`.
  - The daemon gained `--client-dir`. It defaults to the runtime's `client/`,
    or `dist/` in a checkout. `scripts/build-host-runtime.mjs` copies `dist/`
    into `client/` and requires a renderer build; the host-runtime release
    job now runs `pnpm vite:build` first.
- Pairing in the browser:
  - `src/lib/connections/pairing.ts` reads and removes `#pair=` from the
    address bar before sending anything, exchanges it as `clientKind:
    "web"` (the cookie is set), or requests and polls a code claim.
  - `src/components/remote/pairing-screen.tsx` is shown by `app.tsx` instead
    of the IDE when a browser client is opened from a pairing link or its
    home host is `unauthorized` (never paired, revoked, expired).
  - The device name defaults to `<device> · <browser>`.
- Connection state in the UI:
  - `ConnectionBanner` shows offline, reconnecting and incompatible (with
    Sign out) for a browser client.
  - `ProjectHostLabel` names the home host with a connection dot instead of
    "Local".
  - Settings shows a "This device" block with Sign out
    (`forgetHomeConnection`) and hides SSH hosts, which are the desktop's.
  - Origin-route identity refusals tell a browser user to sign out and pair
    again.
- Desktop-only services:
  - Terminals no longer require the desktop bridge (start, stop, input,
    output, shell detection), since they run on the host over its socket.
  - "Open folder" in a browser opens `OpenHomeFolderDialog`, which browses
    the home host through its directory API (`HostFolderBrowser` treats a
    ready home host as connected). "Open on SSH host" is desktop-only.
    (Since OPEN-01, both are one dialog: `open-project-flow.md`.)
  - The webview browser panel and its rail button are desktop-only (CONN-11).
  - Clipboard, downloads and external links already fell back to browser
    APIs.
  - Window controls and the updater already rendered nothing without the
    bridge.
- Phone layout (`src/lib/use-compact-layout.ts`, below 640px; the desktop
  window's minimum width is 1180px, so it never applies there):
  - The shell uses `h-dvh` and safe-area padding; `index.html` sets
    `viewport-fit=cover` and `interactive-widget=resizes-content`, so the
    keyboard resizes the page rather than covering the composer.
  - The workspace shows one chat with no column minimum
    (`WorkspaceChatStack` gained `minColumnWidth`).
  - A compact bar (`workspace/compact-bar.tsx`) holds history and new chat on
    the left, and Git, files, terminal and stash on the right; each panel
    opens as a full sheet. The right panel starts closed when the compact
    layout takes over.
  - The header drops the back and forward arrows.
  - Settings shows its section list or one section full width, with Back.
  - Files shows the tree or the open file full width, with Back.
- Small shared fixes found at 360px:
  - Provider cards wrap their version and update badge.
  - The sparkle field clips horizontally (`overflow-x: clip`), so a running
    turn no longer makes the chat column scroll sideways (on the desktop
    too).
- Approvals: the host already takes and deletes a pending approval before
  awaiting it, so a second response gets `not-found` and the losing client
  shows "approval expired". Exactly one decision is accepted.
- New `remote` message namespace in all 11 locales.

Validation (2026-10-20): `pnpm typecheck`, `pnpm lint`, `pnpm test` (173
files, 1197 passed, 4 skipped) and `pnpm check:scratch` pass. No new tests
were added.

A scratch daemon served the built client from its own remote listener at
`http://127.0.0.1:7401`; Chromium treats loopback as secure, so the real
`__Host-` cookie was used. A control script stood in for the operator, and the
built-in browser was the client.

- Static serving:
  - Traversal (`..%2f`, `..%5c`), dot directories, POST, unknown assets and
    unknown API paths were refused.
  - `/pair` and `/.env` returned the app page, not a file.
  - Hashed assets were immutable, `index.html` was `no-cache` with the CSP,
    and the page ran under the CSP with no console errors.
- Pairing by link: a web session was recorded as "Windows · Chrome", the
  fragment left the address bar, and the IDE loaded on the cookie.
- Pairing by code at 360px: the device waited as "Test phone"; the operator
  listed the claim and confirmed it, and the device restarted paired into its
  cached project.
- Phone layout, in 360x740 and 412x860 frames (a test proxy stripped only
  the anti-framing headers):
  - empty state, Settings list and sections (Providers);
  - a project opening to its chat;
  - the Files tree, then a file, then Back;
  - Git changes, with a host-generated commit message and an expanded diff
    that wraps;
  - three real Claude turns: submit, streaming, Stop shown while running,
    tool chips and replies;
  - no horizontal overflow while a turn ran, after the sparkle fix.
- Two clients on one host: the second frame showed each turn live.
- Resume mid-turn (`online` fired while streaming): the host held the
  prompt exactly once and the turn completed.
- Revoking the session on the host sent both clients to the pairing screen.

Not yet inspected:
- Real iOS Safari and Android Chrome: the keyboard, safe areas and
  `interactive-widget`. Frames in desktop Chromium approximate width only.
- An approval card at phone width: Claude's Ask mode allowed every command
  tried, so no approval was raised.
- The desktop app itself: the shared components changed, though compact
  never applies there.
- The terminal sheet with typing, and "Open folder" through the host
  directory dialog in a browser.
- Real Tailscale HTTPS, which is CONN-05.

Known limits:
- Once, just-submitted prompts showed no user bubble until reload in both
  clients, though the host stored them. This did not recur after later
  rebuilds; watch for it.
- A second tab of the same browser stays on the pairing screen after another
  tab re-pairs, until it is reloaded.
- The global "Open folder" shortcut does nothing in a browser.
- Terminal and editor ergonomics on phones are the native milestone's.

Remaining/deferred: native push is CONN-10; streamed browser control is CONN-11.
Full phone terminal/editor ergonomics follow in the native client milestone.
Exposing the listener over Tailscale HTTPS, the desktop's pairing UI (QR
code, code confirmation, device list) and CLI commands are CONN-05.

## CONN-05: Tailscale and direct access setup

Status: implemented (real tailnet walkthrough and desktop UI inspection
pending; see Validation)

Problem and trigger: the host listens on loopback and exposes no shareable
client URL or pairing flow.

Scope: add Connections settings and headless CLI commands for exposure status,
pairing and session revocation. Introduce a stable configurable remote listener
port, bound to loopback by default, serving the client and the authorized API.
Use Tailscale Serve to terminate HTTPS and forward to that listener. Show
installation/sign-in/HTTPS prerequisites and the exact setup action; inspect
existing Serve configuration before changing it. Do not overwrite unrelated
services. Stop only exposure that Dream owns.

Support manually supplied HTTPS reverse-proxy endpoints with the same protocol.
An optional LAN listener must be explicitly enabled; first-release phone pairing
requires HTTPS. Do not advertise `127.0.0.1` as a route for another device.

Completion criteria:

- The user gets a reachable HTTPS pairing URL/QR code and can complete milestone
  1 from a phone on the same tailnet, including over cellular networking.
- Missing Tailscale, unavailable HTTPS, port conflicts and denied tailnet access
  have distinct setup messages; no unreachable address is reported as ready.
- Disabling exposure removes remote reachability while local desktop work
  continues; pairing remains required even for a reachable tailnet peer.
- The same packaged host serves UI, HTTP, streaming responses and WebSockets
  through the configured reverse proxy without buffering chat output.

Validation: pending; record a phone-to-desktop and phone-to-daemon walkthrough,
including revocation and reconnect. Inspect proxy configuration and stream behavior.

Agreed scope (as implemented):

- `electron/host/remote-access/` is host-owned, so the desktop's local host
  and a daemon behave the same.
  - `tailscale.js` uses only `tailscale status --json`,
    `tailscale serve status --json`,
    `tailscale serve --bg --yes --https=<port> http://127.0.0.1:<port>` and
    `tailscale serve --https=<port> off`; never `serve reset`. It finds the
    CLI on PATH or where the installer puts it (Windows, macOS).
    On macOS it sets `TAILSCALE_BE_CLI=1` so the bundled executable runs
    as a CLI even when launched by a desktop or service without a terminal.
  - It refuses a port that serves anything other than Dream's loopback
    listener, and removes only an entry that proxies to that listener.
  - Its problems are distinct: `not-installed`, `not-running`,
    `needs-login` (including machine approval), `https-disabled` (empty
    `CertDomains`, or Serve's own message, with its link), `port-taken`,
    `permission` (Linux operator), `failed`.
  - `remote-access.js` keeps `<data>/remote-access.json` (0600): enabled,
    mode `tailscale` or `origin` (the user's HTTPS reverse proxy), a stable
    loopback port picked once, the Tailscale HTTPS port, the proxy's origin,
    and the Serve entry Dream created (`servedBy`).
  - It starts the listener and configures the front. A public origin is
    reported ready only after a request to `<origin>/api/remote/descriptor`
    returned this host's id; otherwise the problem is `unreachable`. A busy
    loopback port is `port-in-use`; a missing or non-HTTPS proxy address is
    `needs-origin`.
  - Turning access off closes the listener and removes only Dream's Serve
    entry; local work and paired sessions are untouched. Switching to a
    manual proxy removes Dream's Serve entry too.
  - A daemon with access on is busy (it does not idle out).
- The remote listener accepts its public origins and its own loopback
  address, but advertises only the public ones in pairing links; loopback
  appears only when there is no public origin. `serveApp` rejects on a listen
  error instead of crashing the process on `EADDRINUSE`.
- Local-listener routes: `POST /api/remote/access`, `/access/enable`,
  `/access/disable`, `/access/check`. They are never registered on the
  remote listener, so a paired device cannot change access.
- Desktop: `main.js` gives the local host its client directory (`dist/`)
  and applies remote access after startup without blocking the window.
  Settings > Remote access (desktop only, `remote-access-section.tsx`):
  - an on/off switch, the mode, the HTTPS port or the proxy address, Apply
    and Check again;
  - the current problem with its setup link;
  - Pair a device: choose access level, then a QR code drawn with `uqr`'s
    `encode`, the link (only a verified public one) with copy, and the code;
  - requests waiting to pair (Confirm, Deny) and paired devices (Revoke,
    confirmed in a dialog).
- CLI (`electron/host/remote-cli.js`, through the running daemon's local API
  and its private run record):
  - `dream-host remote [status|on|off|check] [--tailscale] [--origin url]
    [--https-port n] [--port n]`;
  - `pair [--scopes] [--name]`, which prints a terminal QR code and the link
    only when ready, plus the code;
  - `claims`, `confirm`, `deny`, `devices`, `revoke`, and `--json`;
  - exit 3 when no daemon is running.
  The daemon applies saved settings at start; `--remote-port` still
  overrides them for testing.
- The `remote` namespace gained the section's strings in all 11 locales.
  Added dependency: `uqr` (QR encoding, no dependencies of its own).

Validation (2026-10-21): `pnpm typecheck`, `pnpm lint`, `pnpm test` (173
files, 1199 passed, 4 skipped; the contract test now registers the
remote-access routes) and `pnpm check:scratch` pass. No new tests were added.

Follow-up (2026-10-23): users can set Local port beside HTTPS port in Settings,
with Apply persisting both. Clearing Local port selects and saves an available
port. Values outside 1–65535 are rejected. Environment port overrides were
removed in favor of the form. Remote-access settings follow the state database:
`dream.db` retains `remote-access.json` beside it; other databases use
`<database>.remote-access.json` and start with access off. Separate development
and installed databases therefore retain independent ports and Serve ownership
without another app data directory.

Validation: typecheck and targeted Biome checks pass. A temporary diagnostic
reproduced a port conflict, recovered with distinct saved ports, reopened the
manager with those ports, selected an automatic port, and verified that disabling
development access preserved the installed host's settings and Serve entry.
The actual form was inspected through an isolated browser fixture in both
themes; invalid values disable Apply and successful changes show the selected
ports. The temporary fixture was removed. No tests were written and no app or
development server was started. Live Tailscale reconfiguration remains untested.

Scratch checks, the real adapter over a scripted CLI with in-memory Serve
state:
- Every problem code from realistic CLI output.
- The exact serve command; enabling twice changes nothing; a second HTTPS
  port gets its own origin; `off` removes only Dream's entry; `reset` never
  runs.

The real manager on a real host, with a stand-in for Serve's proxy (public
host in `X-Forwarded-Host`, loopback target):
- not installed, signed out, HTTPS off and port taken: each distinct, none
  ready, the other service intact;
- ready on 8443 after the descriptor check, with Serve forwarding to the
  saved loopback port, the client page and API answering through it, and
  settings saved with `servedBy`;
- loopback port in use, then recovery to the saved port;
- an unreachable proxy origin never ready; an http origin refused; switching
  to the proxy mode removed Dream's Serve entry;
- off: listener unreachable, only Dream's entry removed, local API still
  answering, idle allowed again;
- restart: applied again on the same port and ready.

Two bugs found and fixed: `registerHostRoutes` referenced an undefined
`deps` (host startup would throw), and a busy port crashed the process.

The CLI against a real daemon: status, on (Tailscale and unreachable proxy,
exit 1 with the reason and link), pair without a verified address (no link,
code given), claims, devices, bad scopes (exit 2), off, `--json`, no daemon
(exit 3).

Live, read-only, on this machine: Tailscale 1.104.2 is signed in to a
tailnet with HTTPS certificates off. `status --json` had `CertDomains: null`
and `serve status --json` printed `{}`, matching the adapter, which reported
`https-disabled` with the admin link. No Serve configuration was changed.

macOS CLI follow-up (2026-10-25): the desktop reported `Tailscale.CLIError
error 3` despite an active connection. Without terminal environment variables,
the bundled executable did not return status JSON. With the adapter forcing
`TAILSCALE_BE_CLI=1`, both status and Serve status return valid JSON; this
machine now reports `Running` with HTTPS available. No Serve configuration
was changed. Native desktop retry still requires a host-process restart.

Not yet inspected:
- Settings > Remote access in the desktop app. The running dev session's
  main process predates these changes; restart `pnpm dev`.
- A real phone over the tailnet (including cellular), real Tailscale HTTPS,
  and streaming and WebSockets through Serve. These need HTTPS certificates
  enabled for the tailnet, which is the owner's decision.
- Linux operator permissions.

Deferred: the optional LAN listener. Without HTTPS a browser cannot keep the
`__Host-` session cookie, so it serves no phone browser yet; it belongs with
native clients (CONN-09) or LAN discovery (CONN-07).

Remaining/deferred: automatic LAN discovery and route preference are CONN-07;
public managed tunnels are CONN-08.

Removal (2026-10-28): the manual reverse-proxy mode (`origin`) is gone; the
requirement above to support manually supplied reverse-proxy endpoints is
withdrawn. Remote access is Tailscale Serve or a Cloudflare Tunnel (CONN-08),
whose externally managed connector still covers a connector the user runs.
- Settings no longer offers "Your HTTPS reverse proxy"; the enable route's
  schema and `RemoteAccessStatus["mode"]` accept only `tailscale` and
  `cloudflare`.
- `dream-host remote on --origin` is accepted only with `--cloudflare`.
- A settings file saved with `mode: "origin"` loads as Tailscale with access
  off. Starting the host therefore neither serves the old address nor creates
  a Tailscale Serve entry the user never chose.
- The daemon's low-level `--remote-origin` and `--trust-forwarded-host` flags
  (CONN-04's listener test hook) are unchanged.

Validation: `remote-access.test.js` covers the saved-mode migration and the
schema refusal; settings state tests pass with a Cloudflare status.

## CONN-06: Host lifecycle independent of the desktop

Status: all four implementation slices complete. Native macOS service updates,
recovery and desktop quit/reopen verified. Native Windows/Linux runtime-update,
login/reboot and live-provider walkthroughs remain unmet validation criteria.

Problem and trigger: local host work ends when Electron quits; the existing SSH
daemon is detached but is not an installed startup service.

Scope: extend `electron/host/daemon.js` with install/start/status/restart/uninstall
service operations and platform adapters. Target Windows, macOS and Linux with
their respective user startup mechanisms; document login/boot guarantees per
platform. Add explicit foreground, desktop-owned and service-owned modes.
Let desktop attach to the service host. Preserve host identity and catalog when
moving an existing desktop installation into service mode.

Resolve storage ownership before handoff: the desktop workspace and local host
currently share a database writer. Separate the client workspace database from
the host catalog through an offline, backed-up migration, then enforce one host
writer/process per data directory. Preserve provider environment, credentials
and CLI PATH when the service starts outside an interactive shell.

Completion criteria:

- Closing desktop leaves service-hosted turns and terminals running; reconnecting
  reaches the same identity and catalog. Uninstall keeps user data.
- A reboot/login starts the host according to the documented platform behavior;
  status gives the active version, port and useful failure/log information.
- Two launchers cannot create competing writers. Migration interruption is
  recoverable without duplicate catalogs or silently lost workspace settings.
- Service mode stays available while idle. Explicit restart/update reports
  interruption and preserves durable queue recovery rules.
- Update installs are staged, verified and recoverable; a failed startup can
  return to a compatible previous binary without reversing incompatible data
  migrations. Compatibility requirements are checked before replacement.

Validation: per-slice evidence below. The full install/attach/quit/restart/update/
uninstall walkthrough on each supported OS is not yet established.

Agreed scope: four slices, in dependency order.
1. Storage ownership (implemented below).
2. The service: `dream-host service install|start|stop|restart|status|uninstall`
   with Windows (Task Scheduler at logon), macOS (LaunchAgent) and Linux
   (`systemd --user`, linger documented for boot) adapters, PATH preserved.
3. Desktop modes: desktop-owned or service-owned, with the desktop attaching
   to a service host (an edge proxy for its SSH hosts and the browser relay).
4. Staged, verified, recoverable runtime updates.

Slice 4, agreed implementation scope (2026-10-26; implemented):
- `dream-host service update <version>` stages the published platform archive,
  verifies its SHA256 and runtime contract, and keeps the existing service's
  data paths and captured environment. Offline archives require an explicit
  SHA256. The previous runtime is retained outside SSH's version pruning.
- Check protocol, capabilities, platform and database migrations before stopping
  the service. Automatic replacement requires the same migration history, so
  rollback never reverses or guesses compatibility with schema changes.
- Journal the handoff before stopping. Verify readiness, database ownership and
  host identity after replacement; restore the previous compatible runtime on
  failure. Expose recovery for interrupted updates and serialize service writes.
- Validate with isolated runtimes/data and the available native service manager;
  preserve the no-new-tests and no-dev-server constraints. Record native or
  cross-platform walkthroughs that cannot be completed as unmet criteria.

Slice 3, agreed implementation scope (2026-10-21; implemented, native walkthrough pending):
- Explicit desktop-owned (default) and service-owned desktop startup modes.
  Service mode attaches only to the installed service for the configured home,
  verifies that it owns this desktop's state database and identity, and never
  falls back to creating another host.
- A desktop edge listener forwards home-host HTTP/streams and sockets while
  retaining desktop-owned SSH forwards and browser tool execution. It follows
  a restarted service only after checking the same identity again.
- Desktop unload and quit detach from service work; the renderer lends its
  browser to the service through the existing host socket relay. The workspace
  stays desktop-owned. Runtime updates remain slice 4.

Slice 1, storage ownership (implemented):
- `electron/workspace-database.js`: the desktop's workspace (`config`,
  `saved_prompts`, `workspace_projects`) lives in `<name>.workspace.db`
  beside the host's state database (`dream.workspace.db`, or
  `dev.workspace.db` under the development `DREAM_DB_PATH`). The same schema
  and migrations apply to both; each uses only its own tables. The
  workspace tables left in the state database are frozen, neither read nor
  written.
- The one-time move runs synchronously at desktop startup, before either
  writer opens a file:
  1. `VACUUM INTO` from a read-only connection makes
     `backups/<name>-before-workspace-split-<time>.db` (consistent, WAL
     included), migrated to the current schema and kept as one file.
  2. The three tables are copied from it into
     `<name>.workspace.db.partial`, with a
     `workspaceDatabase.migratedFrom` marker.
  3. The partial file is renamed into place.
  The state database is never written. An interruption leaves only the
  partial file, discarded and redone at the next start. If the move fails,
  the desktop logs it and keeps the previous arrangement (one shared queue
  on one file), so nothing is lost and it is tried again next time.
- Writers: the desktop's save queue now writes only the workspace (changes,
  config values, theme, install ID); the local host has its own writer for
  its catalog. `catalog.list` waits for the host writer's queue (a new
  `settled()` barrier), so a reloaded window's catalog read still sees
  every catalog write queued before it.
- `electron/host/state-lock.js`: one host per state database.
  `createHost` takes `<state db>.host-lock` (exclusive create; pid, kind,
  start time) and releases it on close. A live holder makes a second host
  throw `StateLockedError`, naming the holder; a dead holder's lock is taken
  over. The desktop names itself `desktop`.

Validation, slice 1 (2026-10-21): `pnpm typecheck`, `pnpm lint`, `pnpm test`
(173 files, 1199 passed, 4 skipped) and `pnpm check:scratch` pass. One full
run failed `host-proxy-routes.test.js` with the "bad port" fetch error last
seen in CONN-01; it passed three runs in isolation and the next full run. No
new tests were added.

Scratch checks on read-only `VACUUM INTO` snapshots of this machine's real
`dev.db` (40 MB) and `dream.db` (320 MB):
- An interrupted move's partial file was discarded and the move completed
  (0.3 s and 1.7 s).
- The state database was byte-identical afterwards.
- A single-file backup existed and kept the catalog (27 and 296 chats).
- Every workspace row moved: `config` 36 and 34 (plus the marker),
  `saved_prompts` 1 and 1, `workspace_projects` 36 and 62.
- The workspace loaded identically from its new file, which holds no
  catalog rows.
- A second start changed nothing.
- A second holder of the lock was refused; a dead holder's lock was taken
  over.

The desktop's arrangement on the migrated `dev.db` copy:
- the host listed the real catalog (32 projects, 27 chats) and the workspace
  loaded 36 rows;
- a catalog list issued right after an unawaited write saw it;
- both writers committed concurrently;
- a second host started in another process was refused with
  `StateLockedError`, and allowed once the first closed.

Not yet inspected: the desktop app itself performing the move on its real
data at its next start (the running dev session predates this).

Known consequence: an SSH host's daemons of different protocol versions
share one data directory, so a newer one now waits for the older to stop
rather than writing beside it. No protocol change exists yet; slice 4's
update path must stop the older daemon first.

Slice 2, the service (implemented):
- `electron/host/service/service.js`: one manager, three adapters, all
  running the host's own `serve` in the foreground with idle shutdown off,
  so the service manager supervises the real process:
  - Linux: `systemd --user` unit (`~/.config/systemd/user/<name>.service`,
    `Restart=on-failure`, log appended to `<home>/logs/service.log`). It
    starts at login, or at boot with `loginctl enable-linger`, and status
    says which.
  - macOS: LaunchAgent (`~/Library/LaunchAgents/ai.dreamdream.<name>.plist`,
    `RunAtLoad`, restarted after an unsuccessful exit), loaded with
    `launchctl bootstrap gui/<uid>`; starts at login.
  - Windows: Task Scheduler logon task for this user (interactive,
    least privilege, no time limit, restart on failure every minute). Its
    action is `wscript` running `<home>/service.vbs`, which sets the
    captured environment and runs the host hidden, appending to the log
    and returning its exit code. Starts at login.
  - The environment keeps the installing shell's PATH (SSH session
    variables dropped as for daemons), `ELECTRON_RUN_AS_NODE` when present,
    and only the variables named with `--env`, whose values the definition
    stores (owner-only).
  - `<home>/service.json` records which service runs a home's host.
- `electron/host/service-cli.js`: `dream-host service install|start|stop|
  restart|status|uninstall [--data-dir] [--env NAME]... [--service-name]
  [--json]`.
  - `install` replaces a running `ensure` daemon of the same home.
  - `stop` ends the service before stopping the host, so a deliberate stop
    is not restarted.
  - `restart` reports that running turns are marked interrupted (the
    queue's existing rule: review, then retry explicitly).
  - `status` combines the manager's state (with Task Scheduler's result
    codes named), when it starts, the running host's version, pid, port
    and start time, and the log's last lines when the host is down.
  - `uninstall` removes only the definition; data, identity and records
    stay.
- `ensure` starts an installed service for its home instead of spawning a
  second host.
- `POST /api/host/shutdown` (local listener only, launch token; listed in
  `LOCAL_ONLY_ROUTES`) lets `dream-host stop` close a daemon cleanly,
  flushing its writes and releasing its state lock. It falls back to a
  signal, which on Windows ends the process at once.

Validation, slice 2 (2026-10-21): `pnpm typecheck`, `pnpm lint`, `pnpm test`
(173 files, 1199 passed, 4 skipped) and `pnpm check:scratch` pass. One full
run failed the `run-scheduler.test.js` timing test seen in CONN-02; the
next full run passed. No new tests were added.

Generated definitions for all three platforms, from the real adapters with a
recording runner (20 checks):
- the `serve` arguments, PATH captured, and secrets left out unless named;
- unit, plist, launcher and task XML contents;
- the install command sequences.

Windows, a real logon task (`Dream host (dream-host-test)`) running the real
host from this checkout:
- install: running, version 0.29.0 on its port;
- `ensure` reused it, and later started the stopped service through
  `service.json`;
- restart: a new process;
- a deliberate stop was not restarted after 70 s;
- uninstall: the task deleted, data, logs, runs and identity kept;
- `stop` closed cleanly (`clean: true`, no lock left).

Linux, real `systemd --user` in WSL Ubuntu (systemd 249, Node 22.14), with
a stub standing in for the host (its node-pty is built for Windows here):
- `systemd-analyze --user verify` accepted the unit;
- enabled and running, with its arguments and captured PATH;
- stop delivered SIGTERM; start and restart worked;
- a SIGKILL was restarted by `Restart=on-failure`;
- uninstall removed the unit and kept the home;
- status reported login start, since lingering is off.

Found and fixed during these checks:
- `schtasks /End` ends the launcher but not the host beneath it, so `stop`
  also stops the host through its record.
- `ensure` must start the service installed for its home, hence
  `service.json`.
- A hard kill on Windows lost queued writes and left the lock, hence the
  shutdown route.

Not yet inspected:
- macOS: the plist and `launchctl` sequence were checked only as generated.
- Whether the Windows launcher shows no console window, and the task
  starting at an actual login or reboot.
- The real host as a Linux service, which needs a Linux runtime build.

Remaining/deferred: sleeping hardware is unreachable; wake-on-LAN is not included.

Slice 3, desktop attachment (implemented):
- `DREAM_HOST_MODE=desktop` (the default) retains the in-process host.
  `DREAM_HOST_MODE=service` uses `electron/desktop-host.js`, with the installed
  service in `DREAM_HOST_HOME` (default `~/.dream/host`). It starts a stopped
  service through its manager, waits for readiness, then checks protocol and
  terminal-discovery support, the PID holding this desktop's database lock,
  and the existing host ID, public key and fingerprint. A missing service,
  mismatched database or different identity fails startup with instructions;
  it never creates a replacement host or falls back to the shared writer.
- The desktop edge listener owns its own token and loopback port. Shared
  proxy code forwards home-host HTTP, streams and sockets, with the service's
  token kept in the main process. It rereads the run record and verifies a
  changed endpoint before using it after restart. Proxies do not follow
  redirects; daemon probes reject them. SSH routes still reach desktop-owned
  forwards, and browser tool calls execute in the desktop. Host-side browser
  MCP calls use the existing socket relay, now also announced for the home host.
- Main-process unload cleanup owns no service processes, and the preload's
  `hostMode` prevents the renderer's unload stop-all in service mode. Quitting
  closes the edge and SSH forwards, not the service or its provider processes.
  The workspace writer still belongs to the desktop. Stopping the shared host
  remains an explicit `dream-host service stop` operation.
- The terminal socket's additive `discover` message returns running sessions
  and retained output. A hydrated service desktop restores terminal tabs for
  known local projects without starting another shell; runner sessions restore
  their output/status too. Discovered sessions acquire reconnect cursors even
  before their first output. The `terminal-discovery` capability prevents an
  older service silently skipping this recovery. Terminal names are assigned
  locally on attachment; prior client-only names are not synchronized.

Operator setup (no automatic change to an existing desktop installation):
1. Quit desktop before moving its host into the service. Use the same desktop
   userData directory (macOS: `~/Library/Application Support/dreamide`, Windows:
   `%APPDATA%/dreamide`, Linux: `~/.config/dreamide`) for `--data-dir`:
   `pnpm host service install --data-dir "<desktop userData>"`.
2. If the desktop uses `DREAM_DB_PATH`, set it to an absolute path in the
   installing shell and add `--env DREAM_DB_PATH` to the install command. The
   service and desktop must resolve the same database. Preserve other needed
   provider environment variables with their own `--env NAME` options.
3. Launch desktop with `DREAM_HOST_MODE=service`, and the same `DREAM_HOST_HOME`
   if a custom home was supplied to service installation. Switching back to
   desktop-owned mode requires stopping the service first; the state lock
   refuses competing host writers. No dev server was started for this work.

Validation, slice 3 (2026-10-22): `pnpm check` passed (173 files, 1203 tests).
Existing preload and daemon capability expectations were updated; no tests
were added. Scratch programs outside the checkout exercised:
- A real isolated daemon, a real desktop edge, and a recording service manager
  that launches that daemon (no OS service was installed): starting a stopped
  host, catalog reads, missing-token refusal, unknown SSH routes, and refusal
  to stop the shared service through the desktop edge.
- A live terminal surviving edge detach, discovery from a fresh edge/socket,
  the same host identity on reattach, service restart recovery, temporary
  unavailability, and refusal of a changed identity after restart.
- SSH token translation and incremental stream delivery through a controlled
  upstream; redirects were returned without being followed.
- Host-side browser MCP through the host socket, desktop browser execution
  and the returned tool result (a stub bridge stood in for webview operations).
- Terminal restoration: local project matching, output retention, repeated
  restoration, runner sessions, and refusal to adopt SSH/unknown projects.

At the slice-3 checkpoint, native Electron attach/quit/reopen and platform service
handoff were not inspected. The slice-4 macOS walkthrough below now covers native
attachment and terminal survival. Real provider turns, real webviews and SSH
machines, and native Windows/Linux desktop handoff remain unverified.

Slice 4, runtime updates (implemented, 2026-10-26):
- `runtime-contract.js` adds platform, architecture, protocol, capabilities,
  storage-format version and exact migration hashes to `dream-host version`.
  The storage-format version must change for incompatible persisted JSON,
  queue or provider-session semantics, even without a SQL change.
- `service/runtime.js` stages the official release archive plus SHA256SUMS, or
  an offline archive with explicit SHA256; checks a private archive copy;
  rejects traversal, links and special files; and runs the candidate contract.
  Packaged installation retains its runtime immediately. Update candidates and
  previous runtimes live under `service-runtimes`, outside SSH version pruning.
- `service/update.js` preserves the installed launch environment and absolute
  data paths. It checks compatibility before shutdown, journals the handoff,
  suspends service-manager restarts, and waits for the old database owner to
  exit. Readiness requires the expected version and identity, the database lock,
  successful catalog reads, matching migrations and a stable process.
- Failed startup restores the retained previous runtime only after rechecking
  its contract, identity and database migrations. Database contents are never
  rolled back. Schema/protocol/storage-format changes that cannot safely return
  to the previous binary are refused before stopping the host.
- `service update <version> [--archive file --sha256 hex]` and `service recover`
  expose the operation. Status shows pending recovery, the last outcome and
  runtime location without captured environment values. Private atomic records
  survive interruption. A PID-owned operation lock serializes service commands
  and automatic client starts; stale owners can be recovered.
- `service.json` now keeps the installed launch settings. Earlier installations
  without those settings need one reinstall using the same data directory and
  explicit environment options. Checkout-based installs remain supported but
  need a packaged runtime before automatic updates. See
  [the operator guide](../../host-service.md).
- Release packaging now includes Windows x64 host archives. The existing
  runtime smoke workflow uses the shipped Node on every platform and verifies
  the update contract, catalog access and native terminal startup.

Validation, slice 4 (2026-10-26):
- `pnpm check`: scratch hygiene, lint, typecheck and 1,244 tests across 181 files
  passed. `pnpm vite:build` passed with the existing large-chunk warning.
  The complete macOS arm64 runtime and archive built successfully. No tests
  were added to the repository; diagnostics stayed in the allocated scratch
  directory outside the checkout.
- A real, isolated macOS LaunchAgent exercised installation, verified update,
  checksum rejection and incompatible-migration rejection before shutdown,
  failed-startup rollback, interrupted handoff followed by CLI recovery,
  refusal to roll back an incompatible database, and concurrent mutation refusal.
  The host retained its identity and catalog through update and recovery.
- A final packaged-runtime check upgraded a fixture version from 0.30.0 to
  0.30.1, preserved a custom database path and captured environment despite
  different values in the updating shell, verified credential-free status,
  and uninstalled while retaining data and identity. These versioned fixtures
  were local archives, not published releases.
- An isolated native Electron production renderer loaded in service mode,
  quit, reopened and quit again. The same service PID and identity remained;
  its native PTY terminal remained running and discoverable after both quits.
  The temporary desktop service was uninstalled and its data retained. The
  user's development app was not restarted and no dev server was started.
- Platform-adapter diagnostics cover generated Linux and Windows replacement
  commands; these do not establish native runtime-update behavior on those OSes.

Remaining validation: native Windows/Linux updates and recovery, actual OS
login/reboot, desktop handoff with real provider turns/webviews/SSH, and release
download against a published archive containing the new contract. These are
unmet criteria, not inferred passes from macOS or fake service-manager output.

## CONN-07: Multiple routes and unified connection management

Status: implemented; all three slices complete. Live SSH/network and
cross-platform validation remains as listed below.

Finish scope (2026-10-26): implement both remaining slices, including a single
host list, ordered route editing/removal, authenticated duplicate merging,
HTTPS link pairing with encrypted desktop credentials, proof on each new TLS
connection before attaching credentials, mixed-route recovery, and
`DREAM_HOST_MODE=remote` without a local execution host. Keep existing workspace
ownership and do not add repository tests. Record unavailable physical-network
and platform walkthroughs separately from automated validation.

Problem and trigger: one host should remain the same host when a client changes
network or switches between SSH, Tailscale, LAN and managed access.

Scope: extend the shared supervisor with ordered routes, bounded attempts,
backoff and cancellation. Move desktop SSH forwarding behind its platform
adapter, reusing `electron/ssh/` installation, prompts and reconnection code.
Keep process ownership separate from connection ownership.

Implementation slices (2026-10-26; the original completion criteria below remain
the full scope):
1. Shared ordered-route supervisor, bounded attempts, cancellation, cooldowns,
   verified preferred-route replacement, and desktop SSH transport adapter.
   Preserve legacy single-route connections and the existing SSH prompts,
   runtime installation and port forwards. Expose route status through the
   existing bridge; do not replay writes during route replacement.
2. Verified route merging and editing in one Connections UI, with existing
   workspace/project ownership retained when routes are added or removed.
3. Direct HTTPS desktop pairing, private device credentials and nonce-bound
   host-key proof before credentials are attached; route loss/recovery across
   transport kinds and a desktop with no local execution host.

All three slices are implemented. Stored metadata alone never authorizes a new
credential destination: each HTTPS route references a private device credential
bound to that host and origin.

Completion criteria:

- A host has one entry with editable routes, current route and useful failure
  reasons. Adding the same authenticated host merges its routes.
- Failure advances to another compatible route; a healthy fallback is replaced
  only after a preferred route passes authorization and readiness checks.
  Cooldowns prevent repeated switching between unstable routes.
- Wrong-host descriptors receive no credentials. Identity verification and TLS
  policy prevent trusting a copied descriptor as proof; learned endpoints cannot
  downgrade HTTPS credentials onto an insecure route.
- Changing Wi-Fi/cellular, losing a VPN and restoring SSH preserve drafts and
  host state. Protocol incompatibility and revoked grants are not endless retries.
- Removing an SSH route stops its forward, without stopping a shared service.
  Desktop can run with only remote hosts and no local execution host.

Slice 1 implementation (2026-10-26):
- `electron/shared/route-supervisor.js` selects a verified ready handle from
  ordered routes. Attempts time out after five minutes, transient failures use
  capped, jittered 2-60 second backoff, and a healthy fallback keeps serving
  during a preferred probe after a 30-second cooldown. Late attempts cannot
  publish after replacement or cancellation. Fatal routes remain blocked until
  explicit reconnection, which waits for any running recovery and then retries
  every route; cancelling an SSH prompt ends the whole connect operation.
- `electron/connections/desktop-connections.js` adapts the existing SSH manager
  to that supervisor. SSH authenticates and checks the saved identity before
  catalog readiness; mismatched catalogs and incompatible protocols are refused.
  Only probes made while another route serves are silent: BatchMode, strict
  host-key checking and an askpass helper without its secret. Recovering a
  connection with no serving route may prompt, as single-route reconnects did.
  Short per-connection ControlMaster names (16 hex characters, within socket
  path limits) prevent two aliases for one machine from borrowing or closing
  each other's master. Concurrent forwards of one port share one SSH forward.
- Main now routes host proxies through that adapter. A bounded optional
  `sshRoutes` bridge payload supplies ordered routes; legacy payloads remain
  valid. Saved SSH routes are resolved against Settings by the store. Route
  status contains ids, errors and retry times, never launch credentials.
- Local TCP relays keep forwarded site URLs stable across route replacement.
  A route switch closes old connections; new traffic uses the selected route.
  Disconnect kills pending SSH work and forwards, leaving the daemon running.
- Route changes invalidate renderer sockets/catalog reads before chat observers
  reattach through Connection recovery. No request writes are resubmitted.

Validation, slice 1 (2026-10-26): `pnpm check` passed scratch hygiene, lint,
typecheck and 1,256 tests across 184 files. `pnpm vite:build` passed with the
existing large-chunk warning. No tests were added to the repository.
- Scratch diagnostics outside the checkout exercised ordered fallback,
  cooldowns, delayed preferred readiness, dropped routes, copied ids with wrong
  keys, terminal refusal, prompt cancellation, timeouts, late completion after
  disconnect and a replacement attempt, upgrading a legacy pin with its first
  verified key before fallback, and credential-free route status.
- The desktop adapter preserved one local forwarded URL across fallback →
  preferred → fallback using real HTTP/TCP traffic and controlled transports.
- The production SSH manager connected to a real isolated daemon through the
  existing scripted SSH stand-in and real TCP forwards. Losing the preferred
  forward switched routes, retained host identity and the forwarded site's URL,
  and left the daemon running after disconnect. The isolated daemon was stopped
  explicitly at diagnostic cleanup.
- A separate diagnostic checked distinct ControlMaster paths for two routes
  to the same target and for two independent managers.
- An askpass diagnostic kept a foreground password prompt pending while a
  background probe ran; the prompt stayed assigned to the foreground host,
  and declining it cancelled that host's attempt.

Slices 2-3 implementation (2026-10-26):
- Connections groups verified SSH and HTTPS routes by persistent host, shows
  their preference, active route and failures, and supports adding, editing,
  reordering and removing routes. Authenticated duplicate additions merge before
  catalog application. Workspace document operations preserve project/chat IDs,
  tabs and drafts. Route removal updates the running supervisor and closes only
  removed transports. A local home host retains its local route.
- Direct pairing exchanges HTTPS fragment links in main and stores device
  grants with OS-backed safeStorage encryption outside workspace exports.
  Credentials are pinned to both installation key and origin; plaintext Linux
  storage is refused. `/api/remote/proof` signs a fresh nonce, audience and host
  identity. The HTTPS adapter verifies that proof on every newly opened TLS
  socket before handing the same socket to HTTP or WebSocket requests. TLS
  certificate validation, bounded proof framing and redirect refusal remain
  mandatory. The proxy does not forward browser cookies or the local launch token
  to HTTPS routes. Authorization failures block routes; polling renews sessions
  and detects idle route loss. No write is automatically replayed.
- `DREAM_HOST_MODE=remote` runs the desktop workspace and edge without creating
  a local execution host. Home catalog loads/watchers and local remote-access
  controls are omitted. Saved remote snapshots survive hydration. Authenticated
  former home hosts can become remote connections without changing project IDs.
  See [Desktop connections](../../desktop-connections.md).

Validation, slices 2-3 (2026-10-26):
- `pnpm check` passed scratch hygiene, lint, typecheck and all 1,256 tests
  across 184 files. `pnpm vite:build` passed with the existing large-chunk
  warning. Existing bridge/action/recovery fixtures were updated; no new
  repository tests were added.
- Scratch HTTPS diagnostics used real TLS traffic to check proof on the same
  socket, re-verification on new sockets, copied-key and nonce refusal, pinned
  known-host refusal before pairing, HTTPS downgrade refusal, readiness and fatal
  grant revocation. A controlled mixed SSH/HTTPS supervisor check retained the
  healthy fallback during preferred readiness, switched only after success, and
  detached a removed SSH route without changing the pinned host.
- A real isolated host paired through an HTTPS reverse proxy and a remote-only
  desktop edge. Catalogs and session-bound socket tickets worked; revoking the
  grant closed the live socket and blocked the route. Disconnect left the host
  running. The edge refused local execution API requests.
- An isolated native Electron production renderer booted in remote-only mode
  without a host database lock, paired through the real IPC and OS encrypted
  credential store, opened a remote project, and re-paired the same origin while
  retaining its connection/project/chat IDs. Automatic HTTPS route failover
  retained the composer draft; route reordering/removal retained the project,
  and a previously local identity became a remote connection after pairing.
  Fresh workspace startup also exposed and fixed a missing crypto import for
  install IDs in Electron. Connection and pairing UI inspected in native
  screenshots; local remote-access controls are hidden in remote-only mode.

Remaining validation: live remote SSH with real VPN/Wi-Fi/cellular changes,
live-provider turn recovery, native Windows/Linux secure stores, and a real
Tailscale Serve pairing walkthrough. Controlled TLS/transport checks do not
establish those physical-network or platform results. No dev server was started
and the user's existing app was not restarted.

Remaining/deferred: the managed route provider arrives in CONN-08.

## CONN-08: Cloudflare Tunnel integration

Status: implemented; validation pending. The first and third completion
criteria (a real Cloudflare hostname end to end; recovery through that edge)
and native Windows/Linux operation are unmet, so the task is not complete.
Scope revised 2026-10-26.

Implementation scope: complete the user-owned token/hostname integration,
private connector runtime installation/detection, host-owned process lifecycle,
bounded recovery, external-connector mode, desktop controls and headless CLI.
Reuse the existing HTTPS identity/session and remote listener boundaries. Mobile,
push and Dream-operated account/discovery infrastructure remain out of scope.
No new repository tests or dev server; validate new scenarios in scratch programs
and record real-tunnel/platform checks that cannot run separately.

Problem and trigger: reach the host from the existing desktop or browser client
without requiring both devices to join a VPN. A Dream-operated account,
discovery or authorization service is outside this effort.

Scope: integrate a persistent Cloudflare Tunnel with the existing remote-access
owner and HTTPS route/session contracts. The initial setup uses a user-owned
Cloudflare account, configured tunnel token and stable public hostname. Manage
the local `cloudflared` connector alongside the host service, with private
credential storage, setup/status controls and headless recovery commands.
Retain support for an externally managed connector without taking ownership of
its process or deleting its tunnel.

Expose only the remote-facing listener, with its existing pairing, host-key
proof, device sessions, scopes and revocation. Cloudflare supplies reachability;
the Dream host continues to authorize devices. A tunnel becomes an ordinary
HTTPS route in CONN-07, rather than another host or execution model. Keep QR
optional and reuse one-time links/device approval for initial authorization;
normal reconnection does not need another pairing.

Completion criteria:

- A configured stable hostname reaches the same host/catalog from the desktop
  and browser clients on a network without Tailscale. Streaming chat, socket
  channels, approvals, files and terminals work through the real tunnel.
- Connector installation/detection, private token storage, start/stop, health,
  bounded restart/backoff and useful errors work in the UI and headless service.
  A desktop window is not required to keep the service's tunnel running.
- Tunnel loss, host restart and sleep/resume recover through the existing
  connection runtime without losing drafts or replaying writes.
- Device authorization, identity proof, HTTPS requirements and revocation remain
  enforced. The local launch token and local-only routes are never exposed.
- Disabling tunnel exposure stops only a connector Dream owns. It preserves host
  data, device records and other SSH/Tailscale/direct routes. An externally
  managed connector is left running, with instructions to disable it separately.
- Validate proxy Host/Origin handling, cache behavior, SSE and WebSocket
  continuity, and token rotation against the configured Cloudflare hostname.
  Quick Tunnels are not the supported production route.

Implementation (2026-10-26):
- `host/remote-access/cloudflared-runtime.js` detects a supported installed
  binary or downloads the official OS/CPU release, checks the release SHA256
  digest and executable version, and atomically publishes a private runtime.
  It rejects unexpected assets/archive entries and preserves the prior runtime
  on failure. Installation/update is explicit, including in headless mode.
- `host/remote-access/cloudflare.js` owns the connector, its private token file,
  loopback readiness checks, bounded restart/backoff and token rotation. Tokens
  use `--token-file`, never process arguments, environment, settings or status.
  Raw connector logs remain inside the owner; errors exposed to users are
  sanitized. The bundled Node watchdog reaps its connector if the host dies.
- Remote access adds a Cloudflare mode with a stable public origin and optional
  external connector ownership. Managed readiness requires both a healthy
  connector and a fresh signed host-key proof through HTTPS. Background checks
  belong to the host and continue without an open desktop or Settings view.
  Rechecking a healthy configuration keeps its listener and observers alive.
- Settings > Connections adds hostname/token configuration, explicit runtime
  installation/update, managed/external controls, status and setup guidance.
  Token drafts clear after saving. The local-only management API never
  registers on the remote listener. Existing device pairing, scopes, encrypted
  desktop credentials, route recovery and revocation continue unchanged.
- Headless commands add `remote install-cloudflared`, `remote on --cloudflare
  --origin ... --token-file ...`, `--external`, and `remote restart`.
  Disabling closes the listener and only the owned child; saved host, device
  and credential data remain. See [setup and operations](../../cloudflare-tunnel.md).

Validation (2026-10-26):
- `pnpm check` passed scratch hygiene, lint, typecheck and all 1,259 tests
  across 184 files. `pnpm vite:build` passed with the existing chunk-size
  warning. The complete macOS arm64 host runtime built with the connector
  watchdog. No repository tests or dev server were added/started.
- Scratch diagnostics downloaded, checksum-verified and executed the official
  cloudflared 2026.10.4 macOS arm64 release. A real invalid-token invocation
  produced only a sanitized failure in Dream status. Private token mode 0600,
  process arguments, environment/status boundaries, rotation, child crash
  recovery, disable and parent SIGKILL cleanup passed with real child processes.
  Controlled clock/process checks passed exponential retry limits, explicit
  recovery, unhealthy-child replacement, cancelling pending restart and runtime
  update replacement. Mocked release adapters verified Windows/Linux asset
  selection and checksum rejection preserving the prior runtime; these are
  not native-platform execution results.
- A real host behind an isolated HTTPS reverse proxy passed signed public
  readiness, device pairing/catalog, streaming and observer detach/replay,
  native PTY start/stop, file API access, session-bound WebSocket revocation,
  local-only API refusal and secret-free settings/status. External mode stopped
  only the owned connector, left the external proxy running, and retained
  identity/token/configuration through a full host restart. The connector was
  a controlled stand-in; the proxy was not Cloudflare's edge.
- An isolated native production Electron window passed the installer UI,
  password field/empty-token guard, Quick Tunnel refusal with its unsaved token
  draft preserved, token save/draft clearing, sanitized
  rejected-token error, external controls and disable. Light and dark screenshots
  were inspected. The user's app and data were not restarted or changed.
- The final packaged runtime ran as a real isolated macOS LaunchAgent without
  a desktop window. It detected the verified official runtime, reported the
  invalid token without secrets, restarted with the same host identity and saved
  token/configuration, and switched to external ownership before disabling.
  The temporary service was uninstalled afterward; no diagnostic host or
  connector process remains running.

Review fixes (2026-10-26):
- Recovery no longer ends in a permanent failure. Exits and unhealthy
  connectors are replaced with exponential backoff capped at one minute, and
  retries continue while the tunnel is on. Only a rejected or missing token or
  a missing runtime stops retries until the operator acts. A connector is
  replaced after two minutes unhealthy since it started or was last connected,
  so a long-running connector is not killed on its first failed poll.
- The background check runs only for a started Cloudflare listener, so a
  failed apply (a busy port, for example) keeps its own problem.
- The host detects an installed cloudflared at startup, so Settings no longer
  offers to install a copy already on PATH.
- A successful runtime install removes earlier private runtimes; a failed one
  removes its stage. The managed binary's digest is cached by size and mtime.
- `remote restart` restarts the managed connector
  (`/api/remote/access/cloudflare/restart`); it no longer aliases check.
  A new Cloudflare route prefers loopback port 5410 when free (host-owned;
  status reports it). A runtime download no longer blocks other Settings
  controls. Labels no longer name the product; status no longer reports the
  watchdog's pid.
- Validation: lint, typecheck and all 1,259 tests passed. A scratch program
  with a controlled clock and fake child processes passed unbounded capped
  retries over 13 exits, no kill on the first failed poll after five minutes
  connected, replacement after two minutes unhealthy, token-rejection blocking
  and unblocking by a new token, restart, missing-token blocking, a busy-port
  problem surviving the monitor, runtime stage cleanup on update and failure,
  the cached digest path and the minimum version boundary. The Settings change
  was not inspected in a running window.

Remaining validation: an isolated user-owned Cloudflare tunnel/hostname was not
configured in this session. Real edge Host/Origin/cache behavior, browser and
desktop pairing, streaming/socket continuity, approvals/live-provider work,
token rotation and sleep/network recovery through that edge remain unverified.
Native Windows/Linux connector installation/service operation and OS
login/reboot also remain unverified. These are unmet walkthrough criteria,
not inferred passes from a controlled HTTPS proxy or macOS execution.

Out of scope: Dream accounts, host discovery/registry, a cloud authorization
broker, centrally provisioned tunnel fleets, cloud billing/quotas, native mobile
applications and mobile push. Automated Cloudflare account/DNS provisioning can
be considered separately from the initial token-and-hostname integration.

Implementation references: [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/),
[tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/),
and [Quick Tunnel limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations).
A stable tunnel is required: Quick Tunnels change hostname and do not support
SSE. Provider behavior and current token-file/runtime parameters were checked
against the official documentation during implementation.

## CONN-09: Native mobile project (outside this effort)

Status: deferred to a separate, unscheduled project; not a remaining connection
implementation item.

A native app is a substantial new product/client project. It needs its own
project setup, platform and framework evaluation, UX and feature scope, secure
storage and lifecycle integration, testing on physical devices, signing,
distribution and release plan. No framework, repository location, delivery
estimate or implementation commitment is selected by this connection plan.

The future project can reuse the host API, identity, device sessions and HTTPS
routes delivered here. Those reusable contracts do not make mobile a small
follow-up or part of CONN-08 acceptance. Retain this ID only for references from
earlier plans; create the mobile project's own specification before starting it.

## CONN-10: Mobile push (outside this effort)

Status: deferred with the separate mobile project; not a remaining connection
implementation item.

Decide notification scope, background delivery, platform push services and any
required sender/relay infrastructure within that project. No push service or
native notification delivery is required to finish Cloudflare Tunnel support,
and there is no dependency on the removed Dream Connect service.

## CONN-11: Host browser and remote control

Status: proposed as an independent future project; not required to finish
connection support through CONN-08.

Problem and trigger: Dream currently lends the desktop window's browser to a
remote host. Phone-only agents need a browser owned by the execution host.

Scope: add a host-owned Chromium service with persistent tab identities,
per-project storage, agent automation and streamed viewing/input. Adapt
`electron/browser-sessions.js`, `electron/api/browser-bridge.js`, browser tools
and `host-browser-watch.ts` behind one browser service contract. Move remote
execution to the host and retain desktop rendering as an adapter where useful.
Select frame transport after measuring a thin end-to-end implementation; do not
couple the API contract to that first transport.

Completion criteria:

- An agent can browse with no desktop client connected; `localhost` resolves on
  the project's host. Reconnecting clients see the same live tabs.
- Desktop, browser and native clients can view and take/release control without
  racing agent input. Viewing and control enforce separate permissions.
- Navigation, resizing, clipboard, uploads, downloads, popups and disconnect
  recovery work. Remote pages cannot access Dream auth through a shared origin.
- Chromium installation, sandbox prerequisites, process cleanup and resource
  limits are managed on supported hosts. A failed browser does not kill chat work.
- Record input latency, bandwidth and CPU for phone and desktop over representative
  links; set explicit acceptance budgets before final transport selection.

Validation: pending; exercise a host-local development site, an upload/download,
an agent/client control handoff and reconnect on all three client surfaces.

Remaining/deferred: audio and picture-in-picture are follow-up items if required
for exact browser UX parity; this task covers shared browsing and control.

## Validation and release discipline

Each candidate starts with its recorded scope and finishes with evidence beside
that candidate. Run relevant existing checks, typecheck and lint for code
changes. Do not write new tests unless requested, and do not start a dev server.
Use the existing development instance for UI work. Device, service and cloud
checks that cannot run must remain explicit unmet criteria, not assumed passes.

The largest uncertainty in milestone 1 is removing desktop assumptions from
every request and persistence path. The largest later migrations are shared
database ownership in CONN-06 and browser ownership in the independent CONN-11
project. CONN-08 adds a local Cloudflare connector integration, not a
Dream-operated service. Native mobile and push require a separate project and
estimate; they are excluded from this effort's scope and schedule.

First implementation slice: CONN-01, followed by CONN-02. Establish identity and
authorization while the application remains desktop-compatible, then use those
contracts for the browser client. Keep each candidate independently reviewable.

Recovery: `docs/architecture/tasks/remote-connections.md`. CONN-01 to
CONN-05 implemented (desktop walkthrough, real phones, real Tailscale HTTPS
pending). CONN-06's four slices implemented; macOS service/update/recovery and
native desktop quit/reopen checked. Cross-platform, reboot/login and live-provider
validation remains as listed above. CONN-07's three slices are implemented;
remaining validation is recorded beside the task. Remaining implementation in
this effort is CONN-08 Cloudflare Tunnel integration. CONN-09/10 belong to a
separate, unscheduled mobile project; CONN-11 is an independent future project. Preserve
the user's no-new-tests and no-dev-server constraints; commits and pushes
require explicit confirmation.
