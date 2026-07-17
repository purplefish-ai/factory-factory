# Ratchet PR-Scoped Dispatch Snapshots Design

## Goal

Dispatch a fixer when a workspace begins tracking a different pull request, even when the new pull request has the same CI, review, and merge-conflict state as the previous pull request.

## Root Cause

`fetchPRState` builds `PRStateInfo.snapshotKey` from CI state, latest external review activity, and merge-conflict state. `RatchetService.hasStateChangedSinceLastDispatch` compares that value directly with the persisted `Workspace.ratchetLastCiRunId`. Neither value identifies the pull request.

The dispatch record intentionally survives normal fixer completion so unchanged state on the same pull request remains deduplicated. That same persistence becomes incorrect when the workspace switches pull requests: two different pull requests can both produce values such as `ci:SUCCESS|no-changes-requested:none|merge:conflict`, so the new actionable pull request is treated as already handled.

## Considered Approaches

### Prefix the dispatch snapshot with the pull request number

Change `computeDispatchSnapshotKey` to accept `prNumber` and return `pr:<number>|<existing-state-key>`. `fetchPRState` already resolves the authoritative pull request number before computing the snapshot, so no extra persistence or database query is required.

This is the selected approach. It fixes same-state pull-request switches at the source while preserving same-pull-request deduplication, completed-dispatch suppression, and bounded retries for dispatches that died.

### Clear the snapshot on ratchet lifecycle transitions

Clearing `ratchetLastCiRunId` after completion or state transitions would cause duplicate dispatches for unchanged state on the same pull request. It would also miss a pull-request switch whose old and new pull requests remain in the same ratchet state, such as `MERGE_CONFLICT` to `MERGE_CONFLICT`.

### Persist and compare a separate last-dispatched pull request number

A separate field could make the comparison explicit, but it would require a Prisma schema migration and coordinated atomic writes for information that already belongs in the snapshot identity. It adds state without improving behavior.

## Design

`computeDispatchSnapshotKey` will take `prNumber` as its first required argument. It will retain the existing CI, review, and merge segments unchanged and prefix the result with `pr:<prNumber>|`.

`fetchPRState` will pass `prDetails.number`, the identity returned for the pull request fetched from GitHub. Unit-test callers will provide a stable pull request number. No stored snapshots need migration: an existing unprefixed key will compare different from the first new prefixed key, causing at most one appropriate re-evaluation; subsequent dispatches store the new format.

## Edge Cases

- The same pull request and the same actionable state still produce the same key and remain deduplicated.
- Different pull requests with identical successful CI, no review timestamp, and identical conflict state produce different keys.
- Failed-check signatures remain stable and sorted within a pull request.
- Existing legacy keys without a `pr:` prefix differ from newly computed keys and transition naturally without a database migration.
- Pull-request identity comes from `resolveRatchetPrContext`; if no number can be resolved, the existing fetch path returns no PR state and never computes a malformed key.

## Testing

1. Assert the exact snapshot format includes the pull request number.
2. Assert two pull requests with identical CI/review/conflict inputs produce different snapshots.
3. Exercise `processWorkspace` with a completed dispatch from one pull request and the same actionable state on another pull request, and assert a fixer is triggered.
4. Retain the existing tests proving unchanged same-pull-request state does not dispatch repeatedly.
5. Run targeted ratchet tests, type checking, formatting/guardrails, the full test suite, and the production build.

## Non-goals

- Clearing dispatch records on fixer completion or ratchet state transitions.
- Renaming the legacy `ratchetLastCiRunId` database column.
- Changing CI, review-activity, merge-conflict, retry, or state-machine semantics.
