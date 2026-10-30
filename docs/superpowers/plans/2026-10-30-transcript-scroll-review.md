# Transcript scroll plan review

The user requested a plan followed by independent subagent critique, repeated
until convergence. This record covers planning review, not implementation or
proof that the proposed behavior is already shipped.

Documents reviewed:

- [Design](../specs/2026-10-30-transcript-scroll-design.md)
- [Implementation plan](./2026-10-30-transcript-scroll.md)

## Round 1

Three independent reviewers inspected the documents and relevant repository
source. They reviewed engine/browser behavior, lifecycle/storage integration,
and implementability/verification. Engine and implementation reviewers requested
revision; lifecycle review reported no HIGH concerns with two MEDIUM
corrections.

### HIGH concerns and revisions

1. Native end anchoring still applies its own geometry-based follow policy even
   when `followOnAppend` is disabled. Revised to always use native start
   anchoring with append-follow disabled; only the controller requests end
   positioning. Structural reading changes use a committed live keyed anchor.
   This uses documented public configuration rather than a negative-threshold
   sentinel or private engine state.
2. The controller API could not cancel on stationary touch without detaching
   intent, and streaming could immediately requeue a correction. Added explicit
   begin/end interaction inhibition, retained intent/restore targets, and
   movement-specific takeover tests.
3. Native cancellation does not clear every anchor/compensation/write record.
   Clarified that end/restore commands are cancelled while legitimate native
   anchor compensation remains allowed. Added a public `scrollToFn`
   write/read-back ledger, identity/input generations, and geometry-clamping
   classification.
4. The engine's default resize predicate skips some above-viewport corrections
   after backward scrolling. Added an explicit fully-above-row predicate and
   real-engine tests for late resizing and partially visible large groups.

### MEDIUM concerns and revisions

1. Restore commands could continually replace index and offset targets, and a
   native command could outlive the app retry budget. Added staged mounting,
   measurement, offset refinement, and native cancellation on stall.
2. Runtime phase can stop loading before hydration completes. Readiness now uses
   the existing `runtimeSessionId` matched to the selected session, plus
   reactive workspace storage identity for main chat, with explicit early-event
   tests.
3. Session-close callbacks could recreate deleted records before React cleanup.
   Clear now revokes the persistence generation before deletion, including quick
   chat map entries; stale callbacks are covered by tests.
4. Delivery omitted existing composer/jump reachability browser coverage. Added
   `playwright.chat.config.ts` execution and migration of its story/locators
   while preserving the existing attachment, prompt and hit-testing assertions.

Additional decisions from self-review: invalidation responds to actual geometry
or key changes rather than scroll-only notifications; already-pinned updates do
not create redundant commands; committed persistence snapshots are deduplicated;
quick-chat state lives above sheet-content unmount; live structural corrections
cannot restart from a persisted activation target.

## Round 2

All three reviewers reported no remaining HIGH concerns. They identified four
MEDIUM details, all incorporated before the final review:

1. A wheel/key at a boundary may emit no scroll event. Start/refresh interaction
   timeout from input itself as well as scroll activity, with a no-scroll
   boundary regression followed by appended output.
2. A first valid measurement can equal its estimate and produce no size-change
   notification. Track measurement validity by key/node/layout generation and
   notify pending restoration separately from follow-layout invalidation.
3. Virtual size can advance before React commits the sizer. Retain the dirty
   generation until committed DOM geometry is evaluated; test an initially
   zero-gap stale DOM with a delayed sizer commit.
4. Closing an inactive tab must not clear the selected session. Use
   `clearSession(sessionId)` with per-target generation revocation, and test
   closing B while A stays selected plus a late B callback.

Two LOW editorial findings were fixed: an obsolete footer rationale based on
native append detection, and accidental blockquote formatting in Task 2.

## Round 3 — converged

Each reviewer re-read the final dispositions and relevant revised contracts:

- Engine/browser reviewer: **CONVERGED; no remaining HIGH or MEDIUM findings.**
- Lifecycle/storage reviewer: **CONVERGED; no remaining HIGH or MEDIUM
  findings.**
- Implementation/verification reviewer: **CONVERGED; no remaining HIGH or MEDIUM
  findings.**

The selected approach now uses native start anchoring, controller-owned follow
intent, native measured positioning, explicit live structural anchors, staged
restoration, and generation-scoped input/persistence handling. The
implementation begins by proving the installed engine contracts in a real
browser. Review convergence establishes plan readiness; it does not establish
runtime correctness.

This record captures the planning-review snapshot. The companion plan records
the subsequent implementation and verification in the current revision.
