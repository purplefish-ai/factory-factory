# Ratchet Merged-PR Session Cleanup Design

## Problem

A normal Ratchet poll can observe that a pull request was merged while a
Ratchet fixer session is still running. The current merged-PR decision returns
`COMPLETED` and transitions the workspace to `MERGED`, but active fixer
inspection only runs for open pull requests. As a result, the session can
continue after the pull request is merged.

Once the workspace Ratchet state is `MERGED`, it leaves the normal poll set.
Cleanup therefore must finish before the terminal state is persisted, or a
failed cleanup would not be retried.

## Behavior

When a normal workspace check fetches a fresh pull-request state of `MERGED`,
Ratchet will:

1. Find all sessions for the workspace.
2. Select sessions whose workflow is `ratchet`, whose persisted status is
   `RUNNING` or `IDLE`, and whose runtime is still running.
3. Stop every selected session.
4. Continue through the existing merged-PR decision and persist the workspace
   Ratchet state as `MERGED` only after all selected sessions stop successfully.

Sessions from other workflows are not stopped. Ratchet sessions that are
already stopped are ignored.

If any stop fails, the workspace check returns its existing `ERROR` result and
does not transition the Ratchet state to `MERGED`. The workspace remains in the
normal poll set, so the next poll retries cleanup.

## Implementation Boundary

The cleanup belongs in the Ratchet service capsule, after the fresh PR state is
available and before the decision context is built. It uses the existing
`RatchetSessionBridge` methods and does not introduce cross-capsule imports,
schema changes, or UI changes.

The existing Ratchet-disable cleanup remains best effort because disabled
workspaces cannot be retried by the poller. The merged-PR cleanup has stricter
failure propagation because persisting `MERGED` would otherwise remove the
workspace from future polls.

## Concurrency and Outcomes

The session runtime can exit between enumeration and stop. Existing session
lifecycle behavior treats deliberate stops and clean exits as `COMPLETED`, and
the conditional dispatch settlement prevents stale exit paths from overwriting
an already-recorded outcome.

The workspace check coordinator continues to serialize checks per workspace.
Abort signals are checked around session enumeration and stop operations so a
timed-out check does not proceed to the terminal state transition.

## Tests

Regression tests will exercise the normal workspace-check path and verify:

- a freshly merged pull request stops every live Ratchet workflow session;
- manual or other-workflow sessions are preserved;
- already-stopped Ratchet sessions are ignored;
- the workspace transitions to `MERGED` only after cleanup succeeds; and
- a stop failure returns `ERROR` without persisting `MERGED`, leaving the next
  normal poll able to retry.
