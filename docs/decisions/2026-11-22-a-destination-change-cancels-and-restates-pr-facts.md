# A destination change cancels queued PR facts and restates them

Decided on 2026-11-22 in #3288.

## Context

Changing where PR updates go (turning monitoring on or off, changing the main
recipient, or switching between the main conversation and dedicated ones) renews
the event epoch, and the first observation of an epoch states every fact that
holds: failing CI, open feedback, a conflict, a merged or closed PR.

A switch of mode alone was the exception to cancelling the queue: it kept the
unclaimed facts so that nothing was lost. But the reducer reads only the current
epoch, so each kept fact was stated a second time by the new epoch, and the old
copy could no longer be superseded: a kept `CI_FAILED` was delivered after CI
had passed.

## Decision

Every destination change cancels the unclaimed facts queued for the old
destination, in the transaction that renews the epoch. No unclaimed fact
outlives its epoch. Pinned by
`src/backend/services/workspace/resources/workspace-pr-delivery-modes.accessor.integration.test.ts`
and
`src/backend/orchestration/pull-requests/pr-review-observation.integration.test.ts`.

Keeping the facts and not renewing the epoch was rejected: a new dedicated
conversation would start with only later changes and no statement of the PR's
state, and could be told that CI recovered from a failure it never saw.

## Consequences

- The only facts a switch drops for good are `CONFLICT_CLEARED` and
  `CI_RECOVERED`, which refer to a detection the new destination never received.
- A delivery already claimed is not cancelled by the switch. Receipt recovery
  settles it: delivered if the old conversation shows the marker, cancelled if
  it does not.
- A fact delivered to the old destination that still holds is stated again to
  the new one.
