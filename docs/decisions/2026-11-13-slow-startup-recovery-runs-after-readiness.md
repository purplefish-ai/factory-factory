# Slow startup recovery runs after readiness

Originally decided on 2026-11-02 in #2801 (archive recovery) and on 2026-11-03
in #2859 (NEW workspaces).

## Context

Startup used to finish every recovery before the backend reported ready. Two of
them can take minutes: resuming archives left in ARCHIVING, whose Git worktree
cleanup can be slow, and initializing NEW workspaces a previous process left
behind, which means worktree creation, the startup script and the default agent
session. A single slow setup script could exceed Electron's 120-second start
deadline and the CLI's 30-second proxy deadline.

## Decision

Only the essential repairs run before readiness: session and workspace state
repairs, and marking stale PROVISIONING workspaces FAILED unless their init
script is still running. Archive recovery and NEW workspace initialization run
in tracked background passes after startup completes, NEW workspaces one at a
time, and periodic reconciliation waits for that pass before it queries.

Shutdown stops reconciliation from admitting work as soon as cleanup begins, and
drains the in-flight initialization only after sessions and processes are torn
down, just before the database disconnects: the startup script cannot be
cancelled, and new agent sessions fail fast once clients have stopped.

Rejected: keeping these passes inline, which tied readiness to the slowest
worktree or setup script.

## Consequences

- HTTP, WebSocket and the CLI startup signal are available while affected
  workspaces still show ARCHIVING or NEW.
- Shutdown can take as long as one in-flight initialization.
- If shutdown begins during essential reconciliation, startup aborts before it
  launches these passes or starts background services.
