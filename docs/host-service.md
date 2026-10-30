# Run the host

`dream-host` is Dream's host: the process that owns projects, chats, agent
CLIs, terminals and git, for Dream's desktop and browser clients. The desktop
runs one for you; run it yourself to keep agents working without the desktop
window, on a headless machine, or under your own service manager.

The runtime includes Node, the host, database migrations, terminal support
and the browser client. Agent CLIs and their credentials must already be
available to the same OS user.

## Install

Any of these installs the runtime of a release into
`~/.dream/host/versions/<version>/`, after checking it against the release's
`SHA256SUMS`. It is the same place Dream installs it over SSH.

```sh
# With Node 20.11 or later: installs on first use, then runs it.
npx dream-host@<version> serve

# macOS and Linux: links dream-host into ~/.local/bin.
curl -fsSL https://github.com/dreamide/dream/releases/download/v<version>/install-host.sh | sh
```

```powershell
# Windows: puts dream-host in %USERPROFILE%\.dream\bin and on your user PATH.
irm https://github.com/dreamide/dream/releases/download/v<version>/install-host.ps1 | iex
```

Runtimes are built for macOS on Apple silicon, Linux x64 and arm64, and
Windows x64.

## Run

```sh
dream-host serve                 # in the foreground; Ctrl+C stops it
dream-host ensure                # in the background, or reuse the running one
dream-host status                # is one running (exit 3 if not)
dream-host stop                  # stop it, flushing its writes
dream-host help                  # every command and option
```

Every option is a flag and an environment variable. A flag wins over the
variable, the variable over a setting the host saved (remote access), and that
over the default:

```sh
dream-host serve --idle-timeout 0
DREAM_HOST_IDLE_TIMEOUT=0 dream-host serve
```

## Options

The table is generated from the host's own option list
(`electron/host/options.js`); `dream-host help` prints the same.

| Flag | Environment variable | Default | What it is |
| --- | --- | --- | --- |
| `--home` | `DREAM_HOST_HOME` | `~/.dream/host` | The host's home: its run record (port, token) and log, and by default its data. |
| `--data-dir` | `DREAM_HOST_DATA_DIR` | `<home>/data` | The host's data: its identity, settings and, by default, its database. The desktop's data directory makes it the desktop's host. |
| `--database` | `DREAM_HOST_DATABASE`, `DREAM_DB_PATH` | `<data dir>/dream.db` | The state database: projects, chats and transcripts. One host runs per database. |
| `--port` | `DREAM_HOST_PORT` | a free port | The loopback port of the host's local API, for this machine's clients. |
| `--idle-timeout` | `DREAM_HOST_IDLE_TIMEOUT` | `3600` | Seconds with nothing going on (no client, terminal, turn or remote access) before the host exits; 0 never exits. |
| `--remote-port` | `DREAM_HOST_REMOTE_PORT` | remote access as saved | Serve paired devices on this loopback port, for a reverse proxy you run. Overrides the saved remote access setting. |
| `--remote-origin` | `DREAM_HOST_REMOTE_ORIGINS` | none | The public origin(s) the reverse proxy serves the remote port at. Repeat the flag, or separate them with commas. |
| `--trust-forwarded-host` | `DREAM_HOST_TRUST_FORWARDED_HOST` | `false` | Let the reverse proxy name the host in X-Forwarded-Host. |
| `--client-dir` | `DREAM_HOST_CLIENT_DIR` | the runtime's browser client | The browser client the host serves to paired devices. |
| `--owner` | `DREAM_HOST_OWNER` | `user` | Who started the host: user, or desktop for the host a desktop starts and stops itself. |
| `--diagnostics` | `DREAM_HOST_DIAGNOSTICS` | `false` | Serve terminal flow-control diagnostics (development). |


`dream-host` reads no `.env` file: give it variables in its environment.

## The desktop's host

The desktop uses the host running on its own data, whoever started it, and
otherwise starts one:

- **A host the desktop started** runs in its own process and stops when you
  quit Dream. Settings > Sharing & access can restart it.
- **A host you started** with `dream-host` on the desktop's data is used as it
  is and keeps running when you quit Dream. Restart it where it runs.

To run the desktop's host yourself, give it the desktop's data directory:

```sh
dream-host serve --data-dir "<desktop data directory>" --idle-timeout 0
```

The desktop data directory is `~/Library/Application Support/dreamide` on macOS,
`%APPDATA%\dreamide` on Windows, and `~/.config/dreamide` on Linux. A desktop
started with `DREAM_DB_PATH` uses that database: pass the same path as
`--database`. Start it before the desktop, or quit the desktop first: one host
runs per database.

`DREAM_HOST_MODE` in the desktop's environment overrides Settings: `remote`
runs no host on this computer, `in-process` runs the host inside the app, and
`auto` (or unset) does the above.

## Remote access

Remote access is a saved setting of the host. While a host runs, turn it on
once, and it is applied every time the host starts:

```sh
dream-host remote on --tailscale          # or: --cloudflare --origin https://dream.example.com
dream-host pair                           # a pairing link and code
dream-host devices                        # paired devices; revoke <id> ends one
```

`dream-host serve --pair` prints a pairing link and code as soon as the host
listens. With your own reverse proxy, `--remote-port` and `--remote-origin`
set remote access for that run instead of the saved setting; Settings then
shows it as set by those options and cannot change it.

See [Cloudflare Tunnel](cloudflare-tunnel.md) for public HTTPS access without a
VPN. Pairing always controls device access.

## Keep it running

Run `dream-host serve` under your operating system's service manager, with the
idle timeout off and restart on failure. These are starting points; adjust the
path to `dream-host` and add the variables your agent CLIs need.

### Linux (systemd, per user)

`~/.config/systemd/user/dream-host.service`:

```ini
[Unit]
Description=Dream host

[Service]
ExecStart=%h/.local/bin/dream-host serve --idle-timeout 0
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now dream-host
loginctl enable-linger "$USER"   # start at boot, not only at login
```

### macOS (launchd)

`~/Library/LaunchAgents/dream-host.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dream-host</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.local/bin/dream-host</string>
    <string>serve</string>
    <string>--idle-timeout</string><string>0</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
```

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dream-host.plist
```

### Windows (Task Scheduler)

In PowerShell, a task that starts at logon without a console window
(`S4U` runs it in the background as you, without storing your password):

```powershell
$action = New-ScheduledTaskAction -Execute "$HOME\.dream\bin\dream-host.cmd" -Argument "serve --idle-timeout 0"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "Dream host" -Action $action -Trigger $trigger -Principal $principal -Settings $settings
```

These examples have not all been run on every OS; check the host answers with
`dream-host status` after setting one up.

## Update

Install the new version (above), then restart the host: `dream-host stop`
and start it again, or restart the unit or task. A version whose storage
format changed needs the same version of Dream's desktop.

## Remove a service from Dream 0.30 or 0.31

Those versions could install the host as a service themselves; Dream no
longer manages services. To remove one:

- Linux: `systemctl --user disable --now dream-host`, then delete
  `~/.config/systemd/user/dream-host.service`.
- macOS: `launchctl bootout "gui/$(id -u)/ai.dreamdream.dream-host"`, then
  delete `~/Library/LaunchAgents/ai.dreamdream.dream-host.plist`.
- Windows: `schtasks /End /TN "Dream host"` and
  `schtasks /Delete /TN "Dream host" /F`, then delete `service.vbs` and
  `service-task.xml` in the host home (`%USERPROFILE%\.dream\host`).

The host's data, identity and paired devices are untouched. Its retained
runtimes in `<host home>/service-runtimes` can be deleted.
