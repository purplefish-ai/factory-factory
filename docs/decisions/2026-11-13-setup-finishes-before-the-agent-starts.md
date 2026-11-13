# Setup finishes before the agent starts

Originally decided on 2026-10-28 in #2622.

## Context

Workspace creation used to start the default agent alongside the factory setup
and project startup scripts. Provider startup hooks can depend on tools those
scripts install and files they generate, and the agent's startup runs under a
bounded deadline. Setup time spent inside that deadline exhausted it even when
setup succeeded.

## Decision

Initialization finishes both setup phases and persists READY (with a warning if
a script failed non-fatally) before it starts the default agent session. Work
that does not need the worktree's tools, such as preparing the initial task from
an issue, runs alongside provisioning instead, and the task is published to the
queue before READY so it can still be cancelled during setup.

## Consequences

- The agent's startup deadline covers only the agent's own startup.
- The first agent turn starts later, by the length of setup.
- An unexpected provisioning failure starts no agent and publishes no late
  prompt.
