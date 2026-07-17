# Concurrency Review Fixes Report

## Status

Complete on `feature/kanban-next-action-ownership`.

Commit: `Fix Ratchet projection ordering` (the commit containing this report).

## Root causes and fixes

- Ratchet ownership events carried mutation-time values and the live snapshot applied them in
  callback order. A delayed older callback could therefore overwrite a newer database commit.
  Dispatch and toggle events are now invalidations. PR reset events carry an invalidation flag.
  The event collector serializes and coalesces an authoritative database projection per workspace,
  with a dirty rerun when another invalidation arrives during a read. Fresh `prCiStatus` continues
  to publish directly on Ratchet state events.
- Durable cached-column refreshes previously ran read/derive/write operations concurrently. They
  are now serialized per workspace, including the complete operation, so writes preserve request
  order.
- PR aggregate reset persistence previously decided from a transaction read and then wrote the
  reset unconditionally. It now compares the dispatch pointer, snapshot key, outcome, and retry
  count before resetting. If a newer dispatch wins, the PR aggregate is still persisted without
  changing Ratchet ownership.

No schema migration was required.

## TDD evidence

RED command:

```text
pnpm vitest run \
  src/backend/orchestration/event-collector.orchestrator.test.ts \
  src/backend/services/workspace/service/state/kanban-state.test.ts \
  src/backend/services/workspace/resources/workspace.accessor.test.ts
```

Result before production changes: 5 expected failures. All three deferred live-event
interleavings lacked an authoritative reread, the slower old cache read wrote `WORKING` last, and
the PR reset returned true instead of preserving the concurrent `RUNNING` dispatch.

GREEN focused command:

```text
pnpm vitest run \
  src/backend/orchestration/event-collector.orchestrator.test.ts \
  src/backend/orchestration/event-coalescer.integration.test.ts \
  src/backend/services/github/service/pr-snapshot.service.test.ts \
  src/backend/services/ratchet/service/ratchet.service.test.ts \
  src/backend/services/workspace/resources/workspace.accessor.test.ts \
  src/backend/services/workspace/service/state/kanban-state.test.ts \
  src/backend/services/resources.integration.test.ts \
  src/backend/services/check-single-writer.test.ts
```

Result: exit 0; 8 test files passed; 261 tests passed.

## Guardrails

- `pnpm check:fix`: exit 0; only six existing `<img>` performance warnings.
- `pnpm check`: exit 0; Biome, environment, ownership, dependency, and schema checks passed;
  only the same six existing warnings were reported.
- `pnpm typecheck`: exit 0, including the core package build.
- `git diff --check`: exit 0.

## Files

- `src/backend/orchestration/event-collector.orchestrator.ts` and test
- `src/backend/services/github/service/pr-snapshot.service.ts` and test
- Ratchet service event contracts/helpers and tests
- `src/backend/services/workspace/resources/workspace.accessor.ts` and test
- `src/backend/services/workspace/service/state/kanban-state.ts` and test
- `docs/workspaces.md`

## Concerns

None. The verification commands emitted the repository's existing pnpm configuration warning,
and the single-writer test prints its temporary fixture branch switch; both commands exited
successfully and the working branch remained unchanged.
