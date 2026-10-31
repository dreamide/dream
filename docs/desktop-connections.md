# Desktop connections

In Settings > Hosts, choose **Add host**, then **SSH host**, or **Pairing code** and enter
the host's HTTPS address and a code created on the host (Settings > Sharing & access >
**Pair a computer**, or `dream-host pair`). The code works once and expires after ten
minutes. The host must run a version with native identity proof
support, and its HTTPS certificate must be trusted by the desktop's Node runtime.
Tailscale Serve's HTTPS origin works as a direct route; no Dream account is needed.

For an **SSH host**, enter what you would type after `ssh`: an alias from your SSH
config, or `user@host`. Dream uses your own OpenSSH, keys and config, and runs
`dream-host ensure` there through your login shell, so `dream-host` must be installed
on that machine and on that shell's `PATH` ([Run the host](host-service.md)). The name
is optional and defaults to the target.

Each verified host has one entry. Adding another route to the same authenticated
host merges it into that entry and keeps the existing project, chat and workspace
IDs. Edit that entry and use **Add SSH route** or **Add HTTPS route** to pin the new
route to that host before pairing or loading its catalog. SSH routes can be edited;
editing an HTTPS route requires a fresh pairing code. Re-pairing the same origin
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

Arbitrary site port forwarding and the desktop browser relay require a selected
SSH route. HTTPS-only clients can work with host projects, chats, files and
terminals; the host-owned browser is tracked separately in CONN-11.
