# PR deliveries are frozen once claimed and proven only by receipt

Originally decided on 2026-10-14 in #2447; batches were normalized into
`WorkspacePRDelivery` on 2026-11-02 in #2824.

## Context

A PR update is an external effect: once a provider accepts the prompt, the agent
may act on it. The backend can crash, the provider can exit, and the recipient
can change between claiming an update and learning whether it arrived. Sending
it twice wastes a turn and can repeat work; dropping it loses CI failures and
review feedback.

## Decision

Claiming an update freezes it in one transaction: delivery ID, the complete set
of event IDs, recipient and provider identity, binding revision, message text
and attempt. Retries reuse that frozen text and identity and never read GitHub
again; later facts wait for a later batch. Only one PR delivery per workspace
may be claimed at a time.

A completed provider prompt acknowledges receipt. After an uncertain exit,
receipt is proven only by the delivery marker on its own line of a user prompt
in provider-owned history; optimistic local rows do not count. Proven absence
allows a bounded retry in the same conversation. If the conversation is no
longer the recipient, it cancels the old batch instead. If it is still the
recipient and a PR in its frozen `MAIN` batch was detached, it cancels the batch
and queues fresh copies of the facts of the PRs still attached. Unreadable
history pauses delivery. Ambiguous evidence never authorizes a resend, and a
frozen message is never retargeted into another conversation.

## Consequences

- Delivery rows and their full membership are recovery proof. Migrations,
  backups and any future recovery manifest must keep them; contradictory or
  incomplete evidence is quarantined as `BLOCKED`, which holds later claims
  until the user discards it. Discarding resends nothing and deletes nothing.
- When provider history is missing, delivery pauses as `RECEIPT_UNAVAILABLE`.
  Recovery is to restore the provider history files and the archived session
  identity, then explicitly resume the conversation.
- When the recipient's worktree is missing, delivery pauses as `SESSION_FAILED`
  with its events kept; restore the worktree at its configured path, then use
  **Resume PR updates**.
