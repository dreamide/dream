# Reach a host through Cloudflare Tunnel

Use a persistent tunnel and stable hostname from your own Cloudflare account.
The existing desktop and browser clients connect over HTTPS without joining a
VPN. Dream still requires device pairing and verifies the host's identity;
Cloudflare supplies the network route. No Dream account or native mobile app
is involved.

You run the tunnel's `cloudflared` connector yourself, the way Cloudflare's
dashboard sets it up. Dream never installs, starts, updates or stops it, and
never needs the tunnel token. It needs only the public address and the local
port the hostname is routed to.

## Configure Cloudflare

You need a domain whose DNS is on Cloudflare.

1. Create a tunnel in the [Cloudflare dashboard](https://one.dash.cloudflare.com/)
   (Networking > Tunnels). Choose **Cloudflared** and run the install command
   it shows on the host machine. On Windows and macOS it installs `cloudflared`
   as a service that starts with the computer. Use a separate tunnel and
   hostname for each independent host.
2. Add a route (a published application) for a hostname on your domain, for
   example `dream.example.com`. Set its service to `HTTP` and
   `127.0.0.1:5410`, or the **Local port** shown in Dream. A new Cloudflare
   route uses port 5410 when it is free and no port was saved; otherwise the
   host picks another and shows it. Leave HTTP Host Header at its default so
   requests retain the public hostname.
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

Open **Settings > Sharing & access**, choose **Set up** (or **Change**)
and select **Cloudflare Tunnel**. Enter the public HTTPS address, such as
`https://dream.example.com`, then choose **Turn on**. If you change **Local
port** under **Advanced**, change the route's service URL in Cloudflare too.

Dream requests a fresh signed host proof through the public address before
showing **Ready**. Use **Check again** (the refresh button) after correcting
the hostname, service URL or connector. The host keeps checking even when
Settings is closed.

Under Settings > Sharing & access, choose **Create link** and use its one-time
link or confirmed code. Open the link in a computer's browser, or paste it into
**Add host > Pairing link** on another Dream desktop. Normal reconnection reuses the
device grant. SSH and other HTTPS routes can belong to that same host.

## Headless setup

Run `dream-host` under your service manager ([Run the host](host-service.md))
and run `cloudflared` as a service too, so both keep running after the desktop
closes. Use the same
`--home <directory>` on every command if using a custom host home.

```sh
dream-host remote on --cloudflare --origin https://dream.example.com --port 5410
dream-host remote status
dream-host remote check
dream-host pair
```

Status shows the hostname and the local service URL to route to. `--json`
returns structured status. `--external`, from when Dream could run the
connector, is still accepted and has no effect.

## Turning access off

Disabling remote access closes the host's remote listener, so the hostname
stops reaching it. Your `cloudflared` service keeps running; stop or uninstall
it separately (`cloudflared service uninstall`) if you also want to remove its
Cloudflare connection. Disabling retains host identity, catalogs and saved
device grants.

Check the Cloudflare hostname, the service port and that `cloudflared` is
running when the address is not ready. A response from another Dream
installation fails the signed proof check. Permit outbound Cloudflare
connector traffic on port 7844; sleeping hardware remains unreachable. Revoke
a paired device in Connections or with `dream-host revoke <sessionId>`; its
streams and sockets close without stopping the host's running work.

## Upgrading from a Dream-run connector

Earlier versions could run `cloudflared` themselves with a saved tunnel token.
That connector no longer starts. At startup the host deletes the private
directory that held the token and downloaded runtime
(`remote-access.json.cloudflare`, or `<database>.remote-access.json.cloudflare`
for a custom database). Run the tunnel's install command from the Cloudflare
dashboard on the host machine; the saved address and port keep working.
