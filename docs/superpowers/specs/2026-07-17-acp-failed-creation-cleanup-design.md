# ACP Failed-Creation Cleanup Design

## Problem

When ACP client initialization fails after spawning the adapter, `AcpRuntimeManager.cleanupFailedClientCreation()` sends `SIGTERM` and immediately checks `child.exitCode`. Node updates `exitCode` only after processing the asynchronous `exit` event, so the check still sees `null` and immediately sends `SIGKILL`. The adapter therefore has no opportunity to clean up its own descendants, which can orphan the Codex app-server process.

## Considered Approaches

1. Make failed-creation cleanup asynchronous and reuse the event-before-signal, five-second grace-period pattern already used by `stopClient()`. This is the recommended approach because it fixes the race with the smallest change and keeps error propagation synchronized with process cleanup.
2. Extract a shared subprocess-termination utility and refactor both `stopClient()` and failed-creation cleanup around it. This could reduce duplication, but it expands a focused bug fix into the established stop path and increases regression risk.
3. Send `SIGTERM` and schedule an unawaited `SIGKILL` timer. This avoids delaying initialization rejection, but cleanup would outlive client creation, complicate shutdown coordination, and make timer and error handling harder to verify.

## Design

`cleanupFailedClientCreation()` will return `Promise<void>`. For a live child, it will register an `exit` listener before sending `SIGTERM`, resolve immediately if the process has already exited, and wait up to five seconds with the existing `raceWithSoftTimeout()` helper. It will treat either a non-null `exitCode` or `signalCode` as exited, because Node leaves `exitCode` null when a signal terminates the process. It will send `SIGKILL` only when both values remain `null` after the grace period. Existing best-effort error handling and cleanup logging remain intact.

Every caller will await cleanup before throwing or continuing. That includes handshake/session-creation failures, shutdown detected after initialization, and both stop-race checks performed during client creation. `abortClientCreationIfStopping()` will therefore also become asynchronous. Initialization failures may take up to five additional seconds to reject when an adapter ignores `SIGTERM`; adapters that exit normally reject as soon as their `exit` event arrives.

No public interface, database, protocol, UI, or dependency changes are required.

## Error Handling and Edge Cases

- A child that has already exited normally or from a signal receives no signal.
- The exit listener is registered before `SIGTERM`, so a fast exit cannot be missed.
- A child that exits asynchronously during the grace period receives no `SIGKILL`, including when Node reports the exit through `signalCode` rather than `exitCode`.
- A child that remains alive for five seconds is escalated to `SIGKILL`.
- Signal-dispatch errors remain best-effort cleanup failures and are swallowed as before.
- Handshake errors, startup timeouts, manager shutdown, and explicit stop during creation retain their original rejection reasons after cleanup settles.

## Testing

- Change the initialization-failure regression test to model an asynchronous signal exit after `SIGTERM` and assert that only `SIGTERM` is sent.
- Add coverage proving a child with an existing `signalCode` receives no additional signal.
- Add a fake-timer regression test proving `SIGKILL` is absent before the grace period and sent after five seconds when the child does not exit.
- Update existing spawn-error, initialization-timeout, shutdown-during-creation, and explicit-stop-during-creation tests to model graceful `SIGTERM` exit and preserve fast execution. Keep only the dedicated escalation test alive through the full grace period.
- Run the focused ACP runtime-manager test through a red-green cycle, then run typecheck, formatting/lint fixes, the full Vitest suite, and the production build.
