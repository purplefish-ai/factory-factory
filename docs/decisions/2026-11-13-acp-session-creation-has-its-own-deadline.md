# ACP session creation has its own deadline

Originally decided on 2026-11-12 in #3175.

## Context

Starting an agent session makes two kinds of provider call. The `initialize`
handshake is fast. Provider session creation (new, load or resume) and the
startup model configuration after it do filesystem and project setup, which can
block for tens of seconds on a loaded machine, for example while macOS
`fseventsd` is degraded. With one 30-second budget for both, a slow machine
failed to start sessions instead of starting them slowly.

## Decision

The handshake keeps `ACP_STARTUP_TIMEOUT_MS` (30 seconds by default). Session
creation and the startup model configuration use
`ACP_SESSION_CREATION_TIMEOUT_MS` (120 seconds by default). Each start uses the
values it read when it began.

## Consequences

- A slow provider-side setup no longer fails a start that would have completed.
- A provider that hangs during session creation is detected later than one that
  hangs during the handshake.
- Disposable launch-option probes and model-catalog loaders keep their own
  deadlines.
