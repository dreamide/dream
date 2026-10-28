# Reach a host through Cloudflare Tunnel

Use a persistent tunnel and stable hostname from your own Cloudflare account.
The existing desktop and browser clients connect over HTTPS without joining a
VPN. Dream still requires device pairing and verifies the host's identity;
Cloudflare supplies the network route. No Dream account or native mobile app
is involved.

## Configure Cloudflare

1. Create a dedicated, remotely managed Cloudflare Tunnel in the
   [Cloudflare dashboard](https://one.dash.cloudflare.com/). Copy just its
   connector token from the installation instructions, rather than the whole
   command. Use a separate tunnel/token/hostname for each independent host.
2. Add a published application hostname, for example `dream.example.com`.
   Set its service URL to `http://127.0.0.1:5410`, or the **Local port** shown
   in Dream. A new Cloudflare route uses port 5410 when it is free and no port
   was saved; otherwise the host picks another and shows it. The connector must run on the host machine. Leave HTTP Host Header
   at its default so requests retain the public hostname.
3. Bypass Cloudflare caching for `/api/*`. The host returns `Cache-Control:
   no-store` there, but an account-wide cache rule must not override it. Keep
   WebSockets enabled and avoid response buffering or transformation rules on
   streaming API responses.
4. Ensure this hostname permits direct API and WebSocket requests. An
   interactive Cloudflare Access login or browser challenge cannot be completed
   by the desktop's native transport. Dream's pairing and device sessions
   authorize access to the host.

Use the [persistent tunnel setup guide](https://developers.cloudflare.com/tunnel/get-started/).
[Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations)
are unsupported: their addresses change and they do not support SSE chat streams.

## Desktop setup

Open **Settings > Connections > Remote access**, choose **Set up** (or **Change**)
and select **Cloudflare Tunnel**. Enter the public HTTPS address and paste the
tunnel token. Choose **Install cloudflared** if needed, then
**Turn on**. Configure the same local port in Cloudflare.

Dream checks the connector and requests a fresh signed host proof through the
public address before showing **Ready**. Use **Check again** (the refresh button) after correcting
the hostname, service URL, token or network. Startup can take a few seconds;
the host keeps checking even when Settings is closed.

Choose **Pair a device** and use its one-time link or confirmed code. QR is an
optional way to open the same link. Open a link in the browser client or paste
it into **Add host > Pairing link** on another Dream desktop. Normal reconnection reuses the
device grant. SSH and other HTTPS routes can belong to that same host.

## Headless setup

Install the [unattended host service](host-service.md) first to keep the tunnel
running after the desktop closes. Otherwise the connector exits with its host.
Use the same `--home <directory>` on every command if using a custom host home.

Save the token in a private local file, then run:

```sh
dream-host remote install-cloudflared
dream-host remote on --cloudflare --origin https://dream.example.com --port 5410 --token-file /private/path/tunnel-token
dream-host remote status
dream-host remote check
dream-host pair
```

The initial `on` can report not ready while Cloudflare connects. Status shows
the hostname, local service URL, installed version and sanitized connector
failure. `--json` returns structured status without credentials. `remote restart`
stops the managed connector, starts a fresh one and checks the route again; it
does nothing for an external connector. `service restart` restarts the whole host.

## Token storage and rotation

Dream saves the token in `remote-access.json.cloudflare/tunnel-token` beside
the default database. A custom database uses
`<database>.remote-access.json.cloudflare/tunnel-token`. The directory is
private; the token file is mode 0600 on Unix. Protect the host user's data
directory with its usual Windows access controls. Tokens stay out of ordinary
settings, workspace exports, status, logs, command arguments and child environment
variables. The connector receives the private file path through `--token-file`.

Choose **Change**, paste a replacement token and choose **Save**, or repeat `remote on` with a
new `--token-file`. Dream replaces the private token and restarts only its own
connector. Leaving the token input blank keeps the saved token. Rotate in
Cloudflare as well; Cloudflare token rotation alone does not disconnect already
running connectors. See [tunnel token management](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/).

**Install/Update cloudflared** downloads an official GitHub release for this
OS/CPU, checks its SHA256 release digest and executable version, then publishes
it in the host's private runtime directory. Existing supported installations
on PATH (and common installer locations) are also detected. Version 2025.4.0
or newer is required for `--token-file`. Updates are explicit; the owned child
does not auto-update itself. A successful update removes earlier private
runtimes, and a failed one removes its partial download and keeps the current
runtime.

## External connectors, shutdown and recovery

In the setup dialog, open **Advanced** and select **I run cloudflared myself**, or use:

```sh
dream-host remote on --cloudflare --external --origin https://dream.example.com --port 5410
dream-host remote off
```

In external mode you install, start, update and stop `cloudflared` separately.
Dream verifies the public route and manages its remote listener. It does not
modify Cloudflare DNS, delete the tunnel or stop an external connector. Stop
that connector separately if you also want to remove its Cloudflare connection.

Disabling remote access closes the listener and stops only Dream's owned child.
It retains host identity, catalogs, saved device grants and tunnel credentials.
The host service restarts the saved configuration without a desktop window.
If the host is killed, a watchdog reaps its connector to prevent orphan processes.
The connector retries transient network failures. When it exits, or has not
connected for two minutes since it started or was last connected, the host
starts a new one with exponential backoff capped at one minute, and keeps
retrying for as long as the tunnel is turned on. Only a rejected or missing
token or a missing runtime stops retries until it is fixed and you choose
**Check again**. Permit outbound Cloudflare connector traffic on port 7844; sleeping
hardware remains unreachable.

Check the Cloudflare hostname and service port when the connector is connected
but the address is not ready. A response from another Dream installation fails
the signed proof check. Revoke a paired device in Connections or with
`dream-host revoke <sessionId>`; its streams and sockets close without stopping
the host's running work.
