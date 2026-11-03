# Tailscale port sharing

Agents running on the host print loopback links such as
`http://127.0.0.1:6173/?path=/story/...`. Under `ff tailscale` those links do
not work on another device. This change makes them work, for Tailscale only.

## Behavior

`ff tailscale` passes its HTTPS origin and Serve port to the backend
(`FF_TAILSCALE_ORIGIN`, `FF_TAILSCALE_HTTPS_PORT`). When the page is not itself
on a loopback host, the client rewrites loopback links in chat Markdown and the
Run button to `/proxy/<port><path>` on the Factory Factory origin. The link text
stays as the agent wrote it.

`GET /proxy/<port>/<path>` makes sure the port is shared, then redirects to
`https://<machine>.ts.net:<port>/<path>`. A share is a forwarder inside the
backend process plus one foreground `tailscale serve --https=<port>` child
pointed at it. The forwarder rewrites `Host` (and a matching `Origin`) to
`localhost:<port>` because Vite and Storybook reject `*.ts.net` hosts.

## Why ports, not paths

Dev servers load root-relative URLs (`/@vite/client`, `/manifest.webmanifest`).
Under a path prefix those resolve to Factory Factory itself. A path on the same
origin would also give proxied pages Factory Factory's origin, and with it its
API. A separate port is a separate browser origin.

## Safety

- Automatic sharing only for top-level navigations whose `Sec-Fetch-Site` is
  `same-origin` or `none`. Anything else, including prefetches, gets a
  confirmation page whose same-origin POST performs the share.
- Refuse ports below 1024, the backend and Serve ports, well-known service
  ports, and other Factory Factory backends (identified by `/health`).
- Build redirects only from the configured origin and a validated port.
- Keep `X-Forwarded-For` so other local Factory Factory instances do not treat
  shared traffic as local; drop `Tailscale-User-*` identity headers.
- Never use Funnel, background Serve, or `serve reset`.

## Lifetime

Shares last until the backend stops. Cleanup stops each Serve process group,
then closes its forwarder and open connections. If a Serve child exits, its
forwarder closes and the next visit recreates the share. If the backend crashes,
Serve children can only reach a closed port; their process groups are recorded
in the data directory and stopped on the next start when their owner is gone. A
dev server that stops leaves the share in place so the page can reconnect after
a restart.

`ff tailscale` no longer enables the public cloudflared run-script tunnel. The
backend's startup port line has its own flag (`FF_EMIT_BACKEND_PORT`).

## Later

Shared-port indicator, idle timeouts, linkifying loopback URLs in inline code,
port ownership checks, and rendered workspace HTML on a separate static port.
