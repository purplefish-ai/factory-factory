# Tailscale Implementation Plan

**Goal:** Start and share an owned Factory Factory instance with one command.
**Architecture:** Share the proxy server startup helper. Keep Tailscale status
validation and command lifecycle in CLI modules. **Tech Stack:** TypeScript,
Node child processes, Zod, Commander, Vitest. **Spec:**
`docs/superpowers/specs/2026-10-30-tailscale-design.md`

## Constraints and review focus

Use Node 26.12.1 and pnpm 12.15.0. Preserve default Cloudflare trust behavior.
Exercise malformed/disconnected status, nested Serve conflicts and Funnel,
actual-port forwarding, child failures, startup interruption and cleanup.

### Task 1: Shared startup and Tailscale command

- [x] Write and run failing tests for origin discovery, configuration conflicts,
      trusted startup environment, and command lifecycle.
- [x] Extract `startFactoryFactoryServer` into `src/cli/server-startup.ts`;
      preserve the proxy export and add explicit trusted origin support.
- [x] Implement status validation, foreground Serve, owned child cleanup, CLI
      registration, pnpm shortcut, and user documentation.
- [x] Run focused tests, required repository checks, build, and full tests.
- [x] Review changes, commit, push, and open a ready-for-review PR.

## Verification

`pnpm check:fix`, `pnpm typecheck`, `pnpm check`, `pnpm build`, and the full
`pnpm test` suite pass (9,781 tests; three skipped). `pnpm test:integration`
passes (253 tests; three skipped). A built-CLI smoke test using a simulated
Tailscale executable starts a real temporary Factory backend, serves HTML and
health, and verifies both children stop on SIGINT. Live machine status and Serve
configuration validate; port 443 is occupied and 8443 is available. Actual
remote-device access was not exercised.

Review found a startup abort listener gap and incomplete startup shutdown. Both
are fixed with cancellation-aware readiness, retained error listeners, and
shared bounded shutdown with SIGKILL escalation; regression tests pass.
