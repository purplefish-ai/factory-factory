# Diff scroll ownership implementation plan

> Execute inline using the approved design and test-driven development.

**Goal:** Fix #2297 by giving diff restoration, cancellation, and persistence
one lifecycle owner.

**Architecture:** `useDiffScroll` creates the virtualizer and connects a
`DiffScrollController` to DOM events. The controller owns the intended anchor,
its animation frames, interrupted restoration, and programmatic write tracking.
Restoration uses measured or estimated row offsets and writes directly through
the controller, without starting TanStack's independent reconciliation loop.
TanStack's `scrollToFn` routes measurement adjustments through the same owner.

**Constraints:** Keep the existing scroll storage shape and small-diff behavior.
Use public virtualizer integration points; do not mutate its private state. Use
Node >=26.8.1 and pnpm. Keep this change within the workspace diff feature.

## Implementation

- [x] Add a regression to `diff-lines.test.tsx`: deliver a click between the
      first offscreen restore write and its queued scroll event. After settling,
      assert no saved state was emitted; then scroll to 150 and assert it
      persists. Run
      `pnpm test src/client/features/workspace/diff-lines.test.tsx` and verify
      the regression fails with the original implementation.
- [x] Extract measurement and pixel-migration helpers into
      `diff-scroll-position.ts`. Return target coordinates instead of invoking
      `scrollToIndex`, so migration cannot start a second retry loop.
- [x] Create `diff-scroll-controller.ts` with `restore`, `interrupt`, `persist`,
      `scrollTo`, and `dispose` operations. Keep interrupted targets until
      actual viewport movement; ignore queued programmatic writes. Commit
      restoration only after a measured target settles. Preserve the target when
      hidden or when the retry budget expires.
- [x] Move `useVirtualizer` setup into `use-diff-scroll.ts`; connect its
      `scrollToFn` to the controller. Return the virtualizer, virtualization
      flag, and measurement version to `diff-lines.tsx`. Keep React/DOM wiring
      in the hook and the lifecycle in the controller.
- [x] Expand real-virtualizer regressions for delayed scroll events, repeated
      clicks, wheel/touch/keyboard/scrollbar takeover, legacy migration,
      horizontal scrolling, resize during interruption, remount, and teardown.
- [x] Add an interrupted-restoration Storybook fixture and update
      `docs/architecture/diff-rendering.md` with the lifecycle and manual
      checks.
- [x] Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, and `pnpm check`.
      Inspect the final diff and request independent review. Commit and open one
      PR closing #2297 after resolving any findings.
