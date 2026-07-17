# Final Hardening Report

## Status

Complete on `feature/kanban-next-action-ownership`.

Commit: `Harden Kanban ownership propagation` (the commit containing this report).

## Changes

- Direct CI observations now share the PR aggregate dispatch-reset transaction and full dispatch
  tuple CAS/fallback, and publish an ownership invalidation after a reset.
- Ratchet state events publish only fresh `prCiStatus` directly; `ratchetState` comes from the
  authoritative serialized projection.
- Authoritative projection reads and cached-column refreshes retry transient failures with bounded
  exponential backoff and cancel pending retries on stop or reconfiguration.
- Cached-column writes compare the complete lifecycle/ownership tuple and rerun after a CAS miss,
  preventing an old refresh from overwriting lifecycle or archive state.
- The event collector owns every registered listener, removes all of them on stop/reconfigure,
  cancels the prior coalescer and projection retries, and has a real-EventEmitter lifecycle test.
- The event coalescer integration now describes the authoritative direct-CI transition rather than
  obsolete payload event ordering.

No schema migration was required.

## TDD evidence

The initial focused RED run produced three expected failures:

- delayed old Ratchet state overwrote a newer disable;
- a failed authoritative projection never retried;
- a failed cached-column refresh rejected and lost its invalidation.

Additional tests cover direct-CI invalidation and settled reset, shared dispatch CAS preservation,
the `FAILURE`/exhausted to `PENDING`/`WORKING` transition, lifecycle/archive cache CAS, retry
cancellation, complete mocked listener cleanup, and real EventEmitter listener counts across
reconfigure and stop.

Final focused command covers 10 files and 321 tests, including Ratchet, GitHub snapshot,
workspace accessor/cache, snapshot store, ownership guard, and orchestration integrations.

## Guardrails

- `pnpm check:fix`: passed.
- `pnpm typecheck`: passed before final formatting and is rerun at handoff.
- `pnpm check`: rerun at handoff, including ownership and dependency checks.
- `git diff --check`: rerun at handoff.

## Concerns

None. Existing pnpm configuration and image-element warnings may still be printed by repository
commands; they are unrelated to this change.
