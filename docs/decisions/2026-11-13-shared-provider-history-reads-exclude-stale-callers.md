# Shared provider history reads exclude stale callers

Originally decided on 2026-11-09 in #3138.

## Context

Passive chat loads, load retries, session startup and workflow finalization can
each hydrate the same session's provider history at the same time. Each read
parses the whole Claude or Codex history file and projects it into a transcript,
and each caller applies the result through its own domain and fences.

## Decision

Concurrent callers for one session, provider identity, worktree and Codex
account await a single read and projection. A caller never joins a read that
already has a stale caller: a stop, reset or rollover after that read began may
have changed the file. The read stops only once every caller is stale, and a
stopped read is never cached.

## Consequences

- Concurrent hydrations of one session cost one read.
- A caller that arrives after a stop, reset or rollover pays for a fresh read
  rather than receiving a result that may predate the change.
- A caller going stale does not cancel the read for the callers still current.
