# Review Approval Race Design

## Goal

Ensure a completed approval updates only the pull request submitted to the approval mutation, even when the user navigates to another review while the request is in flight.

## Root Cause

`useReviewActions` submits the selected pull request's repository and number as mutation variables, but its `onSuccess` callback reads `selectedKey` and `selectedDetails` from render state. TanStack Query updates mutation observer options on later renders, so navigating from PR A to PR B while A is pending can make A's completion run a callback whose closure points at B.

The callback then writes an approved copy of B into the component's `prDetails` map. Both the list and detail panel prefer that map, and the details query is disabled when an entry exists, so the incorrect state remains for the component's lifetime.

## Design

Use the successful mutation's `variables.repo` and `variables.number` to derive the approved PR key. Update `prDetails` with a functional state setter and look up the matching details from the setter's `prev` map. If the matching PR has no cached details, leave the map unchanged and allow the list invalidation to refresh server data.

This keeps mutation completion independent of whichever PR is currently selected and avoids relying on a potentially stale `prDetails` closure. The success toast and review-request list invalidation remain unchanged.

## Alternatives Considered

1. **Mutation variables plus functional state update (selected).** Uses the identity already carried by the request, reads the freshest local map, and requires no additional lifecycle state.
2. **Capture details in `onMutate` context.** Also preserves call-time identity, but duplicates data that is already in mutation variables and can overwrite fresher cached details with an older snapshot.
3. **Pass a per-call `onSuccess` to `mutate`.** Can capture the selected PR at invocation time, but spreads mutation behavior across the callback configuration and call site without improving the data contract.

## Scope

- Modify `src/client/routes/reviews.tsx`.
- Extend `src/client/routes/reviews.test.tsx` with a race regression.
- Do not change backend review submission, list invalidation, keyboard shortcuts, or general details caching.

## Edge Cases

- Navigating to another PR before approval resolves must not approve the newly selected PR locally.
- The originally submitted PR must be updated even when it is no longer selected.
- If the originally submitted PR has no cached details when approval resolves, the callback must not create an incomplete entry or alter another PR.
- The review-request list must still be invalidated after success.

## Verification

- Run the focused reviews route test and observe the new regression fail before implementation.
- Run the focused test after implementation and verify the submitted PR alone becomes approved.
- Run `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`.
- Review the complete diff against `origin/main`.
