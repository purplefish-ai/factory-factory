# Final Invalidation Fixes Report

## Status

Complete on `feature/kanban-next-action-ownership`.

Commit: `Preserve concurrent ownership invalidations` (the commit containing this report).

## Changes

- Direct CI dispatch-reset invalidations now emit immediately after the database commit and before
  the independent cached-column refresh, while preserving cache-refresh rejection semantics.
- Authoritative Ratchet projection requests use monotonically increasing revisions. An
  invalidation arriving during a third failed read receives a fresh bounded retry budget; an
  unchanged request still stops after three failures.
- Projection and cached-column retry paths recheck teardown generation/activity after pending
  reads reject and before creating retry timers, preventing orphan timers after stop/reconfigure.

## TDD evidence

The initial focused run failed exactly three new regressions: cache rejection suppressed a direct
CI invalidation, a third-read concurrent invalidation was lost, and cache reconfiguration during a
pending read created a retry timer that caused the test to time out.

The focused GitHub snapshot, event collector, and Kanban cache suites pass with 99 tests.

## Verification

- Focused relevant suites: passed.
- `pnpm typecheck`, `pnpm check:fix`, and `pnpm check`: run at handoff.
- No schema changes, push, or PR.

## Concerns

None.
