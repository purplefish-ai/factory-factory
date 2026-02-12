# Phase 5: Ratchet Handoff

**Goal:** Make ratchet (auto-fix) work seamlessly across desktop and cloud.

## 5.1 Location-Aware Ratchet

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

## How to test manually

1. **Ratchet on desktop (baseline):**
   Create a workspace with a PR and enable ratchet. Push a commit that breaks CI. Verify:
   - Desktop ratchet detects the failure within ~30 seconds
   - A fixer session is dispatched and attempts to fix the CI failure

2. **Send to cloud with ratchet enabled:**
   Send that workspace to cloud. Verify:
   - `location` changes to `CLOUD`
   - Desktop ratchet stops checking this workspace (no duplicate dispatch)
   - Cloud ratchet picks it up within 1 poll interval (~30 seconds)

3. **Trigger a CI failure while on cloud:**
   Push a commit that breaks CI on the cloud workspace. Verify:
   - Cloud ratchet detects the failure and dispatches a fixer
   - Desktop does not also dispatch a fixer (no duplicate)

4. **Pull back to desktop:**
   Pull the workspace back to desktop. Verify:
   - `location` changes to `DESKTOP`
   - Desktop ratchet resumes checking
   - Cloud ratchet stops checking
   - Ratchet state (`ratchetState`, `ratchetLastCiRunId`, `prReviewLastCheckedAt`) is preserved — no re-processing of already-handled events

5. **Active session blocks handoff:**
   Start a fixer session on a workspace. Try to send it to cloud. Verify:
   - The send is blocked with a clear error ("Fixer session active — wait or stop it first")

## Done when

Ratchet works seamlessly whether a workspace is on desktop or cloud — no duplicate fixes, no missed events during handoff. The Cloud MVP is shippable.
