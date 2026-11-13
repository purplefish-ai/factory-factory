# Startup provisioning follows the shell's exit

Originally decided on 2026-09-08 in #2244 (issue #1918).

## Context

Startup scripts often start background processes. Those descendants inherit the
script's stdout and stderr pipes, so waiting for the pipes to close could hold
provisioning open for as long as the background process ran.

## Decision

Provisioning follows the main shell's exit. After it exits, output pipes get one
second (`SERVICE_TIMEOUT_MS.startupScriptOutputDrain`) to drain to closure.
Output written later is drained and discarded until the descendants close their
pipes, so they are not interrupted by a closed reader.

## Consequences

- A startup script that leaves a background process running still completes.
