# PR delivery failures carry a typed reason

Originally decided on 2026-11-09 in #3105.

## Context

The PR delivery port chose between deferring a busy recipient, pausing after a
failed resume and counting an ordinary retry by matching English error text
produced inside the session capsule. Rewording a message would silently change
delivery state, and untyped text that happened to contain the same phrases was
misclassified.

## Decision

The session capsule raises `ApplicationError` kinds (`SESSION_TURN_BUSY`,
`SESSION_RESUME_FAILED`) and classifies a failed delivery into a
`PRDeliveryFailureReason` (`busy`, `resume_failed` or `failed`) before calling
the delivery port. The port switches on the reason and never reads the message.
The only remaining text check is the provider runtime's own busy-turn payload,
which is external and untyped.

## Consequences

- `busy` defers without spending an attempt, `resume_failed` pauses delivery
  immediately, and anything else is a counted retry that pauses as
  `DELIVERY_FAILED` after three attempts.
- User-visible messages can be reworded freely.
