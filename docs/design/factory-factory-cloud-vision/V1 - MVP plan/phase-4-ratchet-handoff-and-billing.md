# Phase 4: Ratchet Handoff + Billing

**Goal:** Make ratchet (auto-fix) work seamlessly across desktop and cloud, and add billing so the product can ship.

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

## 4.2 Billing

- **Usage tracking:** Compute minutes per workspace, API call counts
- **Subscription tiers:** Free (limited), Pro (standard limits), Team (higher limits + team features later)
- **Quota enforcement:** Check quota before provisioning containers. Reject with clear error if exceeded.
- **Payment integration:** Stripe for subscriptions and metered billing
- **Usage dashboard:** Users can see their usage and billing status in the web app

## Done when

Ratchet works seamlessly whether a workspace is on desktop or cloud — no duplicate fixes, no missed events during handoff. Users can sign up, choose a plan, pay, and use the product within their plan limits. The Cloud MVP is shippable.
