# PR updates go to the workspace's own conversations

Originally decided on 2026-10-14 in #2447.

## Context

The former Ratchet fixer started a separate, transient `ratchet` session for
each CI failure or review. That session had its own dispatch template, provider
selection, permission defaults, completion tracking and crash retries. It did
not know the task the workspace's agent was doing, and its fixes competed with
that agent in the same worktree.

## Decision

Replace the fixer with one event pipeline. A two-minute poll observes attached
PRs and records actionable facts in a durable ledger; delivery queues them as a
message to a conversation in the workspace. A workspace setting chooses the
destination: `MAIN` (the default) delivers to one bound ordinary conversation,
so the agent that wrote the code keeps its context and decides how to respond;
`DEDICATED` lazily creates one conversation per PR and reuses it. Observation,
reduction, deduplication, receipts, retries and busy guards are shared by both
destinations. The fixer is replaced outright, with no option to keep it.

Updates never interrupt a turn: they wait for an idle recipient, no pending
interactive request and no other working agent in the workspace. Enabling
monitoring or binding a recipient queues no message of its own.

## Consequences

- A sole ordinary conversation is bound automatically; several require an
  explicit choice, and auxiliary sessions (Ratchet, auto-iteration, adversarial
  review, dedicated PR conversations) never become the main recipient.
- Dedicated conversations use the workspace's provider, normal model defaults
  and the normal session limit; there are no separate Ratchet provider or
  permission settings.
- The cutover retires and archives each legacy fixer session, keeps its exact
  IDs, and fences delivery until the transcript is confirmed retained.
