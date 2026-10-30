# Tailscale access

Add `ff tailscale` and `pnpm tailscale` to start a production Factory Factory
instance and share it privately through foreground Tailscale Serve. Discover
`Self.DNSName` with `tailscale status --json`, remove the trailing dot, and use
that HTTPS origin for HTTP and WebSocket validation. Keep the backend on
127.0.0.1 and explicitly trust the Tailscale reverse proxy's forwarded headers.
Do not inherit dotenv overrides or disabled origin checks.

Reuse production startup and migration behavior from the proxy command. Proxy
the actual backend port, print the remote URL and a terminal QR code. Missing
Tailscale, disconnected nodes, invalid status, occupied Serve ports, and failed
children must produce actionable errors and clean up children. Stop remote
access and the owned instance on Ctrl+C or child failure. Preserve unrelated
Serve configurations; never use Funnel, background mode, or reset.

## Approaches

A package script alone cannot reliably coordinate discovery, origins, actual
ports, or cleanup. The accepted approach is a CLI command with a pnpm shortcut,
following the existing proxy command. Persistent sharing and attaching to an
existing instance are outside this change. Default HTTPS port is 443; allow an
explicit alternative when another service occupies that port. Access follows the
tailnet's access rules; there is no additional Factory password.
