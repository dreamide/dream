# Desktop connections

In Settings > Connections, choose **Add host**, then **SSH host**, or **Pairing link** and paste
a complete HTTPS pairing link created in the host's Remote access settings.
The link is single-use. The host must run a version with native identity proof
support, and its HTTPS certificate must be trusted by the desktop's Node runtime.
Tailscale Serve's HTTPS origin works as a direct route; no Dream account is needed.

Each verified host has one entry. Adding another route to the same authenticated
host merges it into that entry and keeps the existing project, chat and workspace
IDs. Edit that entry and use **Add SSH route** or **Add HTTPS route** to pin the new
route to that host before pairing or loading its catalog. SSH routes can be edited;
editing an HTTPS route requires a fresh pairing link. Re-pairing the same origin
replaces its old desktop credential. A new origin gets its own device grant.

Routes are tried from top to bottom. In the entry's edit dialog, arrow buttons
change their preference.
The current route and failures appear beside each route. A healthy fallback
continues serving while a preferred route proves identity, authorization and
catalog readiness. Transient failures back off; revoked grants and incompatible
hosts stay blocked until explicit reconnection or pairing. Route changes recover
catalogs and turn observers without resubmitting writes.

Remove a route with its trash button; at least one route must remain. Removing
an SSH route closes its forward and leaves the host service running. Removing
the whole connection removes its projects from this workspace using the existing
host-removal behavior. It does not delete the host's catalog. Local home hosts
always use their local route while this desktop hosts or attaches to them;
additional verified routes can be inspected, edited and removed on that entry.

Device credentials stay in the main process, encrypted by Electron safeStorage
in a private file beside the desktop's workspace database. They are not in
workspace exports or renderer state. macOS Keychain, Windows DPAPI, or a secure
Linux credential backend must be available; Linux's plaintext fallback is refused.
An imported workspace needs pairing again on a desktop without those credentials.
Every new TLS connection must pass a fresh, signed nonce proof before a pairing
secret or saved grant is sent on that same socket. Redirects and HTTP downgrade
are refused. Revocation on the host closes the device's live observers.

## WSL hosts

On Windows, a WSL distribution can be added as a host: choose **Add host**,
then **SSH host**, and enter `wsl:<distribution>` as the target (the dialog
suggests the installed distributions). Dream installs the host runtime inside
the distribution and starts it there with `wsl.exe` instead of `ssh`. Projects,
terminals and agents then run in Linux.

WSL makes the distribution's loopback ports reachable from Windows
(`localhostForwarding`, on by default, or `networkingMode=mirrored` in
`.wslconfig`); Dream needs that and reports it when the host does not answer.
WSL stops a distribution once nothing holds it, so the host keeps running only
while Dream is connected to it, or while something else keeps the distribution
running. Code editors with a WSL remote (VS Code, Cursor, Windsurf) open the
project through it; others open it as `\\wsl.localhost\<distribution>\...`.

## Remote-only desktop

Turn on **Remote hosts only** under Settings > Connections > This computer, and
restart when asked. The desktop keeps local workspace storage and the desktop
UI/proxy, but starts no local execution host, scheduler, terminal owner or host
remote-access listener. The project picker offers remote connections. Pair or
connect a host in Connections before opening a folder there. Global provider
settings use the first connected remote host; project requests continue to name
their own host.

`DREAM_HOST_MODE=remote` in the desktop's environment does the same and
overrides the setting. For example on macOS:

```sh
DREAM_HOST_MODE=remote /Applications/Dream.app/Contents/MacOS/Dream
```

Cached home projects remain unavailable until their original host is connected.
Authenticating that former home host moves its cached workspace references to a
remote connection without changing project or chat IDs. Returning to ordinary
desktop hosting still requires stopping any service that owns the local host's
database, as described in [Host service](host-service.md).

Arbitrary site port forwarding and the desktop browser relay require a selected
SSH route. HTTPS-only clients can work with host projects, chats, files and
terminals; the host-owned browser is tracked separately in CONN-11.
