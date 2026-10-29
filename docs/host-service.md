# Run the host without the desktop

Use a packaged `dream-host` runtime for your OS and CPU. Its archive includes
Node, the host, database migrations, terminal support and the browser client.
Agent CLIs and their credentials must already be available to the same OS user.

For public HTTPS access without a VPN, configure a
[Cloudflare Tunnel](cloudflare-tunnel.md). Run its `cloudflared` connector as
its own service so both keep running without a desktop window; pairing still
controls device access.

Quit Dream before moving its local host into a service. Install using the
desktop's existing data directory so its identity and catalog are preserved:

```sh
dream-host service install --data-dir "<desktop userData>"
```

The desktop data directory is `~/Library/Application Support/dreamide` on macOS,
`%APPDATA%/dreamide` on Windows, and `~/.config/dreamide` on Linux. For a new
headless host, omit `--data-dir`; it uses `<host home>/data`. Host home defaults
to `~/.dream/host`. Supply the same `--home <directory>` on subsequent commands
when using a different home.

Installation captures PATH and any additional variables explicitly named with
`--env NAME`. For a custom desktop database, set `DREAM_DB_PATH` to its absolute
path and include `--env DREAM_DB_PATH`. Name any required provider environment
variables the same way. Values are kept in private service files; status does
not print them. Packaged installations retain their complete runtime under
`<host home>/service-runtimes` so removing an extracted archive or pruning SSH
runtimes does not break the service.

Launch the desktop with `DREAM_HOST_MODE=service` and, for a custom home,
`DREAM_HOST_HOME`. It verifies the service's database ownership and identity.
Closing the desktop leaves host turns and terminals running. To switch back to
the default desktop-owned host, stop the service first; the state lock prevents
two hosts from writing the same database.

## Service commands

```sh
dream-host service status
dream-host service start
dream-host service stop
dream-host service restart
dream-host service uninstall
```

Status reports the service manager, startup policy, running version, port,
runtime path, log path and update recovery state. `--json` returns the same
information without credentials. Uninstall removes the startup registration;
the catalog, identity, workspace and retained runtimes remain.

The macOS LaunchAgent and Windows Task Scheduler task start at user login.
Linux uses `systemd --user`; enabling lingering with `loginctl enable-linger`
allows startup at boot without an interactive login. The host does not idle out
in service mode. Sleeping hardware remains unreachable.

## Update and recover

Choose an explicit published version:

```sh
dream-host service update 0.31.0
```

The version above is an example, not a claim that it has been published. For an
offline archive, supply its trusted checksum:

```sh
dream-host service update 0.31.0 --archive "<runtime.tar.gz>" --sha256 "<64 hex characters>"
```

The updater downloads the platform archive and release `SHA256SUMS`, verifies
the checksum, rejects unsafe archive entries, and runs the candidate's version
contract before stopping the service. It checks platform, protocol, capabilities,
storage-format version and exact migration hashes. Updates preserve the installed
environment and data location; flags from the updating shell do not replace them.

Replacement interrupts running turns and terminals. Running turns become
interrupted and queues pause; review the transcripts and explicitly retry, or
resume (sending a new message in the chat also resumes it). Downloads and
rejected candidates do not interrupt work. After starting
the replacement, the updater verifies its identity, database owner and catalog
readiness. A failed startup restores the retained compatible runtime. It never
restores an older database over newer data.

If the updater or machine stops during replacement:

```sh
dream-host service status
dream-host service recover
```

Recovery accepts a healthy replacement or reinstalls the retained previous
runtime. A pending journal prevents other service commands and automatic client
starts from racing recovery. If the database or identity has changed, recovery
stops with instructions and retains both runtimes and the journal. Status also
shows the last completed update or rollback.

Automatic updates require identical migration history and a compatible storage
format. A schema-changing or protocol-changing release needs a coordinated,
backed-up upgrade; it is rejected before shutdown. A service installed with an
older CLI that did not save launch settings needs a one-time reinstall using a
current packaged runtime and the same data directory and `--env` options.
Checkout-based service installations still work for development, but must be
reinstalled from a packaged runtime before using automatic updates.
