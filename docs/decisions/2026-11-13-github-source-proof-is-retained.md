# GitHub source proof is retained

Originally decided on 2026-11-02 in #2818 (issue #2772).

## Context

Event automations read a GitHub repository's issue-event feed by polling its
offset pages. An activation boundary is a prepared baseline: the feed head when
Enable read it, which gets an ordinal once every older event has one. Provider
history can be pruned or shift while a baseline is being prepared, and a
provider baseline read may still be in flight before its pending baseline row
exists. Event payloads are pruned after 30 days and their identities after 90.

## Decision

The capsule keeps compact, permanent proof for every captured feed identity:
FINALIZED markers, head checkpoints with their ordinals (including PR and other
control heads that have no event row) and every issued baseline. Only CAPTURE
and VERIFY pages that a complete, validated checkpoint makes redundant are
compacted. No age or current-reference rule deletes the permanent proof, because
no such rule can know that a read in flight will not ask for it. Contradictory
evidence blocks new baseline preparation instead of rewriting an answer already
issued. A rejected interval also stops page compaction in its epoch, since later
pages may hold conflicting heads that no check has examined yet.

Rejected:

- Deleting proof by age or when no current baseline refers to it.

## Consequences

- `getBaseline` returns the same answer for an issued ID after page compaction
  and event pruning.
- The proof tables grow with the feed; they hold identities and ordinals, not
  source text.
- A source with rejected proof cannot prepare a baseline; the failure fences it
  with `RECOVERY_REQUIRED` until a reset
  ([Source reset opens a new epoch](2026-11-13-source-reset-opens-a-new-epoch.md)).
