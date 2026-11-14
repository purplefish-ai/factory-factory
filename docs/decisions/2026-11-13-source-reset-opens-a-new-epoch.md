# Source reset opens a new epoch

Originally decided on 2026-11-12 in #3181 (issue #2772).

## Context

When GitHub intake observes a discontinuity it fences the source with
`RECOVERY_REQUIRED`, and until #3181 nothing could lift that fence. The usual
cause is a deleted anchor. A fresh start then begins at a head identity that may
already have an older ordinal in the retained proof, which must not be deleted
([GitHub source proof is retained](2026-11-13-github-source-proof-is-retained.md)).
Without scoping, the new proof would contradict the old FINALIZED marker, head
and baselines: it would be rejected and fence the source again, and historical
lookups would hand out the old, lower ordinal, making already-ordered events
eligible again.

## Decision

A trusted-local `automation.resetSource` is the explicit decision to give up on
the gap. It pauses every trigger on the connection and opens a new epoch. The
source and every proof row carry an epoch number, and ordinal authority is per
epoch: historical lookups, baseline resolution, the rejected-proof fence and
proof maintenance read only the current epoch. The new epoch starts at the
retained high water. Earlier epochs' proof is kept unchanged, and an event
captured but never ordered before the reset can never be ordered. No trigger is
enabled; Enable takes a fresh baseline.

Rejected:

- Deleting or tombstoning the old proof or the unordered events: it breaks the
  retained-proof rule and `getBaseline` for issued IDs.
- An ordinal floor without a per-row epoch: old pending baselines and unfinished
  or rejected checkpoints have no ordinal to filter on, and old and new rows
  collide at the floor.

## Consequences

- Ordinals never go backwards, and `(connectionId, sourceOrder)` stays unique.
- Events from the gap never run.
- Each automation on the connection needs Enable again after a reset.
