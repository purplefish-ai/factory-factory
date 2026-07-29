# Preserve Periodic Task Monthly Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a periodic task's stored monthly day-of-month while its active cadence is non-monthly, so returning to `MONTHLY` restores the original schedule.

**Architecture:** Treat `scheduledDayOfMonth` as dormant monthly scheduling metadata rather than a projection of the active cadence. The periodic-task accessor will only derive and persist this field when the effective cadence is `MONTHLY`; non-monthly updates and enable operations will leave the database field untouched while continuing to compute their next run normally.

**Tech Stack:** TypeScript, Prisma, Vitest

## Global Constraints

- Keep `scheduledDayOfMonth` server-owned; do not add it to the tRPC update schema.
- Preserve the existing current-local-day fallback for tasks that have never stored a monthly anchor.
- Do not add schema, migration, service, or UI changes.
- Verify with `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`.

---

### Task 1: Preserve Dormant Monthly Scheduling Metadata

**Files:**
- Modify: `src/backend/services/periodic-task/resources/periodic-task.accessor.ts`
- Test: `src/backend/services/periodic-task/resources/periodic-task.accessor.test.ts`

**Interfaces:**
- Consumes: `periodicTaskAccessor.update(id, input)` and `periodicTaskAccessor.toggleEnabled(id, enabled)`
- Produces: Prisma update payloads that write `scheduledDayOfMonth` only for effective `MONTHLY` schedules

- [ ] **Step 1: Add the missing accessor mock and failing round-trip test**

Add `findUniqueOrThrow: vi.fn()` to `prismaMock.periodicTask`. Add an update test that starts with a `MONTHLY` task anchored to day 15, updates it to `DAILY`, verifies the payload omits `scheduledDayOfMonth`, then updates the resulting `DAILY` row back to `MONTHLY` on a later date and verifies both `scheduledDayOfMonth: 15` and a next run on day 15.

- [ ] **Step 2: Run the round-trip test and verify the destructive write**

Run:

```bash
pnpm test src/backend/services/periodic-task/resources/periodic-task.accessor.test.ts
```

Expected: the new assertion fails because the `MONTHLY` to `DAILY` payload contains `scheduledDayOfMonth: null`.

- [ ] **Step 3: Add failing edge-case coverage**

Add one test proving `toggleEnabled(id, true)` omits `scheduledDayOfMonth` for a non-monthly row that retains a dormant day 15 anchor. Add one test proving a non-monthly row with no stored anchor still derives the current local day when changed to `MONTHLY`.

- [ ] **Step 4: Implement the minimal accessor fix**

In `update`, retain `existing.scheduledDayOfMonth` for next-run calculation when the effective cadence is non-monthly, but conditionally add the field to the Prisma payload only when the effective cadence is `MONTHLY`. In `toggleEnabled`, resolve and persist the field only for `MONTHLY`; pass an existing dormant anchor through to `computeNextRunAt` for other cadences without writing it.

- [ ] **Step 5: Run focused tests and verify all accessor behaviors**

Run:

```bash
pnpm test src/backend/services/periodic-task/resources/periodic-task.accessor.test.ts
```

Expected: all accessor tests pass.

- [ ] **Step 6: Commit the focused bug fix**

```bash
git add docs/superpowers/plans/2026-07-29-preserve-periodic-task-monthly-anchor.md \
  src/backend/services/periodic-task/resources/periodic-task.accessor.ts \
  src/backend/services/periodic-task/resources/periodic-task.accessor.test.ts
git commit -m "Fix periodic task monthly anchor retention (#1915)"
```

### Task 2: Verify, Review, and Publish

**Files:**
- Review: all changes relative to `origin/main`
- Create: `/tmp/pr-body.md` outside the repository

**Interfaces:**
- Consumes: the committed Task 1 change
- Produces: a pushed issue branch and a GitHub pull request that closes #1915

- [ ] **Step 1: Run the required verification chain**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: all four commands exit successfully. Review and commit any formatting changes produced by `pnpm check:fix`.

- [ ] **Step 2: Review the complete branch diff**

```bash
git diff origin/main
git status --short
```

Confirm the diff contains only the plan, accessor behavior change, and focused tests, with no debug output or unrelated edits.

- [ ] **Step 3: Request read-only code review and address findings**

Ask a reviewer to compare the branch against #1915, including dormant-anchor preservation, new-monthly fallback behavior, and the non-monthly enable path. Re-run affected tests and commit any required fixes.

- [ ] **Step 4: Push and create the required pull request**

```bash
git push -u origin HEAD
gh pr create --title "Fix #1915: Preserve periodic task monthly anchors" --body-file /tmp/pr-body.md
gh pr view --json url
```

The PR body must summarize the accessor and test changes, list the required verification commands, include `Closes #1915`, and end with the Factory Factory signature.
