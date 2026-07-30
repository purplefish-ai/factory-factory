# Review Approval Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a successful review approval update only the pull request identified by the mutation variables, regardless of navigation during the request.

**Architecture:** Keep the fix inside the existing `useReviewActions` hook. Derive the cache key from the successful mutation's variables, then use a functional `setPrDetails` update so the callback reads the freshest map entry for that key instead of render-time selection state.

**Tech Stack:** React 19, tRPC, TanStack Query, TypeScript, Vitest 4, jsdom

## Global Constraints

- Preserve the existing approval request payload, success toast, error toast, and review-list invalidation.
- Never use the current selection to identify the PR whose mutation completed.
- Do not create a details-map entry when the submitted PR has no cached details.
- Keep the change limited to the reviews route and its focused test.

## File Map

- Modify `src/client/routes/reviews.test.tsx` to reproduce approval of PR A, navigation to PR B, and completion through the latest mutation observer callback.
- Modify `src/client/routes/reviews.tsx` to target the submitted PR from mutation variables and update its latest cached details.

---

### Task 1: Bind approval completion to mutation variables

**Files:**
- Modify: `src/client/routes/reviews.test.tsx`
- Modify: `src/client/routes/reviews.tsx:347-382`

**Interfaces:**
- Consumes: `submitReview` mutation variables `{ repo: string; number: number; action: 'approve' }` and the current `Map<string, PRWithFullDetails>`.
- Produces: an approval success callback that updates `${repo}#${number}` only when that key already exists in the details map.

- [ ] **Step 1: Extend the tRPC and component doubles to expose real route behavior**

Update the reviews test doubles so:

- `getPRDetails.useQuery(input)` returns complete details for the requested PR.
- `submitReview.useMutation(options)` retains the latest observer options while `mutate(input)` retains the submitted variables.
- `PRInboxItem` renders the PR title and review decision and keeps its real selection callback.
- `PRDetailPanel` renders the selected PR decision and an approval button wired to `onApprove`.

- [ ] **Step 2: Write the failing race regression**

Add a test that:

1. Renders PR A and PR B with no initial review decision.
2. Approves PR A.
3. Selects PR B before the mutation completes.
4. Completes the pending request by calling the latest observer's `onSuccess` with PR A's saved variables.
5. Expects PR A to render `APPROVED`, PR B to remain unapproved, and the selected detail panel for PR B to remain unapproved.

- [ ] **Step 3: Run the focused test and verify the current callback fails**

Run:

```bash
pnpm test -- src/client/routes/reviews.test.tsx
```

Expected: the new regression fails because the existing callback approves PR B from the latest render closure.

- [ ] **Step 4: Implement the variables-based functional update**

Change the mutation success callback to:

```typescript
onSuccess: (_data, variables) => {
  toast.success('PR approved successfully');
  utils.prReview.listReviewRequests.invalidate();

  const approvedKey = `${variables.repo}#${variables.number}`;
  setPrDetails((prev) => {
    const approvedDetails = prev.get(approvedKey);
    if (!approvedDetails) {
      return prev;
    }
    return new Map(prev).set(approvedKey, {
      ...approvedDetails,
      reviewDecision: 'APPROVED',
    });
  });
},
```

Remove `selectedDetails` from the `useReviewActions` parameter type and call because the action hook no longer needs render-time details for approval completion. Keep `selectedKey` for diff fetching.

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
pnpm test -- src/client/routes/reviews.test.tsx
```

Expected: all reviews route tests pass, including the navigation race regression.

- [ ] **Step 6: Format and commit the focused fix**

Run:

```bash
pnpm exec biome check --write src/client/routes/reviews.tsx src/client/routes/reviews.test.tsx
pnpm test -- src/client/routes/reviews.test.tsx
git add src/client/routes/reviews.tsx src/client/routes/reviews.test.tsx
git commit -m "Fix review approval navigation race (#2099)"
```

- [ ] **Step 7: Run full verification and review**

Run:

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
git diff origin/main
git status --short
```

Expected: every command exits with code 0, the diff contains only the approved design, plan, route fix, focused regression, and any applicable screenshot, and the worktree is clean after final commits.

- [ ] **Step 8: Publish the pull request**

Push the current branch, create a pull request titled `Fix #2099: Prevent cross-PR approval updates`, include the required summary, testing checklist, `Closes #2099`, and Factory Factory signature, then verify and report the PR URL.
