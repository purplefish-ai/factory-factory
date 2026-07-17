# Auto-Iteration Loop Cleanup Race Design

## Problem

`AutoIterationService` stores one `RunningLoop` per workspace. Several asynchronous cleanup paths delete the map entry using only `workspaceId`. If an old loop is removed and a replacement is registered while the old cleanup is awaiting or before its rejection handler runs, the old cleanup deletes the replacement and makes it unreachable through the service API.

## Chosen design

Add one private ownership-aware helper to `AutoIterationService`:

```typescript
private deleteLoopIfCurrent(loop: RunningLoop): void {
  if (this.loops.get(loop.workspaceId) === loop) {
    this.loops.delete(loop.workspaceId);
  }
}
```

Use the helper in every asynchronous cleanup path that currently deletes by workspace key: the setup and `runLoop()` rejection paths for `start()`, `resume()`, and `resumeFromFailed()`, plus `finalize()`. Keep `onSessionDeath()` unchanged because it already checks the current loop's session identity and performs its delete synchronously without an intervening await.

Object identity is the ownership boundary. Session identity is not suitable for the shared helper because a running loop can recycle and mutate its session ID.

## Alternatives considered

- Inline `Map.get(...) === loop` checks at every call site would work but duplicate the lifecycle invariant.
- Generation tokens per workspace would also work, but add state when `RunningLoop` object identity already supplies a unique generation.

## Testing

Add deterministic service regressions that:

1. Start a resumed loop with a deferred `runLoop()` rejection, remove it through `onSessionDeath()`, register a replacement, then reject the old promise and verify the replacement remains registered.
2. Block an old loop in `finalize()`, replace the map entry while cleanup is awaiting, then release finalization and verify the replacement remains registered.

These cover the two stale-cleanup mechanisms from the issue: delayed promise rejection and delayed awaited finalization. Existing service tests continue to cover normal resume behavior.

## Scope and edge cases

- Guard all six currently unguarded delete sites so setup failures cannot cause the same race.
- Preserve deletion when the loop being cleaned up is still the current map value.
- Do not change status/session persistence semantics in this patch; the reported defect and acceptance criterion concern ownership of the in-memory loop registration.
- No UI behavior changes, migrations, or screenshots are required.
