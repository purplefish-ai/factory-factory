# Phase 4: Ratchet Handoff

**Goal:** Make ratchet (auto-fix) work seamlessly across desktop and cloud.

## 4.1 Location-Aware Ratchet

Add a `location` field to the workspace model:

```typescript
enum WorkspaceLocation {
  DESKTOP
  CLOUD
}
```

**Desktop ratchet** filters by `location='DESKTOP'`. **Cloud ratchet** filters by `location='CLOUD'`. Both run the same FF Core ratchet logic — the only difference is the filter.

**State transfer on send/pull:**

| Field | Transferred | Purpose |
|-------|------------|---------|
| `ratchetEnabled` | Yes | User's toggle preference |
| `ratchetState` | Yes | Current PR state (IDLE/CI_FAILED/etc.) |
| `ratchetLastCiRunId` | Yes | Prevents duplicate fix dispatches |
| `prReviewLastCheckedAt` | Yes | Last review activity timestamp |
| `ratchetActiveSessionId` | No | Block send/pull if active |

**Handoff timing:** Cloud ratchet picks up a newly-sent workspace within 1 poll interval (currently 30 seconds). At most a brief gap — no duplicate checks, no missed events.

## Done when

Ratchet works seamlessly whether a workspace is on desktop or cloud — no duplicate fixes, no missed events during handoff.
