# Archive Workspace from PROVISIONING State

## Problem Statement

When a workspace gets stuck or encounters an error during `PROVISIONING`, users cannot archive it. The state machine (`state-machine.service.ts`) only permits `READY` and `FAILED` to transition to `ARCHIVING`:

```ts
PROVISIONING: ['READY', 'FAILED'],  // no ARCHIVING allowed
```

This causes `archiveWorkspace()` in `workspace-archive.orchestrator.ts` to throw:

```
Cannot archive workspace from status: PROVISIONING
```

There is a "stale PROVISIONING" recovery mechanism (10-minute threshold) that transitions stuck workspaces to `FAILED` on restart, but users cannot manually trigger cleanup mid-session. This is a problem when provisioning hangs or errors occur during workspace initialization.

## What Happens During Provisioning

The `initializeWorkspaceWorktree()` function runs several side-effectful operations in sequence:

1. Creates a git worktree
2. Loads `factory-factory.json` config
3. Creates a default terminal
4. Starts the agent session (fire-and-forget)
5. Executes startup script pipeline
6. Transitions to `READY` or `FAILED`

If a user archives mid-provisioning, these may be partially complete -- some resources may exist, some may not.

## Potential Solutions

### Option A: Add `PROVISIONING -> ARCHIVING` to the state machine

Add the transition directly. The archive orchestrator already handles missing resources gracefully (it stops sessions, terminals, run scripts, cleans up worktree). The main risk is a race condition: the provisioning process continues running concurrently and may re-transition to `READY` or `FAILED` after archive starts.

**Pros:** Minimal code change, reuses existing archive logic
**Cons:** Race condition between provisioning coroutine and archive; provisioning could undo partial cleanup or cause double-transitions

### Option B: Force-transition to `FAILED` first, then archive

When archive is requested from `PROVISIONING`, first force the workspace to `FAILED` (canceling/ignoring the in-progress provisioning), then run the normal archive flow. This respects the existing state machine.

**Pros:** Clean separation of concerns, no new state transitions needed, existing archive path handles everything
**Cons:** Requires a mechanism to signal the provisioning process to abort; if provisioning is fire-and-forget, it may still complete and fight the FAILED state

### Option C: New `FORCE_ARCHIVE` escape hatch

Add a separate `forceArchiveWorkspace()` that bypasses state validation entirely, runs full cleanup, and marks `ARCHIVED`. Only exposed via a separate "Force Archive" UI action.

**Pros:** Doesn't touch the state machine; explicit user intent
**Cons:** Code duplication, harder to maintain, bypassing the state machine could hide bugs

### Option D: Extend `ARCHIVING` rollback to include `PROVISIONING`

The current rollback in `archiveWorkspace()` records the pre-archive status to roll back to on failure. Allow `ARCHIVING` to record `PROVISIONING` as its source, and add `ARCHIVING -> PROVISIONING` as a valid rollback transition.

**Pros:** Most state-machine-correct
**Cons:** Complex; provisioning state is not safely resumable after partial archive cleanup

## Chosen Solution: Hybrid of A and B

We chose a hybrid approach that adds `PROVISIONING -> ARCHIVING` as a valid state transition (Option A) while also addressing the race condition with the provisioning coroutine (the key concern from Option B).

### Key Design Decisions

1. **Direct `PROVISIONING -> ARCHIVING` transition**: The state machine now allows archiving directly from `PROVISIONING`, keeping the user-facing behavior simple (normal "Archive" button works).

2. **Atomic CAS-based `markFailedIfProvisioning`**: A new state machine method uses compare-and-swap to transition `PROVISIONING -> FAILED` only if the workspace is still in `PROVISIONING` state. The init orchestrator's failure handler uses this instead of `markFailed`, so if archive has already moved the workspace to `ARCHIVING`, the provisioning coroutine stands down rather than fighting the archive.

3. **Rollback to `FAILED` on archive failure**: If archive was triggered from `PROVISIONING` and the archive itself fails, the workspace rolls back to `FAILED` (not `PROVISIONING`), since provisioning cannot be safely resumed after partial cleanup.

4. **Best-effort cleanup**: The archive process cleans up whatever resources exist (sessions, terminals, run scripts, worktree) and silently handles missing ones. This is acceptable since archiving from `PROVISIONING` is a rare recovery path.

### Race Condition Analysis

The critical race is between the archive request and the in-flight provisioning coroutine:

1. Archive atomically transitions `PROVISIONING -> ARCHIVING` via CAS
2. Provisioning coroutine tries `markReady` -- reads `ARCHIVING`, `ARCHIVING -> READY` is invalid, throws
3. Provisioning catch block calls `markFailedIfProvisioning` -- CAS against `PROVISIONING` fails (status is `ARCHIVING`), returns `false`
4. Provisioning stands down, archive completes cleanup

This eliminates the window where the provisioning coroutine could revert an in-progress archive by calling `markFailed` on an `ARCHIVING` workspace (since `ARCHIVING -> FAILED` is a valid rollback transition).

### Files Changed

- `state-machine.service.ts`: Added `ARCHIVING` to `PROVISIONING` valid transitions, expanded `ArchivingSourceStatus` type, added `markFailedIfProvisioning()` method
- `workspace-archive.orchestrator.ts`: Updated rollback to use `FAILED` when source was `PROVISIONING`
- `workspace-init.orchestrator.ts`: `handleWorkspaceInitFailure` uses `markFailedIfProvisioning` with early return on `false`
